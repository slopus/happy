package com.slopus.happy.agent

import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.agentTransport
import com.slopus.happy.connection.Transport
import com.slopus.happy.conversation.ParkedConversations
import com.slopus.happy.conversation.UnsentWork
import com.slopus.happy.data.DiskThread
import com.slopus.happy.diagnostics.traced
import com.slopus.happy.documents.DocumentLibrary
import com.slopus.happy.documents.DocumentStreams
import com.slopus.happy.feed.AgentFeedRoutes
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedLookups
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.random.Random

/** How an agent connection's live link stands, as its home and chats show it. */
enum class AgentLinkStatus {
    Connecting, Connected, Offline, Revoked, UpdateRequired,
    /** A team server's sign-in expired (edge SSO): the person signs in again, then the link resumes. */
    SignInRequired,
}

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
    makeTransport: (com.slopus.happy.connection.AgentConnectionCredentials) -> Transport = { agentTransport(it.address, it.port, it.publicUrl, it.tailcatAvailable != false) },
    private val random: Random = Random.Default,
    /** Plays desktop's completion chime ([CompletionWatch] decides when). */
    private val chime: () -> Unit = {},
) {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]) + Dispatchers.IO)
    private val linkLock = Mutex()
    private val snapshotQueued = AtomicBoolean(false)
    // Asks for the settings changed here to be sent; one ask covers every change made meanwhile.
    private val settingsQueued = Channel<Unit>(Channel.CONFLATED)
    private var route: Pair<com.slopus.happy.connection.AgentConnectionCredentials, Transport>? = null

    /**
     * The transport is made once; the bearer is asked for on every request,
     * so a team server's access token is refreshed as it nears expiry.
     */
    val client: AgentClient = AgentClient.lazy {
        val (credentials, transport) = linkLock.withLock {
            route ?: run {
                val credentials = connections.linkCredentials(connectionId) ?: throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
                (credentials to connections.transport(connectionId, credentials, makeTransport)).also { route = it }
            }
        }
        val renew: (suspend (String) -> String)? = if (credentials.oauth != null) { stale -> connections.renew(connectionId, stale) } else null
        // The sign-in this request is made under: only its refusal signs out, never a newer one's.
        val grant = connections.grant(connectionId)
        AgentClient.Link(transport, connections.bearer(connectionId, credentials), renew, credentials.oauth?.let { { profile -> connections.signedOut(connectionId, profile, grant) } })
    }

    // Empty until the kept catalog is read off the main thread (init), then live.
    private val catalogState = MutableStateFlow(AgentCatalog())
    private val catalogLock = Mutex()
    private val surfaceJoinLock = Mutex()

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

    private val gitSnapshots = MutableStateFlow<Map<String, WorkspaceLineChanges>>(emptyMap())
    private val gitRenewal = MutableStateFlow(0)

    /**
     * What the person did here that the computer has yet to hear: reads,
     * archives, leaves and renames (iOS's `IntentOutbox`), kept beside the
     * catalog through a kill and sent while the link is up. Another
     * library adds its own kinds with [IntentOutbox.handle].
     */
    val intents = IntentOutbox(
        scope,
        cacheFile?.let { FileIntentStorage(File(it.parentFile, it.nameWithoutExtension + ".intents.json")) } ?: MemoryIntentStorage(),
    )

    /**
     * The person's Feed on this computer (iOS `FeedLibrary`), followed for as
     * long as the connection: kept beside the catalog, current to the
     * `feed.*` events; none where the computer keeps none.
     */
    val feedLibrary = FeedLibrary(
        scope,
        AgentFeedRoutes(client),
        intents,
        kept = { withContext(Dispatchers.IO) { cachedResource(FeedLibrary.RESOURCE) } },
        keep = { value -> withContext(Dispatchers.IO) { keepResource(FeedLibrary.RESOURCE, value) } },
    )

    /** What Feed entries name that the catalog doesn't hold: artifacts, and the todos they made. */
    val feedLookups: FeedLookups by lazy {
        FeedLookups.of(scope, client) { ArtifactClient(client).artifact(it) }.also { lookups ->
            scope.launch { events.collect(lookups::receive) }
        }
    }

    private val noticeState = MutableStateFlow<String?>(null)

    /** A refusal the computer gave to something done here, for home's notice; it clears after [NOTICE_MILLIS]. */
    val notice: StateFlow<String?> = noticeState.asStateFlow()

    /**
     * The team members this phone shows (iOS's `users`): their tasks' authors
     * on home, the Feed's people, todos' and documents' authors. Kept beside
     * the catalog; none outside a team.
     */
    val team = TeamDirectory(
        scope,
        read = { ids -> client.teamUsers(ids) },
        kept = { withContext(Dispatchers.IO) { cachedResource(TeamDirectory.RESOURCE) } },
        keep = { value -> withContext(Dispatchers.IO) { keepResource(TeamDirectory.RESOURCE, value) } },
    )

    /** Home's rows, derived off the main thread; equal rows keep their instances. */
    val feed: StateFlow<AgentFeed> = combine(
        catalogState, intents.pending, gitSnapshots,
        feedLibrary.state.map { if (it.available == true) it.unread else null }.distinctUntilChanged(),
        team.users,
    ) { catalog, pending, git, feedUnread, users ->
        AgentFeed.derive(catalog.withSurfaceIntents(pending), git = git, intents = IntentOverlay.of(pending), feedUnread = feedUnread, users = users)
    }
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

    /** Desktop's Completion sound for this connection, which the chime follows ([CompletionWatch]). */
    val completionSound: StateFlow<CompletionSound> = catalogState
        .map { DesktopSettings.completionSound(it.settingValues) }
        .distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, DesktopSettings.completionSound(catalogState.value.settingValues))

    /** Sets the Completion sound, here and on every device this connection is used from. */
    fun setCompletionSound(sound: CompletionSound) {
        scope.launch { setSetting(DesktopSettings.COMPLETION_SOUND, DesktopSettings.completionSoundValue(sound)) }
    }

    /** Sharing preferences belong to this person on this connection, including pending offline edits. */
    val sharing: StateFlow<AgentSharingState> = combine(catalogState, connections.accounts) { catalog, accounts ->
        AgentSharingState.from(catalog, accounts.firstOrNull { it.id == connectionId }?.protocol)
    }.distinctUntilChanged().stateIn(scope, SharingStarted.Eagerly,
        AgentSharingState.from(catalogState.value, connections.accounts.value.firstOrNull { it.id == connectionId }?.protocol))

    fun setAutoJoin(kind: AutoJoinKind, enabled: Boolean) {
        val state = sharing.value as? AgentSharingState.Ready ?: return
        if (kind == AutoJoinKind.Surfaces && state.surfaces == null) return
        scope.launch { setSetting(kind.key, DesktopSettings.autoJoinValue(enabled)) }
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

    /** The computer's accounts' plan usage, followed while a composer shows ([AgentUsageSource.follow]). */
    val usage: AgentUsageSource by lazy {
        AgentUsageSource({ client.decode<JsonObject>("GET", "/v0/usage") }, events, scope) { accounts ->
            client.send("POST", "/v0/usage/refresh", buildJsonObject { put("providerIds", JsonArray(accounts.map(::JsonPrimitive))) })
        }
    }

    /** What the Happy references in this connection's messages read as, and the titles and names they need read. */
    val references: com.slopus.happy.references.ReferenceReader by lazy {
        com.slopus.happy.references.ReferenceReader(
            scope, catalog, events,
            readArtifact = { ArtifactClient(client).artifact(it) },
            readUsers = { com.slopus.happy.references.ReferenceReader.userNames(client, it) },
        )
    }
    /**
     * The connection's todo lists, kept on the phone and changed offline
     * first; made with the session so changes kept from an earlier run go
     * out once the link is up, whether or not a list is opened.
     */
    val todos: com.slopus.happy.todos.TodoLibrary = com.slopus.happy.todos.connectionTodos(this, client, scope)

    /** Bots' pictures, as home's rows draw them. */
    /** Chat media kept on this phone for good, beside the catalog (iOS `MediaLibrary.agent`); null where nothing is kept. */
    val media: com.slopus.happy.media.MediaLibrary? = cacheFile?.let { com.slopus.happy.media.MediaLibrary(File(it.parentFile, it.nameWithoutExtension + ".media")) }

    /**
     * The document Surfaces open here and those with changes still to send
     * (iOS's `SyncEngine.documents`), kept beside the catalog in
     * `<connection>.documents/`; their live frames come off this session's stream.
     */
    val documents = DocumentLibrary(client, cacheFile?.let { File(it.parentFile, it.nameWithoutExtension + ".documents") }, scope)

    val pictures = AgentPictures(connectionId, cacheFile?.let { File(it.parentFile, it.nameWithoutExtension + ".pictures") }) { path -> client.send("GET", path, category = RequestCategory.File).body }

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
     * Opening a chat reads it (iOS's `markRead`): its dot goes from home at
     * once and stays gone until the computer has heard, through a kill.
     */
    suspend fun markRead(agentId: String) {
        if (intents.pending.value.any { it.kind == Intent.READ && it.target == agentId }) return
        intents.enqueue(Intent.READ, agentId)
    }

    /** Archives a task, bot (`kind`) or subtask (`agent`): its row goes at once, with what nests under it, and comes back only if the computer refuses. */
    suspend fun archive(kind: String, id: String): Intent = intents.enqueue(Intent.ARCHIVE, id, of(kind))

    /** Leaves a task or Surface (`kind`): out of this person's list at once. */
    suspend fun leave(kind: String, id: String): Intent = intents.enqueue(Intent.LEAVE, id, of(kind))

    /** Names a task or bot (`kind`): the row wears it at once. */
    suspend fun rename(kind: String, id: String, title: String): Intent =
        intents.enqueue(Intent.RENAME, id, buildJsonObject { put("kind", kind); put("title", title) })

    /**
     * Leaves a Surface (iOS's `leave(surfaceId:)`): its row goes from home
     * at once and comes back if the agent refuses. It takes the Surface out
     * of the person's own list; its content stays for everyone in it. The
     * leave is tried at once and kept until the computer hears it, so one
     * that can't go yet goes when the link is back. Null once left or on
     * its way; otherwise the
     * agent's own words for the refusal, empty where it gave none (the
     * screen says it in its own).
     */
    suspend fun leaveSurface(surfaceId: String): String? {
        // A second ask while one is on its way sends nothing more and shares its answer.
        val intent = intents.pending.value.firstOrNull { it.kind == Intent.LEAVE && it.target == surfaceId }
        // The person confirmed and waits on it: tried at once, link or not (iOS's `attempt`).
        val verdict = if (intent != null) intents.attempt(intent.id)
            else intents.enqueueAndAttempt(Intent.LEAVE, surfaceId, of("surface")).verdict
        return (verdict as? IntentOutbox.Verdict.Refused)?.reason
    }

    private fun of(kind: String) = buildJsonObject { put("kind", kind) }

    /**
     * Sends [intent] (iOS SyncEngine's `deliver`). Gone already (404)
     * counts as done; any other 4xx but a timeout or rate limit is the
     * computer's no, and drops it; everything else is tried again.
     */
    private suspend fun deliver(intent: Intent) {
        val id = AgentClient.escape(intent.target)
        val mutation = buildJsonObject { put("mutationId", intent.id) }
        try {
            when (intent.kind) {
                SURFACE_JOIN -> {
                    val body = client.decode<JsonObject>("POST", "/v0/surfaces/$id/join", mutation)
                    val surface = body["surface"] as? JsonObject
                        ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
                    catalogLock.withLock { catalogState.update { it.withSurface(surface) } }
                }
                Intent.READ -> client.send("POST", "/v0/agents/$id/read", JsonObject(emptyMap()))
                Intent.LEAVE -> client.send("POST", if (intent.of == "surface") "/v0/surfaces/$id/leave" else "/v0/tasks/$id/leave", mutation)
                Intent.ARCHIVE -> when (intent.of) {
                    "agent" -> client.send("POST", "/v0/agents/$id/archive", mutation)
                    "bot" -> archiveAt("/v0/bots/$id", "bot")
                    else -> archiveAt("/v0/tasks/$id", "task")
                }
                Intent.RENAME -> {
                    val title = (intent.value["title"] as? JsonPrimitive)?.contentOrNull ?: return
                    when (intent.of) {
                        "bot" -> renameAt("/v0/bots/$id", "bot", title, intent.id)
                        "surface" -> renameAt("/v0/surfaces/$id", "surface", title, intent.id)
                        else -> renameAt("/v0/tasks/$id", "task", title, intent.id)
                    }
                }
                else -> throw IntentRefusal("")
            }
        } catch (e: AgentApiException) {
            if (e.status in 400..499 && (e.status != 404 || intent.kind == SURFACE_JOIN) && e.status != 408 && e.status != 429) throw IntentRefusal(e.message.orEmpty())
            if (e.status != 404) throw e
        }
        // Left or archived: out of the catalog too, so it stays gone once the intent is.
        if (intent.kind == Intent.LEAVE || intent.kind == Intent.ARCHIVE) {
            catalogLock.withLock { catalogState.update { it.withoutListed(intent.of ?: "task", intent.target) } }
        }
        val title = (intent.value["title"] as? JsonPrimitive)?.contentOrNull
        if (intent.kind == Intent.RENAME && title != null) catalogLock.withLock { catalogState.update { it.withName(intent.of ?: "task", intent.target, title) } }
    }

    /** Archival names the version it archives (`If-Match`). */
    private suspend fun archiveAt(path: String, key: String) {
        val version = versionOf(path, key)
        client.send("POST", "$path/archive", JsonObject(emptyMap()), headers = mapOf("If-Match" to version))
    }

    /** A rename names the version it renames (`If-Match`); one that lost a race reads the newer version and renames that. */
    private suspend fun renameAt(path: String, key: String, name: String, mutationId: String) {
        repeat(2) { attempt ->
            try {
                client.send("PATCH", path, buildJsonObject { put("name", name); put("mutationId", mutationId) }, headers = mapOf("If-Match" to versionOf(path, key)))
                return
            } catch (e: AgentApiException) {
                if (e.status != 409 || attempt == 1) throw e
            }
        }
    }

    private suspend fun versionOf(path: String, key: String): String {
        val body = AgentClient.json.parseToJsonElement(client.send("GET", path).text) as? JsonObject
        return ((body?.get(key) as? JsonObject)?.get("version") as? JsonPrimitive)?.contentOrNull ?: throw AgentApiException(500, "invalid_response", null)
    }

    /** Every Surface on the computer, joined or not, kept with the catalog (iOS's `SurfaceCatalogFeed`). */
    val surfaces: StateFlow<SurfaceCatalog> = combine(catalogState, intents.pending) { catalog, pending ->
        SurfaceCatalog.of(catalog.withSurfaceIntents(pending))
    }
        .distinctUntilChanged()
        .flowOn(Dispatchers.Default)
        .stateIn(scope, SharingStarted.Eagerly, SurfaceCatalog.of(catalogState.value))

    /** One Surface, live; null while the catalog doesn't know it. */
    fun surface(surfaceId: String): Flow<Surface?> = surfaces.map { it[surfaceId] }.distinctUntilChanged()

    private val joinRefusalState = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Joins the agent refused, by Surface, with its words (empty where it gave none), until [dismissJoinRefusal]. */
    val joinRefusals: StateFlow<Map<String, String>> = joinRefusalState.asStateFlow()

    fun dismissJoinRefusal(surfaceId: String) = joinRefusalState.update { it - surfaceId }

    /**
     * Joins a Surface the person opened without being in it
     * (`POST /v0/surfaces/:id/join`, desktop de78af49): it takes its place
     * in their list at once and the computer's answer places it. A refusal
     * takes it out again and is kept in [joinRefusals] for the open Surface
     * to say, which stays open. A joined Surface sends nothing. Runs in the
     * session, so leaving the screen doesn't cancel it. Answers null once
     * joined or kept for retry, otherwise the refusal.
     */
    fun joinSurface(surfaceId: String): Deferred<String?> = scope.async {
        val intent = surfaceJoinLock.withLock {
            val known = catalogState.value.withSurfaceIntents(intents.pending.value)
            if (known.surfaces[surfaceId]?.let(Surface::parse)?.joinedBy(known.userId) == true) return@async null
            intents.pending.value.firstOrNull { it.kind == SURFACE_JOIN && it.target == surfaceId }
                ?: intents.enqueue(SURFACE_JOIN, surfaceId)
        }
        val refusal = (intents.attempt(intent.id) as? IntentOutbox.Verdict.Refused)?.reason
        if (refusal != null) joinRefusalState.update { it + (surfaceId to refusal) }
        refusal
    }

    /**
     * Makes a Surface of [type] named [name] (`POST /v0/surfaces`), under an
     * id chosen here so a retry makes the same one; it is in the catalog,
     * and the person's list, once the computer answers.
     */
    suspend fun createSurface(type: String, name: String, id: String = AgentClient.newId()): Surface {
        val body = client.decode<JsonObject>("POST", "/v0/surfaces", buildJsonObject {
            put("id", id)
            put("type", type)
            put("name", name)
            put("mutationId", AgentClient.newId())
        })
        val surface = body["surface"] as? JsonObject ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        catalogLock.withLock { catalogState.update { it.withSurface(surface) } }
        return Surface.parse(surface) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    /**
     * A Surface's one shared chat (desktop b3204bde, `ensureSurfaceChat`):
     * the agent it already has, or the one the computer makes the first time
     * anyone asks. A request that never arrived, or a computer still
     * preparing the chat's folder, is asked again (1, 2, 4 s, under one
     * mutationId); a refusal is thrown at once. Answers the chat's agent ID.
     */
    suspend fun ensureSurfaceChat(surfaceId: String): String {
        surfaces.value[surfaceId]?.chatAgentId?.let { return it }
        val mutationId = AgentClient.newId()
        var wait = 1_000L
        while (true) {
            try {
                val body = client.decode<JsonObject>("POST", "/v0/surfaces/${AgentClient.escape(surfaceId)}/chat", buildJsonObject { put("mutationId", mutationId) })
                (body["surface"] as? JsonObject)?.let { surface -> catalogLock.withLock { catalogState.update { it.withSurface(surface) } } }
                return (body["agent"] as? JsonObject)?.string("id") ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
            } catch (error: AgentApiException) {
                if (error.status in 400..499 || wait > 4_000) throw error
            } catch (error: AgentConnectionException) {
                if (error.reason != AgentConnectionException.Reason.Unavailable || wait > 4_000) throw error
            }
            delay(wait)
            wait *= 2
        }
    }

    /**
     * Refresh the Surface catalog for the lists' pull gesture. A journal or
     * local Surface change during the read wins; its snapshot cannot roll
     * that change back. Merge by resource version and retain accessible
     * instances omitted by older daemons' joined-only response.
     * False means this daemon has no Surface routes (404/501).
     */
    suspend fun refreshSurfaces(): Boolean {
        val before = catalogLock.withLock { catalogState.value }
        val body = try { client.decode<JsonObject>("GET", "/v0/surfaces") }
        catch (error: AgentApiException) { if (error.status == 404 || error.status == 501) return false else throw error }
        val rows = body["surfaces"] as? JsonArray ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        val surfaces = rows.map { it as? JsonObject ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse) }
        if (surfaces.any { Surface.parse(it) == null }) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        catalogLock.withLock {
            catalogState.update { current ->
                if (current.cursor != before.cursor || current.surfaces !== before.surfaces) current
                else surfaces.fold(current) { catalog, surface -> catalog.withSurface(surface) }
            }
        }
        return true
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

    /** Conversations left with a send in hand, for their next screen ([ParkedConversations]). */
    val parkedConversations = ParkedConversations(scope)

    init {
        intents.handle(setOf(Intent.READ, Intent.ARCHIVE, Intent.LEAVE, Intent.RENAME, SURFACE_JOIN), ::deliver)
        feedLibrary.start()
        // The members the listed tasks belong to, read as they are listed.
        scope.launch { catalogState.map(TeamUser::authors).distinctUntilChanged().collect(team::want) }
        // Sent while the link is up; every connect sends what waits at once.
        scope.launch { statusState.collect { intents.setOnline(it == AgentLinkStatus.Connected) } }
        scope.launch {
            intents.rejections.collectLatest { rejection ->
                if (rejection.intent.kind == SURFACE_JOIN) {
                    joinRefusalState.update { it + (rejection.intent.target to rejection.reason) }
                    return@collectLatest
                }
                // Read/seen refusals stay quiet; todos and screens show their own refusals.
                if (rejection.intent.kind == Intent.READ || rejection.intent.kind in FeedLibrary.KINDS || rejection.intent.kind.startsWith("todo.") || rejection.heard) return@collectLatest
                noticeState.value = rejection.reason
                delay(NOTICE_MILLIS)
                if (noticeState.value == rejection.reason) noticeState.value = null
            }
        }
        scope.launch {
            // The kept catalog first: home draws it, and the link resumes from its cursor.
            traced("AgentSession.readCache") { readCache() }?.let { cached -> catalogLock.withLock { catalogState.update { if (it.loaded) it else cached } } }
            // A team server that wants signing in again (a refused refresh) stops the link at once,
            // even with its event stream still open, and it resumes from its cursor after.
            val signedIn = connections.accounts.map { list -> list.none { it.id == connectionId && it.signInRequired } }.distinctUntilChanged()
            combine(active.distinctUntilChanged(), signedIn, ::Pair).collectLatest { (on, signedIn) ->
                when {
                    !signedIn -> statusState.value = AgentLinkStatus.SignInRequired
                    on -> coroutineScope {
                        launch { watchGit() }
                        live()
                    }
                    statusState.value == AgentLinkStatus.SignInRequired -> statusState.value = AgentLinkStatus.Connecting
                }
            }
        }
        scope.launch {
            settingsQueued.receiveAsFlow().collect { deliverSettings() }
        }
        if (cacheFile != null) {
            // Undispatched: watching from the first value, so a load that comes first is not dropped as it.
            @OptIn(FlowPreview::class)
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                catalogState.drop(1).filter { it.loaded }.debounce(1_000).collect { writeCache(it) }
            }
        }
    }

    /** Stops the link and lets go of the tunnel. */
    suspend fun close() {
        // Open documents keep what they hold and say goodbye, briefly: a lost link must not hold the close up.
        withContext(kotlinx.coroutines.NonCancellable) { kotlinx.coroutines.withTimeoutOrNull(2_000) { documents.stop() } }
        scope.cancel()
        withContext(kotlinx.coroutines.NonCancellable) {
            media?.stop()
            linkLock.withLock { route?.second?.close(); route = null }
        }
    }

    private suspend fun live() {
        var backoff = INITIAL_BACKOFF
        // A catalog with a cursor (kept, or read before the app went behind) resumes the journal from
        // there; only a gap or a refused cursor reads the whole snapshot again.
        var snapshotRead = catalogState.value.let { it.loaded && it.cursor != null }
        while (true) {
            awaitSignedIn()
            // A computer that did not answer stays offline while it's asked again (iOS's `Session.headerState`):
            // home's notice says so until the stream opens, rather than coming and going with every retry.
            if (statusState.value != AgentLinkStatus.Connected && statusState.value != AgentLinkStatus.Offline) {
                statusState.value = AgentLinkStatus.Connecting
            }
            // The sign-in this attempt runs under: a refusal it meets signs out only that one.
            val grant = connections.grant(connectionId)
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
                    AgentConnectionException.Reason.SignInRequired, AgentConnectionException.Reason.ProfileRequired -> {
                        val profile = e.reason == AgentConnectionException.Reason.ProfileRequired
                        connections.signedOut(connectionId, profile, grant)
                        backoff = INITIAL_BACKOFF
                        continue
                    }
                    else -> unanswered()
                }
            } catch (e: AgentApiException) {
                // A 409 cursor_unavailable or any refused read: read the snapshot again.
                snapshotRead = false
                unanswered()
            } catch (_: Exception) {
                unanswered()
            }
            delay(backoff + (backoff * JITTER * (random.nextDouble() * 2 - 1)).toLong())
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF)
        }
    }

    /** An attempt failed: a stream that was open is on its way back; one that never opened did not answer. */
    private fun unanswered() {
        statusState.value = if (statusState.value == AgentLinkStatus.Connected) AgentLinkStatus.Connecting else AgentLinkStatus.Offline
    }

    /**
     * While a team server wants signing in again, the link waits, saying so,
     * and resumes from its cursor once the person has.
     */
    private suspend fun awaitSignedIn() {
        if (connections.accounts.value.none { it.id == connectionId && it.signInRequired }) return
        statusState.value = AgentLinkStatus.SignInRequired
        connections.accounts.first { list -> list.none { it.id == connectionId && it.signInRequired } }
    }

    /** Health (protocol 27 or later) and the agent's own name and avatar, shown in the account menu. */
    private suspend fun refreshIdentity() {
        val known = connections.accounts.value.firstOrNull { it.id == connectionId }
        val info = AgentIdentity.refresh(client.requester, known?.name.orEmpty(), known?.avatarFile?.let { known.avatarETag }, oauth = client.isOAuth())
        client.noteHealth(info)
        if (known != null) {
            connections.update(connectionId, info.avatar) { it.copy(name = info.name, thumbhash = info.thumbhash ?: it.thumbhash, revoked = false, instanceId = info.instanceId, daemonVersion = info.daemonVersion, protocol = info.protocol) }
        }
    }

    private suspend fun readSnapshot() {
        reads.update { it + 1 }
        try {
            val bootstrap = client.decode<WireDesktopBootstrap>("GET", "/v0/bootstrap/desktop")
            catalogLock.withLock { catalogState.update { it.withBootstrap(bootstrap) } }
            feedLibrary.bootstrap(bootstrap.feedUnread, bootstrap.cursor)
        } finally {
            reads.update { it - 1 }
        }
    }

    private val completions = CompletionWatch()

    /** The journal from the catalog's cursor until the stream ends or fails. */
    private suspend fun follow(onConnected: () -> Unit) {
        val stream = client.events(catalogState.value.cursor)
        try {
            val parser = ServerSentEventParser()
            while (true) {
                val bytes = stream.read() ?: throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
                for (frame in parser.append(bytes)) {
                    // Live document frames go to their documents, never to the journal.
                    if (DocumentStreams.isDocumentFrame(frame.event)) {
                        documents.frame(frame.event, frame.data)
                        continue
                    }
                    val event = frame.toAgentEvent() ?: continue
                    if (event.type == AgentEvent.HELLO) {
                        documents.opened(event.data)
                        val hello = AgentHello.of(event)
                        if (hello.gap) readSnapshot()
                        statusState.value = AgentLinkStatus.Connected
                        // Reads the Feed's newest page each time, so a gap loses nothing.
                        feedLibrary.connected()
                        // Faces may have changed while away.
                        team.connected()
                        gitRenewal.update { it + 1 }
                        onConnected()
                        // Every connect sends what was changed while offline.
                        if (catalogState.value.pendingSettings.isNotEmpty()) settingsQueued.trySend(Unit)
                    } else {
                        if (event.type == "git.updated") {
                            val id = event.data.string("workspaceId")
                            val state = WorkspaceLineChanges.parse(event.data["git"])
                            if (id != null && state != null && id in gitWorkspaceIds(feed.value)) receiveGit(mapOf(id to state))
                        }
                        apply(event)
                        if (event.type.startsWith("feed.")) feedLibrary.receive(event)
                        if (event.type == "profile.updated") profileChanged(event)
                    }
                    val listed = { agentId: String -> feed.value.conversations.any { it.agentId == agentId } }
                    if (completions.finished(event, catalogState.value, listed, System.currentTimeMillis()) != null) chime()
                    eventFlow.emit(event)
                }
            }
        } finally {
            documents.closed()
            feedLibrary.disconnected()
            stream.close()
        }
    }

    /**
     * A profile changed (iOS `profileChanged`, `authorChanged`): standalone,
     * the event carries it ([AgentCatalog.apply]); in a team it only names
     * who, so the person's own is read again and another member's face too.
     */
    private fun profileChanged(event: AgentEvent) {
        if (event.data["profile"] is JsonObject) return
        val id = event.data.string("userId") ?: return
        if (id != catalogState.value.userId) return team.changed(id)
        scope.launch {
            val profile = try {
                client.decode<JsonObject>("GET", "/v0/profile")["profile"] as? JsonObject
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            } ?: return@launch
            catalogLock.withLock { catalogState.update { it.withProfile(profile) } }
        }
    }

    private fun gitWorkspaceIds(feed: AgentFeed): Set<String> = feed.rows.mapNotNull { row ->
        when (row) {
            is AgentFeedRow.Conversation -> row.workspaceId
            is AgentFeedRow.Folder -> row.id
            else -> null
        }
    }.toSet()

    /** One renewing subscription per foreground account; rows never start network work. */
    private suspend fun watchGit() {
        combine(feed.map(::gitWorkspaceIds).distinctUntilChanged(), gitRenewal, status) { ids, renewal, status ->
            Triple(ids, renewal, status == AgentLinkStatus.Connected)
        }.distinctUntilChanged().collectLatest { (ids, _, connected) ->
            if (!connected) return@collectLatest
            gitSnapshots.update { it.filterKeys(ids::contains) }
            while (true) {
                try {
                    val response = client.send("POST", "/v0/git/watch", buildJsonObject {
                        put("workspaceIds", JsonArray(ids.sorted().map(::JsonPrimitive)))
                    })
                    val body = AgentClient.json.parseToJsonElement(response.text) as? JsonObject
                    val snapshots = body?.get("snapshots") as? JsonObject
                    receiveGit(snapshots.orEmpty().mapNotNull { (id, value) ->
                        WorkspaceLineChanges.parse(value)?.takeIf { id in ids }?.let { id to it }
                    }.toMap())
                } catch (e: CancellationException) { throw e }
                catch (_: Exception) { /* Git is optional; never block the home feed. */ }
                delay(30_000)
            }
        }
    }

    private fun receiveGit(states: Map<String, WorkspaceLineChanges>) {
        gitSnapshots.update { previous ->
            previous + states.filter { (id, state) -> state.scannedAt >= (previous[id]?.scannedAt ?: 0.0) }
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

        /** How long a refusal stays in home's notice (iOS SyncEngine's 5 s). */
        const val NOTICE_MILLIS = 5_000L
        const val MAX_BACKOFF = 5_000L
        const val JITTER = 0.5
    }
}
