package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.TailcatTransport
import com.slopus.happy.connection.Transport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.File
import kotlin.random.Random

/** How an agent connection's live link stands, as its home and chats show it. */
enum class AgentLinkStatus { Connecting, Connected, Offline, Revoked, UpdateRequired }

/**
 * One agent connection while the phone talks to it (iOS's DirectSyncEngine):
 * its [client]; the catalog home draws, from `GET /v0/bootstrap/desktop` and
 * then the journal; the journal itself as [events] for the open chat; and
 * [status]. The live link runs while [active] is true (the connection is
 * open and the app in the foreground): health and identity, the snapshot,
 * then `/v0/events/stream` from the snapshot's cursor, reconnecting with
 * socket.io's backoff (1 to 5 s, jitter 0.5) and resuming from the last
 * cursor. A `hello` with `gap` reads the snapshot again. The catalog is
 * kept in [cacheFile], so home shows offline and at once.
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

    private val catalogState = MutableStateFlow(readCache() ?: AgentCatalog())
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

    /** Home's rows, derived off the main thread; equal rows keep their instances. */
    val feed: StateFlow<AgentFeed> = catalogState
        .map { AgentFeed.derive(it) }
        .distinctUntilChanged()
        .scan(null as AgentFeed?) { previous, next -> AgentFeed.reuse(previous, next) }
        // The seed is no feed: never shown, so a cached home never blinks empty.
        .filterNotNull()
        .distinctUntilChanged { a, b -> a === b }
        .flowOn(Dispatchers.Default)
        .stateIn(scope, SharingStarted.Eagerly, AgentFeed.derive(catalogState.value))

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

    init {
        scope.launch {
            active.distinctUntilChanged().collectLatest { on -> if (on) live() }
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
        var snapshotRead = false
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
        val info = AgentIdentity.refresh(link.transport, link.token, known?.name.orEmpty())
        if (known != null && (known.name != info.name || (info.thumbhash != null && known.thumbhash != info.thumbhash) || known.revoked)) {
            connections.update(connectionId) { it.copy(name = info.name, thumbhash = info.thumbhash ?: it.thumbhash, revoked = false) }
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

    /** Reads again one resource whose version chain broke. */
    private suspend fun reread(stale: AgentCatalog.Stale) {
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

    private fun readCache(): AgentCatalog? = try {
        cacheFile?.takeIf { it.exists() }?.readText()?.let { AgentClient.json.decodeFromString(AgentCatalog.serializer(), it) }
    } catch (_: Exception) {
        null
    }

    private fun writeCache(catalog: AgentCatalog) {
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
        const val INITIAL_BACKOFF = 1_000L
        const val MAX_BACKOFF = 5_000L
        const val JITTER = 0.5
    }
}
