package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.TailcatTransport
import com.slopus.happy.connection.Transport
import com.slopus.happy.conversation.UnsentWork
import com.slopus.happy.data.DiskThread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.random.Random

/** How an agent connection's live link stands, as its home and chats show it. */
enum class AgentLinkStatus { Connecting, Connected, Offline, Revoked, UpdateRequired }

/**
 * One agent connection while the phone talks to it (iOS's DirectSyncEngine):
 * its [client]; the catalog home draws, from `GET /v0/bootstrap/desktop` and
 * then the journal; the journal itself as [events] for the open chat; and
 * [status]. The live link runs while [active] is true (the connection is
 * open and the app in the foreground): health and identity, the snapshot
 * unless the catalog already has a cursor, then `/v0/events/stream` from
 * the cursor, reconnecting with socket.io's backoff (1 to 5 s, jitter 0.5)
 * and resuming from the last cursor. A `hello` with `gap` reads the
 * snapshot again. The catalog is kept in [cacheFile] and read off the main
 * thread as the session starts, so home shows from disk, offline too, and
 * the next start resumes the journal where this one left it.
 */
class AgentSession internal constructor(
    val connectionId: String,
    private val connections: AgentConnections,
    private val cacheFile: File?,
    active: Flow<Boolean>,
    parent: CoroutineScope,
    makeTransport: (com.slopus.happy.connection.AgentConnectionCredentials) -> Transport = { TailcatTransport(it.address, it.port) },
    private val random: Random = Random.Default,
) {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]) + Dispatchers.IO)
    private val linkLock = Mutex()
    private val snapshotQueued = AtomicBoolean(false)
    // Asks for the settings changed here to be sent; one ask covers every change made meanwhile.
    private val settingsQueued = Channel<Unit>(Channel.CONFLATED)
    private var link: AgentClient.Link? = null
    private val token = MutableStateFlow<String?>(null)

    val client: AgentClient = AgentClient.lazy {
        linkLock.withLock {
            link ?: run {
                val credentials = connections.credentials(connectionId) ?: throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
                AgentClient.Link(makeTransport(credentials), credentials.deviceToken).also { link = it }
            }
        }
    }

    // Empty until the kept catalog is read off the main thread (init), then live.
    private val catalogState = MutableStateFlow(AgentCatalog())
    private val catalogLock = Mutex()

    /** Everything home is drawn from; current to [AgentCatalog.cursor]. */
    val catalog: StateFlow<AgentCatalog> = catalogState.asStateFlow()

    private val statusState = MutableStateFlow(AgentLinkStatus.Connecting)
    val status: StateFlow<AgentLinkStatus> = statusState.asStateFlow()

    private val reads = MutableStateFlow(0)
    /** Bootstrap or a resource whose event version chain broke is being caught up. */
    val isSyncing: StateFlow<Boolean> = reads.map { it > 0 }
        .stateIn(scope, SharingStarted.Eagerly, false)

    private val eventFlow = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 1024)

    /**
     * The journal as it arrives, after the catalog has taken it in. Every
     * connect starts with a `hello`: a reader catches up what it shows.
     */
    val events: SharedFlow<AgentEvent> = eventFlow.asSharedFlow()

    /** The Surfaces being left, each with the agent's answer on its way ([leaveSurface]). */
    private val leaving = MutableStateFlow<Map<String, Deferred<String?>>>(emptyMap())

    /** Home's rows, derived off the main thread; equal rows keep their instances. */
    val feed: StateFlow<AgentFeed> = combine(catalogState, leaving) { catalog, leaving -> AgentFeed.derive(catalog, leaving.keys) }
        .distinctUntilChanged()
        .scan(null as AgentFeed?) { previous, next -> AgentFeed.reuse(previous, next) }
        // The seed is no feed: never shown, so a cached home never blinks empty.
        .filterNotNull()
        .distinctUntilChanged { a, b -> a === b }
        .flowOn(Dispatchers.Default)
        .stateIn(scope, SharingStarted.Eagerly, AgentFeed.derive(catalogState.value))

    /**
     * Desktop's Hide projects for this person, live: an edit on the desktop
     * comes with `user_settings.updated`, one made here shows at once.
     */
    val projectsHidden: StateFlow<Boolean> = catalogState
        .map { it.projectsHidden }
        .distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, catalogState.value.projectsHidden)

    /** Hides or shows the projects, on home here and on the desktop. */
    fun setProjectsHidden(hidden: Boolean) {
        scope.launch { setSetting(DesktopSettings.PROJECTS_VISIBILITY, DesktopSettings.projectsVisibility(hidden)) }
    }

    /**
     * Sets one of the person's user settings (API.md, `PUT /v0/user-settings/:key`):
     * shown at once, kept on this phone first, then sent with the time the
     * person made it, so a change made offline goes when the link is back
     * and never overwrites a later one from another device.
     */
    suspend fun setSetting(key: String, value: JsonElement) {
        catalogLock.withLock {
            catalogState.update { it.withPendingSetting(key, value, AgentClient.newId(), System.currentTimeMillis()) }
        }
        withContext(Dispatchers.IO) { writeCache(catalogState.value) }
        settingsQueued.trySend(Unit)
    }

    /** The person's own profile on this agent, as Settings' Profile row and page show it. */
    val profile: AgentProfileSource by lazy { AgentProfileSource(client, events, scope) }

    /** Bots' pictures, as home's rows draw them. */
    val pictures = AgentPictures(connectionId, cacheFile?.let { File(it.parentFile, it.nameWithoutExtension + ".pictures") }) { path -> client.send("GET", path).body }

    /** One conversation as the catalog knows it, live; null while unknown. */
    fun agent(agentId: String): Flow<WireAgent?> = catalogState
        .map { it.agents[agentId] }
        .distinctUntilChanged()
        .map { it?.let(AgentCatalog::decodeAgent) }

    /** A conversation the chat read on its own (bootstrap, a send's answer): home sees it at once. */
    fun upsertAgent(agent: WireAgent) {
        val element = AgentClient.json.encodeToJsonElement(WireAgent.serializer(), agent) as JsonObject
        catalogState.update { it.withAgent(element) }
    }

    /** A task as `POST /v0/tasks` answered (`task`, and its `membership`): home lists it before `task.created` comes. */
    fun upsertTask(task: JsonObject, membership: JsonObject? = null) {
        catalogState.update { it.withTask(task, membership) }
    }

    /**
     * Leaves a Surface (`POST /v0/surfaces/:id/leave`), as iOS's
     * `leave(surfaceId:)`: its row goes from home at once and comes back if
     * the agent refuses. It takes the Surface out of the person's own list;
     * its content stays for everyone in it. A second ask while one is on its
     * way sends nothing and shares its answer. Gone already on the agent
     * (404) counts as left. Null once left; otherwise the agent's own words
     * for the refusal, empty where it gave none (the screen says it in its
     * own). The request runs in the session, so leaving the screen doesn't
     * cancel it.
     */
    suspend fun leaveSurface(surfaceId: String): String? {
        val answer = CompletableDeferred<String?>()
        val pending = leaving.updateAndGet { if (surfaceId in it) it else it + (surfaceId to answer) }.getValue(surfaceId)
        if (pending !== answer) return pending.await()
        scope.launch {
            val refusal = try {
                client.send("POST", "/v0/surfaces/${AgentClient.escape(surfaceId)}/leave", buildJsonObject { put("mutationId", AgentClient.newId()) })
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentApiException) {
                if (e.status == 404) null else e.message.orEmpty()
            } catch (_: Exception) {
                ""
            }
            if (refusal == null) catalogLock.withLock { catalogState.update { it.withoutSurface(surfaceId) } }
            leaving.update { it - surfaceId }
            answer.complete(refusal)
        }.invokeOnCompletion { cause -> if (cause != null) answer.complete("") }
        return answer.await()
    }

    /** A bot as `POST /v0/bots` answered: home lists it before `bot.created` comes. */
    fun upsertBot(bot: JsonObject) {
        catalogState.update { it.withResource("bot", bot) }
    }

    /**
     * New work compose opened and left before its first message (iOS
     * Store's `unsent`): compose again opens the same one, with its kind,
     * name and words. In memory only, like a draft nothing exists for yet.
     */
    @Volatile var unsentWork: UnsentWork? = null

    init {
        scope.launch {
            // The kept catalog first: home draws it, and the link resumes from its cursor.
            readCache()?.let { cached -> catalogLock.withLock { catalogState.update { if (it.loaded) it else cached } } }
            active.distinctUntilChanged().collectLatest { on -> if (on) live() }
        }
        scope.launch {
            settingsQueued.receiveAsFlow().collect { deliverSettings() }
        }
        if (cacheFile != null) {
            @OptIn(FlowPreview::class)
            scope.launch {
                catalogState.drop(1).filter { it.loaded }.debounce(1_000).collect { writeCache(it) }
            }
        }
    }

    /** Stops the link and lets go of the tunnel. */
    suspend fun close() {
        scope.cancel()
        withContext(kotlinx.coroutines.NonCancellable) {
            linkLock.withLock { link?.transport?.close(); link = null }
        }
    }

    private suspend fun live() {
        var backoff = INITIAL_BACKOFF
        // A catalog with a cursor (kept, or read before the app went behind) resumes the journal from
        // there; only a gap or a refused cursor reads the whole snapshot again.
        var snapshotRead = catalogState.value.let { it.loaded && it.cursor != null }
        while (true) {
            if (statusState.value != AgentLinkStatus.Connected) statusState.value = AgentLinkStatus.Connecting
            try {
                refreshIdentity()
                if (!snapshotRead) {
                    readSnapshot()
                    snapshotRead = true
                }
                follow { backoff = INITIAL_BACKOFF }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentConnectionException) {
                when (e.reason) {
                    AgentConnectionException.Reason.Revoked -> {
                        statusState.value = AgentLinkStatus.Revoked
                        connections.update(connectionId) { it.copy(revoked = true) }
                        return
                    }
                    AgentConnectionException.Reason.UpdateRequired -> {
                        statusState.value = AgentLinkStatus.UpdateRequired
                        return
                    }
                    else -> statusState.value = AgentLinkStatus.Offline
                }
            } catch (e: AgentApiException) {
                // A 409 cursor_unavailable or any refused read: read the snapshot again.
                snapshotRead = false
                statusState.value = AgentLinkStatus.Offline
            } catch (_: Exception) {
                statusState.value = AgentLinkStatus.Offline
            }
            delay(backoff + (backoff * JITTER * (random.nextDouble() * 2 - 1)).toLong())
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF)
        }
    }

    /** Health (protocol 27 or later) and the agent's own name and avatar, shown in the account menu. */
    private suspend fun refreshIdentity() {
        val known = connections.accounts.value.firstOrNull { it.id == connectionId }
        val link = linkLock.withLock { link } ?: run {
            client.reset() // reads the credentials and makes the link
            linkLock.withLock { link }
        } ?: throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
        val info = AgentIdentity.refresh(link.transport, link.token, known?.name.orEmpty(), known?.avatarFile?.let { known.avatarETag })
        if (known != null) {
            connections.update(connectionId, info.avatar) { it.copy(name = info.name, thumbhash = info.thumbhash ?: it.thumbhash, revoked = false) }
        }
    }

    private suspend fun readSnapshot() {
        reads.update { it + 1 }
        try {
            val bootstrap = client.decode<WireDesktopBootstrap>("GET", "/v0/bootstrap/desktop")
            catalogLock.withLock { catalogState.update { it.withBootstrap(bootstrap) } }
        } finally {
            reads.update { it - 1 }
        }
    }

    /** The journal from the catalog's cursor until the stream ends or fails. */
    private suspend fun follow(onConnected: () -> Unit) {
        val stream = client.events(catalogState.value.cursor)
        try {
            val parser = ServerSentEventParser()
            while (true) {
                val bytes = stream.read() ?: throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
                for (frame in parser.append(bytes)) {
                    val event = frame.toAgentEvent() ?: continue
                    if (event.type == AgentEvent.HELLO) {
                        val hello = AgentHello.of(event)
                        if (hello.gap) readSnapshot()
                        statusState.value = AgentLinkStatus.Connected
                        onConnected()
                        // Every connect sends what was changed while offline.
                        if (catalogState.value.pendingSettings.isNotEmpty()) settingsQueued.trySend(Unit)
                    } else {
                        apply(event)
                    }
                    eventFlow.emit(event)
                }
            }
        } finally {
            stream.close()
        }
    }

    private suspend fun apply(event: AgentEvent) {
        val stale = catalogLock.withLock {
            val applied = catalogState.value.apply(event)
            catalogState.value = applied.catalog
            applied.stale
        }
        for (resource in stale) scope.launch { reread(resource) }
    }

    /** Reads again one resource whose version chain broke, or the snapshot (once for a burst of Surface events). */
    private suspend fun reread(stale: AgentCatalog.Stale) {
        if (stale.kind == AgentCatalog.Stale.SNAPSHOT) {
            if (!snapshotQueued.compareAndSet(false, true)) return
            try {
                delay(SNAPSHOT_COALESCE)
            } finally {
                // Events from here on queue the next read.
                snapshotQueued.set(false)
            }
            try {
                readSnapshot()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The next snapshot (a reconnect after a gap) catches it up.
            }
            return
        }
        reads.update { it + 1 }
        val (path, key) = when (stale.kind) {
            "project" -> "/v0/projects/${AgentClient.escape(stale.id)}" to "project"
            "workspace" -> "/v0/workspaces/${AgentClient.escape(stale.id)}" to "workspace"
            "bot" -> "/v0/bots/${AgentClient.escape(stale.id)}" to "bot"
            "task" -> "/v0/tasks/${AgentClient.escape(stale.id)}" to "task"
            else -> "/v0/agents/${AgentClient.escape(stale.id)}" to "agent"
        }
        try {
            val answer = client.decode<JsonObject>("GET", path)
            val resource = answer[key] as? JsonObject ?: return
            catalogLock.withLock {
                catalogState.update { catalog ->
                    if (stale.kind == "task") catalog.withTask(resource, answer["membership"] as? JsonObject) else catalog.withResource(stale.kind, resource)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The next snapshot (a reconnect after a gap) catches it up.
        } finally {
            reads.update { it - 1 }
        }
    }

    /**
     * Sends the settings changed here, one at a time, while the link is up
     * (iOS's SyncEngine `deliver`): each with its `mutationId` and the time
     * the person made it, the agent's answer kept. A failure keeps the
     * change and its time for the next try; a refusal (4xx) or a revoked
     * phone stops, the change still shown here, as API.md asks of a daemon
     * that has no user settings.
     */
    private suspend fun deliverSettings() {
        var attempt = 0
        while (true) {
            if (statusState.value != AgentLinkStatus.Connected) return
            val (key, change) = catalogState.value.pendingSettings.entries.minByOrNull { it.key }?.toPair() ?: return
            try {
                val answer = client.decode<JsonObject>(
                    "PUT",
                    "/v0/user-settings/${AgentClient.escape(key)}",
                    buildJsonObject {
                        put("mutationId", change.mutationId)
                        put("value", change.value)
                        put("updatedAt", change.updatedAt)
                    },
                )
                catalogLock.withLock {
                    catalogState.update { it.settingAcknowledged(key, change.mutationId, answer["setting"] as? JsonObject) }
                }
                attempt = 0
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentApiException) {
                if (e.status in 400..499) return
                delay(settingsBackoff(attempt++))
            } catch (e: AgentConnectionException) {
                if (e.reason == AgentConnectionException.Reason.Revoked) return
                delay(settingsBackoff(attempt++))
            } catch (_: Exception) {
                delay(settingsBackoff(attempt++))
            }
        }
    }

    /** 1, 2, 4 … 30 seconds, as iOS retries a setting. */
    private fun settingsBackoff(attempt: Int): Long = (INITIAL_BACKOFF shl attempt.coerceAtMost(5)).coerceAtMost(30_000L)

    /**
     * A resource kept beside the catalog for offline use (iOS's
     * `cachedResource` and `keepResource`), by [key]: the artifact list's
     * first page. Deleted with the catalog when the connection goes.
     */
    fun cachedResource(key: String): JsonObject? {
        DiskThread.check()
        return try {
            resourceFile(key)?.takeIf { it.exists() }?.readText()?.let { AgentClient.json.parseToJsonElement(it) as? JsonObject }
        } catch (_: Exception) {
            null
        }
    }

    fun keepResource(key: String, value: JsonObject) {
        DiskThread.check()
        val file = resourceFile(key) ?: return
        try {
            file.parentFile?.mkdirs()
            val temp = File(file.path + ".tmp")
            temp.writeText(value.toString())
            if (!temp.renameTo(file)) temp.delete()
        } catch (_: Exception) {
            // Offline misses this page; the next read keeps it.
        }
    }

    private fun resourceFile(key: String): File? =
        cacheFile?.let { File(it.parentFile, it.nameWithoutExtension + "." + key.filter(Char::isLetterOrDigit) + ".json") }

    private fun readCache(): AgentCatalog? {
        DiskThread.check()
        return try {
            cacheFile?.takeIf { it.exists() }?.readText()?.let { AgentClient.json.decodeFromString(AgentCatalog.serializer(), it) }
        } catch (_: Exception) {
            null
        }
    }

    private fun writeCache(catalog: AgentCatalog) {
        DiskThread.check()
        val file = cacheFile ?: return
        try {
            file.parentFile?.mkdirs()
            val temp = File(file.path + ".tmp")
            temp.writeText(AgentClient.json.encodeToString(AgentCatalog.serializer(), catalog))
            if (!temp.renameTo(file)) temp.delete()
        } catch (_: Exception) {
            // Offline home misses this change; the next one writes it.
        }
    }

    private companion object {
        /** Surface events that come together read the snapshot once. */
        const val SNAPSHOT_COALESCE = 300L
        const val INITIAL_BACKOFF = 1_000L
        const val MAX_BACKOFF = 5_000L
        const val JITTER = 0.5
    }
}
