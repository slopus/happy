package com.slopus.happy.agent

import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.agentTransport
import com.slopus.happy.connection.Transport
import com.slopus.happy.conversation.HeldConversations
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModelPreferences
import com.slopus.happy.conversation.NewSessionStart
import com.slopus.happy.conversation.ScrollPlace
import com.slopus.happy.conversation.UnsentWork
import com.slopus.happy.data.DiskThread
import com.slopus.happy.diagnostics.Timing
import com.slopus.happy.diagnostics.traced
import com.slopus.happy.documents.DocumentLibrary
import com.slopus.happy.documents.DocumentStreams
import com.slopus.happy.viewers.AgentViewersBackend
import com.slopus.happy.viewers.Viewers
import com.slopus.happy.feed.AgentFeedRoutes
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedCovers
import com.slopus.happy.feed.FeedLookups
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
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
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
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
    Connecting, Connected, Revoked, UpdateRequired,
    /** A team server's sign-in expired (edge SSO): the person signs in again, then the link resumes. */
    SignInRequired,
}

enum class SyncPhase { Offline, P0Connecting, P0Live, Verified }

/**
 * One agent connection while the phone talks to it (iOS's DirectSyncEngine):
 * its [client]; the catalog home draws, from `GET /v0/bootstrap/desktop` and
 * then the journal; the journal itself as [events] for the open chat; and
 * [status]. The live link runs while [active] is true (the connection is
 * open and the app in the foreground): `/v0/events/stream`, then the snapshot
 * unless resuming a recent cursor, reconnecting with backoff (1 to 5 s, jitter 0.5)
 * and resuming from the last cursor within 30 seconds of stream bytes.
 * A resumed `hello` with `gap` reads the snapshot again. The catalog is kept in [cacheFile] and read off the main
 * thread as the session starts, so home shows from disk, offline too, and
 * a cold process reads a fresh bootstrap before verifying the new stream.
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
    private val openChat: () -> String? = { null },
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    initiallyActive: Boolean = false,
    /** Appearance's Group tool calls, which this connection's chats follow ([com.slopus.happy.conversation.ToolSections]). */
    val toolCallsGrouped: StateFlow<Boolean> = MutableStateFlow(false),
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
    val client: AgentClient = AgentClient.lazy(cloud = com.slopus.happy.connection.HappyCloud.isServer(connections.accounts.value.firstOrNull { it.id == connectionId }?.server), beforeHealth = ::usesBootstrapHealth) {
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
    private val redials = MutableStateFlow(0)
    /** Whether the live link runs now (the connection open, the app in front, signed in). */
    @Volatile private var linking = false
    /** Kept through the last background, its tunnels not resumed since ([backgrounded]). */
    private val suspended = AtomicBoolean(false)
    val status: StateFlow<AgentLinkStatus> = statusState.asStateFlow()
    private val phaseState = MutableStateFlow(SyncPhase.Offline)
    private val healthLock = Any()
    private var healthReady: CompletableDeferred<Boolean>? = if (initiallyActive) CompletableDeferred() else null
    private var healthStopped = false
    private var healthClosed = false
    val phase: StateFlow<SyncPhase> = phaseState.asStateFlow()
    private val drainingState = MutableStateFlow(false)
    /**
     * The daemon said it is draining to restart (its hello's `draining`, or
     * `daemon.draining`): writes are refused until a new process says hello.
     * Kept through the reconnect in between (iOS's `HomeSnapshot.draining`).
     */
    val draining: StateFlow<Boolean> = drainingState.asStateFlow()
    /** The process the last hello came from: a `daemon.draining` replayed from the one before isn't this one's. */
    @Volatile private var helloDaemon: String? = null
    /** Home's P0 only; later resource refreshes never keep its title updating. */
    val homeUpdating: StateFlow<Boolean> = phase.map { it == SyncPhase.P0Connecting || it == SyncPhase.P0Live }
        .stateIn(scope, SharingStarted.Eagerly, false)
    private var avatarHash: String? = null
    @Volatile private var lastHeard: Long? = null
    private var resumeAllowed = false
    private var bootstrapConfig: JsonObject? = null
    private val configLock = Mutex()
    private class ChatRead(val agentId: String, val result: Deferred<Result<Pair<com.slopus.happy.conversation.Bootstrap, com.slopus.happy.conversation.MessagesPage>>>, val asked: List<Deferred<Unit>>, var taken: Boolean = false) {
        var cursor: String? = null
        var helloSeen = false
    }
    private val chatLock = Any()
    private var chatRead: ChatRead? = null
    private var chatScope: CoroutineScope? = null
    // Ordering only. An inactive session must never hold a conversation's own reads.
    private val chatStarting = MutableStateFlow(initiallyActive)
    private var chatStartUsed = false

    /** A navigation hint received after stream startup starts immediately, without holding home. */
    fun hintOpenChat(agentId: String) = synchronized(chatLock) {
        chatScope?.let { prepareChat(agentId, it) }
        Unit
    }

    private fun prepareChat(agentId: String, owner: CoroutineScope): ChatRead {
        chatRead?.takeIf { it.agentId == agentId }?.let { return it }
        chatReads.update { it + 1 }
        val bootstrapAsked = CompletableDeferred<Unit>()
        val messagesAsked = CompletableDeferred<Unit>()
        val asked = listOf(bootstrapAsked, messagesAsked)
        val result = owner.async {
            try {
                val api = com.slopus.happy.conversation.ConversationApi { method, path, body, category ->
                    val signal = if (path.endsWith("/bootstrap")) bootstrapAsked else messagesAsked
                    try { client.send(method, path, body, category = category, onAsked = { signal.complete(Unit) }) }
                    finally { signal.complete(Unit) }
                }
                val span = Timing.begin("chat.read")
                Result.success(coroutineScope {
                    val bootstrap = async { api.bootstrap(agentId) }
                    val messages = async { api.messages(agentId) }
                    bootstrap.await() to messages.await()
                }).also { span.end() }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { Result.failure(e) }
        }
        result.invokeOnCompletion { bootstrapAsked.complete(Unit); messagesAsked.complete(Unit); chatReads.update { it - 1 } }
        return ChatRead(agentId, result, asked).also { chatRead = it }
    }

    /** Share startup while it can answer; otherwise the caller uses its ordinary request or kept value. */
    suspend fun awaitBootstrap() { usesBootstrapHealth() }

    private fun checkSessionAllowed() = synchronized(healthLock) {
        val account = connections.accounts.value.firstOrNull { it.id == connectionId }
        if (healthStopped || scope.coroutineContext[Job]?.isActive != true || account == null || account.signInRequired || account.revoked || account.sessionEnded) {
            throw CancellationException("Agent session stopped")
        }
    }

    private fun checkChatAllowed() {
        try { checkSessionAllowed() }
        catch (_: CancellationException) {
            throw AgentConnectionException(when {
                statusState.value == AgentLinkStatus.Revoked -> AgentConnectionException.Reason.Revoked
                statusState.value == AgentLinkStatus.UpdateRequired -> AgentConnectionException.Reason.UpdateRequired
                connections.accounts.value.any { it.id == connectionId && it.signInRequired } -> AgentConnectionException.Reason.SignInRequired
                else -> AgentConnectionException.Reason.Unavailable
            })
        }
    }

    /** A screen shares a running bootstrap, but can ask for itself when no bootstrap can answer. */
    private suspend fun usesBootstrapHealth(): Boolean {
        val waiting = synchronized(healthLock) { checkSessionAllowed(); healthReady }
        val shared = waiting?.await() ?: false
        checkSessionAllowed()
        return shared
    }

    private fun beginHealth() = synchronized(healthLock) {
        if (!healthClosed) {
            healthStopped = false
            if (healthReady?.isCompleted != false) healthReady = CompletableDeferred()
        }
    }

    private fun finishHealth(shared: Boolean) = synchronized(healthLock) {
        healthReady?.complete(shared)
        if (!shared) healthReady = null
    }

    private fun stopHealth(closing: Boolean = false, terminal: Boolean = false) = synchronized(healthLock) {
        if (closing) healthClosed = true
        if (closing || terminal) healthStopped = true
        healthReady?.completeExceptionally(CancellationException("Agent session stopped"))
        healthReady = null
    }

    suspend fun takeChatRead(agentId: String): Pair<com.slopus.happy.conversation.Bootstrap, com.slopus.happy.conversation.MessagesPage>? {
        checkChatAllowed()
        chatStarting.first { !it }
        checkChatAllowed()
        val read = synchronized(chatLock) { chatRead?.takeIf { it.agentId == agentId && !it.taken }?.also { it.taken = true } } ?: return null
        return try { read.result.await().getOrThrow().also { (bootstrap, messages) ->
            synchronized(chatLock) { read.cursor = if (bootstrap.cursor != null && messages.cursor != null) minOf(bootstrap.cursor, messages.cursor) else null }
        } }
        catch (error: CancellationException) {
            // The engine can pause while this independently held conversation still wants history.
            currentCoroutineContext().ensureActive()
            checkChatAllowed()
            null
        }
    }

    fun chatNeedsResync(agentId: String, streamStart: String?): Boolean = synchronized(chatLock) {
        val read = chatRead?.takeIf { it.agentId == agentId } ?: return@synchronized true
        val firstHello = !read.helloSeen
        read.helloSeen = true
        // Only this opening's successfully delivered read can suppress its hello, with proven coverage.
        !(firstHello && streamStart != null && read.cursor?.let { streamStart <= it } == true)
    }

    suspend fun configuration(): com.slopus.happy.connection.TransportResponse {
        if (!usesBootstrapHealth()) return client.send("GET", "/v0/config")
        return configLock.withLock {
            if (bootstrapConfig == null) {
                val response = client.send("GET", "/v0/config")
                bootstrapConfig = (AgentClient.json.parseToJsonElement(response.text) as? JsonObject)?.get("config") as? JsonObject ?: JsonObject(emptyMap())
            }
            com.slopus.happy.connection.TransportResponse(200, body = buildJsonObject { put("config", bootstrapConfig ?: JsonObject(emptyMap())) }.toString().toByteArray())
        }
    }

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

    /** The server this connection is to, as it was when the session began; it never changes. */
    val server: String? = connections.accounts.value.firstOrNull { it.id == connectionId }?.server

    /**
     * What the person may do here: a Happy Cloud server's role, read on
     * every connect and `role.*` event; any other server gates nothing.
     */
    val permissions: StateFlow<ServerPermissions> =
        if (com.slopus.happy.connection.HappyCloud.isServer(server)) {
            AgentPermissionsSource({ client.decode<JsonObject>("GET", "/v0/permissions") }, events, scope).permissions
        } else {
            MutableStateFlow(ServerPermissions.Ungated).asStateFlow()
        }

    private val gitSnapshots = MutableStateFlow<Map<String, WorkspaceLineChanges>>(emptyMap())
    private val chatReads = MutableStateFlow(0)

    /** Only bookkeeping: chat reads are never held behind secondary work. */
    suspend fun <T> readChat(agentId: String, read: suspend () -> T): T {
        if (agentId != openChat()) return read()
        chatReads.update { it + 1 }
        try { return read() } finally { chatReads.update { it - 1 } }
    }

    private suspend fun awaitChatReads() { chatReads.first { it == 0 } }

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

    /** Whether home lists Plugins: bootstrap health's `capabilities.plugins`. */
    private val pluginsAvailability = keptCapability(com.slopus.happy.plugins.PluginsAvailability.RESOURCE)
    val pluginsAvailable: StateFlow<Boolean> get() = pluginsAvailability.available

    /** Whether home lists Pipelines: bootstrap health's `capabilities.pipelines`, never probed. */
    private val pipelinesAvailability = keptCapability(PIPELINES_AVAILABLE)
    val pipelinesAvailable: StateFlow<Boolean> get() = pipelinesAvailability.available

    /** Whether Settings lists Inference (the agent's accounts): bootstrap health's `capabilities.providerSignIn`, never probed. */
    private val providerSignInAvailability = keptCapability(PROVIDER_SIGN_IN_AVAILABLE)
    val providerSignInAvailable: StateFlow<Boolean> get() = providerSignInAvailability.available

    /** The provider accounts' sign-ins (Settings › Inference), made when a page first asks. */
    val providerAccounts: ProviderAccounts by lazy { ProviderAccounts(AgentProviderSignIns(client), events, scope) }

    /** A capability kept in the connection's resources under [resource], so home's row doesn't come and go on each start. */
    private fun keptCapability(resource: String) = CapabilityAvailability(
        probe = null,
        kept = { withContext(Dispatchers.IO) { (cachedResource(resource)?.get("available") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toBooleanStrictOrNull() } },
        keep = { value -> withContext(Dispatchers.IO) { keepResource(resource, JsonObject(mapOf("available" to kotlinx.serialization.json.JsonPrimitive(value)))) } },
        scope = scope,
    )

    /** A Happy Cloud server's onboarding gates for this person, which its flow over home follows; null on any other server. */
    val onboarding: com.slopus.happy.onboarding.OnboardingSource? =
        if (client.cloud) com.slopus.happy.onboarding.OnboardingSource({ com.slopus.happy.onboarding.OnboardingApi.read(client) }, events, active, scope) else null

    /** What Feed entries name that the catalog doesn't hold: artifacts, and the todos they made. */
    val feedLookups: FeedLookups by lazy {
        FeedLookups.of(scope, client, beforeNetwork = { checkSessionAllowed() }) { ArtifactClient(client).artifact(it) }.also { lookups ->
            scope.launch { events.collect(lookups::receive) }
        }
    }

    /** The pictures covered artifacts show as Feed posts, kept with the connection's media. */
    val feedCovers: FeedCovers by lazy { FeedCovers.of(ArtifactClient(client), media) }

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
        kept = { withContext(Dispatchers.IO) { cachedResource(TeamDirectory.RESOURCE) } },
        keep = { value -> withContext(Dispatchers.IO) { keepResource(TeamDirectory.RESOURCE, value) } },
    )

    /** Home's rows, derived off the main thread; equal rows keep their instances. */
    val feed: StateFlow<AgentFeed> = combine(
        catalogState, intents.pending, gitSnapshots,
        feedLibrary.state.map { if (it.available == true) it.unread else null }.distinctUntilChanged(),
        combine(team.users, pluginsAvailable, pipelinesAvailable, ::Triple),
    ) { catalog, pending, git, feedUnread, (users, plugins, pipelines) ->
        AgentFeed.derive(catalog.withSurfaceIntents(pending), git = git, intents = IntentOverlay.of(pending), feedUnread = feedUnread, users = users, plugins = plugins, pipelines = pipelines)
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

    /**
     * The person's model preferences, desktop's keys: what a new chat opens
     * on, which each new chat's first message moves ([recordStart]).
     */
    val modelPreferences: StateFlow<ModelPreferences> = catalogState
        .map { ModelPreferences.parse(it.settingValues) }
        .distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, ModelPreferences.parse(catalogState.value.settingValues))

    /** A new chat started on [mode] (desktop's `selectionStarted`): the keys that change go, each on its own. */
    fun recordStart(mode: Mode) = changeModelPreferences { it.started(mode) }

    /** Settings' New sessions start on. */
    fun setNewSessionStart(start: NewSessionStart) = changeModelPreferences { it.copy(start = start) }

    /** Settings' Default model: the model alone; its account stays the one picked last. */
    fun setDefaultModel(modelId: String) = changeModelPreferences { it.copy(defaultModelId = modelId) }

    /** Settings' Default effort, which every model runs where it can. */
    fun setDefaultEffort(effort: String) = changeModelPreferences { it.copy(defaultEffort = effort) }

    /** Settings' Default access mode. */
    fun setDefaultAccess(mode: String) = changeModelPreferences { it.copy(access = mode) }

    private fun changeModelPreferences(change: (ModelPreferences) -> ModelPreferences) {
        scope.launch {
            val current = ModelPreferences.parse(catalogState.value.settingValues)
            for ((key, value) in current.changes(change(current))) setSetting(key, value)
        }
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
        AgentUsageSource({ awaitBootstrap(); client.decode<JsonObject>("GET", "/v0/usage") }, events, scope) { accounts ->
            client.send("POST", "/v0/usage/refresh", buildJsonObject { put("providerIds", JsonArray(accounts.map(::JsonPrimitive))) })
        }
    }

    /** Whether [instanceId] is this connection's installation, as its health last said: its share links read as its own. */
    fun isHere(instanceId: String): Boolean = connections.accounts.value.firstOrNull { it.id == connectionId }?.instanceId == instanceId

    /** What the Happy references in this connection's messages read as, and the titles and names they need read. */
    val references: com.slopus.happy.references.ReferenceReader by lazy {
        com.slopus.happy.references.ReferenceReader(
            scope, catalog, events,
            readArtifact = { checkSessionAllowed(); ArtifactClient(client).artifact(it) },
            readUsers = { checkSessionAllowed(); team.names(it.toSet()) },
        )
    }
    /**
     * The connection's todo lists, kept on the phone and changed offline
     * first; made with the session so changes kept from an earlier run go
     * out once the link is up, whether or not a list is opened.
     */
    val todos: com.slopus.happy.todos.TodoLibrary = com.slopus.happy.todos.connectionTodos(this, client, scope)

    /** The connection's vaults: their routes, live events and the uploads in flight, which outlive the screen that started them. */
    val vaults: com.slopus.happy.vaults.Vaults by lazy {
        com.slopus.happy.vaults.Vaults(
            client, events, scope,
            kept = { key -> kotlinx.coroutines.withContext(Dispatchers.IO) { cachedResource(key) } },
            keep = { key, value -> kotlinx.coroutines.withContext(Dispatchers.IO) { keepResource(key, value) } },
        )
    }

    /** Whether the computer takes message attachments, as this connection's first upload found. */
    val attachmentRoute = com.slopus.happy.conversation.AttachmentRoute()

    /** Bots' pictures, as home's rows draw them. */
    /** Chat media kept on this phone for good, beside the catalog (iOS `MediaLibrary.agent`); null where nothing is kept. */
    val media: com.slopus.happy.media.MediaLibrary? = cacheFile?.let { com.slopus.happy.media.MediaLibrary(File(it.parentFile, it.nameWithoutExtension + ".media")) }

    /**
     * The document Surfaces open here and those with changes still to send
     * (iOS's `SyncEngine.documents`), kept beside the catalog in
     * `<connection>.documents/`; their live frames come off this session's stream.
     */
    val documents = DocumentLibrary(client, cacheFile?.let { File(it.parentFile, it.nameWithoutExtension + ".documents") }, scope)

    /** Who else is on the conversations and Surfaces this phone shows. */
    val viewers = Viewers(scope, AgentViewersBackend(client))

    val artifacts = com.slopus.happy.artifacts.ArtifactCatalogFeed(
        scope, fetch = { cursor -> ArtifactClient(client).catalog(cursor) },
        fetchOne = { id -> ArtifactClient(client).artifact(id) },
        kept = { cachedResource(com.slopus.happy.artifacts.ArtifactCatalogFeed.RESOURCE) },
        keep = { keepResource(com.slopus.happy.artifacts.ArtifactCatalogFeed.RESOURCE, it) },
    )

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

    /**
     * Moves a project's chat [agentId] after [afterId] in [owner]'s list, or
     * first when it is null (desktop's tab strip): the one order every
     * device shows. Its row stands there at once and goes back only if the
     * computer refuses.
     */
    suspend fun reorder(agentId: String, afterId: String?, owner: String): Intent =
        intents.enqueue(Intent.REORDER, agentId, buildJsonObject { put("kind", "agent"); put("owner", owner); put("afterId", afterId) })

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
                Intent.REORDER -> {
                    // Each move names the chat it goes after and takes the moves made before it as
                    // done: the outbox sends none before them ([Intent.waitsFor]).
                    val afterId = (intent.value["afterId"] as? JsonPrimitive)?.contentOrNull
                    val body = client.decode<JsonObject>("POST", "/v0/agents/$id/reorder", buildJsonObject { put("afterId", afterId); put("mutationId", intent.id) })
                    // Where the computer put it, before the owner's event lists it again.
                    (body["agent"] as? JsonObject)?.let { agent -> catalogLock.withLock { catalogState.update { it.withMoved(agent) } } }
                }
                else -> throw IntentRefusal("")
            }
        } catch (e: AgentApiException) {
            if (Permission.refused(e.status, e.code, e.message)) throw IntentRefusal(IntentRefusal.FORBIDDEN)
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

    /** Each agent's one conversation, for whoever shows or follows it ([HeldConversations]). */
    val conversations = HeldConversations(scope)

    /** Where the reader left each agent's conversation, to open on again; read and kept on the main thread. */
    val scrollPlaces = HashMap<String, ScrollPlace>()

    init {
        scope.coroutineContext[Job]!!.invokeOnCompletion { stopHealth(closing = true) }
        scope.coroutineContext[Job]?.invokeOnCompletion { chatStarting.value = false }
        intents.handle(setOf(Intent.READ, Intent.ARCHIVE, Intent.LEAVE, Intent.RENAME, Intent.REORDER, SURFACE_JOIN), ::deliver)
        feedLibrary.start()
        // Disk and journal here; startSecondary owns the once-per-connect catalog read.
        artifacts.start(events, verified = flowOf(false))
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
            var restored = false
            suspend fun restoreCache() {
                if (restored) return
                val span = Timing.begin("link.cache")
                traced("AgentSession.readCache") { readCache() }?.let { cached -> catalogLock.withLock { catalogState.update { if (it.loaded) it else cached } } }
                span.end("bytes=${cacheFile?.length() ?: 0}")
                restored = true
            }
            // A team server that wants signing in again (a refused refresh) stops the link at once,
            // even with its event stream still open, and it resumes from its cursor after.
            val signedIn = connections.accounts.map { list -> list.none { it.id == connectionId && it.signInRequired } }.distinctUntilChanged()
            // A redial ([networkReturned], [networkMoved]) starts the link over, as iOS's `SyncEngine.reconnect` pauses and starts it.
            combine(active.distinctUntilChanged(), signedIn, redials, ::Triple).collectLatest { (on, signedIn) ->
                linking = on && signedIn
                if (!linking) {
                    chatStarting.value = false
                    if (signedIn) finishHealth(false) else stopHealth()
                    restoreCache()
                }
                when {
                    !signedIn -> statusState.value = AgentLinkStatus.SignInRequired
                    // Off the collector: Tailcat's reads block their thread, and on the collector's
                    // they would hold up the next value, so a background could not stop the link.
                    on -> try { coroutineScope {
                        launch {
                            Timing.mark("link.start", "suspended=${suspended.get()}")
                            beginHealth()
                            // Bring up the shared query/stream tunnel while the kept catalog loads.
                            val warmAsked = CompletableDeferred<Unit>()
                            val warming = launch {
                                try { client.warm(2) { warmAsked.complete(Unit) } }
                                catch (e: CancellationException) { throw e }
                                catch (_: Exception) { /* Warming is best effort; the stream reports a refusal. */ }
                                finally { warmAsked.complete(Unit) }
                            }
                            try {
                                warmAsked.await()
                                restoreCache()
                                // Kept through a background: its tunnels check every way to the
                                // agent before the stream asks them for anything.
                                if (suspended.getAndSet(false)) {
                                    val span = Timing.begin("link.resume")
                                    linkLock.withLock { route?.second }?.resumed()
                                    span.end()
                                }
                                live()
                            } finally { warming.cancel() }
                        }
                    } } finally { phaseState.value = SyncPhase.Offline }
                    statusState.value == AgentLinkStatus.SignInRequired -> statusState.value = AgentLinkStatus.Connecting
                }
            }
        }.invokeOnCompletion { chatStarting.value = false }
        scope.launch {
            settingsQueued.receiveAsFlow().collect { deliverSettings() }
        }
        if (cacheFile != null) {
            // Loading can beat this collector. Its first value may already be a home to keep.
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                catalogState.cacheSnapshots().collect { writeCache(it) }
            }
        }
    }

    /**
     * The phone has a network again (iOS's `SyncEngine.reconnect`): a link
     * not live starts over now, not when its backoff says, and an attempt
     * made without a network is dropped.
     */
    fun networkReturned() {
        Timing.mark("net.returned")
        // Every tunnel kept checks its relay and every path first, replacing only what doesn't answer.
        scope.launch {
            linkLock.withLock { route?.second }?.networkChanged()
            if (!linking || statusState.value != AgentLinkStatus.Connecting) return@launch
            redials.update { it + 1 }
        }
    }

    /**
     * The phone's way out moved to another network, Wi-Fi to cellular
     * (iOS's `SyncEngine.moved`): the stream went out the old way, where it
     * can hang with nothing said until its 40-second silence while home
     * says connected. A running link lets go of the stream's tunnel and the
     * queries' shared main client, and starts
     * over at once, from its cursor, saying connecting until the stream
     * answers; every other tunnel is checked as on a return. A check passes
     * while the old way still answers, and that read then hung with it
     * (13 s, emulator, Wi-Fi silenced a second after the switch).
     */
    fun networkMoved() {
        Timing.mark("net.moved")
        scope.launch {
            val transport = linkLock.withLock { route?.second }
            val status = statusState.value
            if (linking && (status == AgentLinkStatus.Connected || status == AgentLinkStatus.Connecting)) {
                statusState.value = AgentLinkStatus.Connecting
                // Before the redial, so it asks new tunnels, not ones that went out the old way.
                transport?.reset(RequestCategory.Realtime)
                transport?.reset(RequestCategory.Query)
                redials.update { it + 1 }
            }
            transport?.networkChanged()
        }
    }

    /**
     * The app went to the background (iOS's `AgentConnections.suspended`):
     * the next time the link runs, open now or later, its tunnels are
     * resumed first ([Transport.resumed]). Not on a cold start.
     */
    fun backgrounded() = suspended.set(true)

    /** Stops the link and lets go of the tunnel. */
    suspend fun close() {
        stopHealth(closing = true)
        chatStarting.value = false
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
        var firstConnect = true
        while (true) {
            val alreadyWarmed = firstConnect
            firstConnect = false
            awaitSignedIn()
            beginHealth()
            if (statusState.value != AgentLinkStatus.Connected) statusState.value = AgentLinkStatus.Connecting
            // The sign-in this attempt runs under: a refusal it meets signs out only that one.
            val grant = connections.grant(connectionId)
            if (!chatStartUsed) { chatStartUsed = true; chatStarting.value = true }
            try {
                coroutineScope {
                    val cursor = catalogState.value.cursor?.takeIf {
                        resumeAllowed && catalogState.value.loaded && lastHeard?.let { clock() - it in 0 until 30_000L } == true
                    }
                    if (cursor == null) resumeAllowed = false
                    val owner = this
                    val streamAsked = CompletableDeferred<Unit>()
                    val opening = async {
                        val span = Timing.begin("link.stream")
                        try { client.events(cursor) { streamAsked.complete(Unit) }.also { span.end("cursor=${cursor != null}") } }
                        finally { streamAsked.complete(Unit) }
                    }
                    streamAsked.await()
                    val chat = synchronized(chatLock) {
                        chatRead = null
                        chatScope = owner
                        openChat()?.let { prepareChat(it, owner) }
                    }
                    chatStarting.value = false
                    if (!alreadyWarmed) launch { client.warm(2) }
                    val stream = opening.await()
                    phaseState.value = SyncPhase.P0Connecting
                    val snapshot = async {
                        chat?.asked?.forEach { it.await() }
                        if (cursor == null) readSnapshot()
                    }
                    follow(stream, snapshot, resumed = cursor != null) { backoff = INITIAL_BACKOFF }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentConnectionException) {
                when (e.reason) {
                    AgentConnectionException.Reason.Revoked -> {
                        stopHealth(terminal = true)
                        statusState.value = AgentLinkStatus.Revoked
                        connections.update(connectionId) { it.copy(revoked = true) }
                        return
                    }
                    AgentConnectionException.Reason.UpdateRequired -> {
                        stopHealth(terminal = true)
                        statusState.value = AgentLinkStatus.UpdateRequired
                        return
                    }
                    AgentConnectionException.Reason.SignInRequired, AgentConnectionException.Reason.ProfileRequired -> {
                        stopHealth()
                        val profile = e.reason == AgentConnectionException.Reason.ProfileRequired
                        connections.signedOut(connectionId, profile, grant)
                        backoff = INITIAL_BACKOFF
                        continue
                    }
                    else -> reconnecting()
                }
            } catch (e: AgentApiException) {
                // A 409 cursor_unavailable or any refused read: read the snapshot again.
                lastHeard = null
                reconnecting()
            } catch (_: Exception) {
                reconnecting()
            } finally {
                chatStarting.value = false
                intents.setOnline(false)
                synchronized(chatLock) { chatScope = null }
                phaseState.value = SyncPhase.Offline
            }
            delay(backoff + (backoff * JITTER * (random.nextDouble() * 2 - 1)).toLong())
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF)
        }
    }

    /**
     * An attempt failed, however it failed: the link is asked again with
     * backoff for as long as it is open, so it is on its way back, as a Happy
     * account's socket is (iOS's `HomeSnapshot.reconnecting`). No link is
     * ever offline: its headers say connecting.
     */
    private fun reconnecting() {
        finishHealth(false)
        statusState.value = AgentLinkStatus.Connecting
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

    private suspend fun bootstrapIdentity(bootstrap: WireDesktopBootstrap) {
        val known = connections.accounts.value.firstOrNull { it.id == connectionId }
        val info = AgentIdentity.bootstrap(bootstrap.health, bootstrap.config, known?.name.orEmpty())
        bootstrapConfig = bootstrap.config ?: JsonObject(emptyMap())
        client.noteHealth(bootstrap.health ?: JsonObject(emptyMap()))
        pluginsAvailability.noteHealth(info.plugins)
        pipelinesAvailability.noteHealth(info.pipelines)
        providerSignInAvailability.noteHealth(info.providerSignIn)
        avatarHash = info.thumbhash?.takeIf { it != known?.thumbhash || known.avatarFile == null }
        if (known != null) {
            val hasNode = bootstrap.config?.get("node") is JsonObject
            connections.update(connectionId, info.avatar) { it.copy(name = info.name, thumbhash = if (hasNode) info.thumbhash else it.thumbhash, revoked = false, instanceId = info.instanceId ?: it.instanceId, daemonVersion = info.daemonVersion ?: it.daemonVersion, protocol = info.protocol ?: it.protocol) }
        }
    }

    private suspend fun readSnapshot() {
        reads.update { it + 1 }
        val span = Timing.begin("link.snapshot")
        val response = com.slopus.happy.connection.ResponseTiming()
        try {
            val bootstrap = withContext(response) { client.decode<WireDesktopBootstrap>("GET", "/v0/bootstrap/desktop") }
            val decoded = Timing.now()
            val owner = connections.accounts.value.firstOrNull { it.id == connectionId }?.userId
            if (owner != null && bootstrap.profile?.string("userId") != owner) {
                throw AgentConnectionException(AgentConnectionException.Reason.SignInRequired)
            }
            bootstrapIdentity(bootstrap)
            team.bootstrap(bootstrap.teammates, bootstrap.profile)
            catalogLock.withLock { catalogState.update { it.withBootstrap(bootstrap) } }
            feedLibrary.bootstrap(bootstrap.feedUnread, bootstrap.cursor, bootstrap.health?.let(com.slopus.happy.feed.FeedCapabilities::of))
            span.end("send=${response.sent - span.startedAt} ${response.describe()} decode=${decoded - response.lastByte} apply=${Timing.now() - decoded}")
        } finally {
            reads.update { it - 1 }
        }
    }

    private val completions = CompletionWatch()

    /** The journal from the catalog's cursor until the stream ends or fails. */
    private suspend fun follow(stream: com.slopus.happy.connection.TransportStream, snapshot: Deferred<Unit>, resumed: Boolean, onConnected: () -> Unit): Unit = coroutineScope {
        var secondary: Job? = null
        try {
            val parser = ServerSentEventParser()
            while (true) {
                val bytes = stream.read() ?: throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
                lastHeard = clock()
                for (frame in parser.append(bytes)) {
                    // Live document frames go to their documents, never to the journal.
                    if (DocumentStreams.isDocumentFrame(frame.event)) {
                        documents.frame(frame.event, frame.data)
                        continue
                    }
                    if (frame.event == Viewers.FRAME) {
                        viewers.frame(frame.data)
                        continue
                    }
                    val event = frame.toAgentEvent() ?: continue
                    if (event.type == AgentEvent.HELLO) {
                        Timing.mark("link.hello")
                        documents.streams.opened(event.data)
                        feedLibrary.hello()
                        val wasVerified = phaseState.value == SyncPhase.Verified
                        val hello = AgentHello.of(event)
                        helloDaemon = hello.daemonId
                        drainingState.value = hello.draining
                        statusState.value = AgentLinkStatus.Connected
                        phaseState.value = SyncPhase.P0Live
                        viewers.opened(event.data.string("streamId"))
                        snapshot.await()
                        if (hello.gap && (resumed || wasVerified)) readSnapshot()
                        resumeAllowed = true
                        phaseState.value = SyncPhase.Verified
                        Timing.mark("link.verified", "resumed=$resumed")
                        finishHealth(true)
                        intents.setOnline(true)
                        if (catalogState.value.pendingSettings.isNotEmpty()) settingsQueued.trySend(Unit)
                        secondary?.cancel()
                        secondary = launch { startSecondary() }
                        avatarHash?.let { hash ->
                            avatarHash = null
                            scope.launch {
                                val avatar = AgentIdentity.avatar(client.requester, null, client.isOAuth())
                                connections.update(connectionId, avatar) { it.copy(thumbhash = hash) }
                            }
                        }
                        onConnected()
                    } else {
                        if (event.type == "daemon.draining" && event.data["draining"]?.toString() != "false") {
                            val from = event.data.string("daemonId")
                            if (from == null || helloDaemon == null || from == helloDaemon) drainingState.value = true
                        }
                        snapshot.await()
                        if (event.type == "config.updated") bootstrapConfig = null
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
            secondary?.cancel()
            documents.closed()
            viewers.closed()
            feedLibrary.disconnected()
            stream.close()
        }
    }

    /** Delivery is already allowed at Verified. Each read stage follows the previous one. */
    private suspend fun startSecondary() {
        awaitChatReads()
        feedLibrary.connected().join()
        awaitChatReads()
        artifacts.refresh().join()
        awaitChatReads()
        val ids = gitWorkspaceIds(feed.value)
        readGit(ids)
        awaitChatReads()
        documents.resumeUnsent()
        watchGit(ids)
    }

    /**
     * A profile changed (iOS `profileChanged`, `authorChanged`): standalone,
     * the event carries it ([AgentCatalog.apply]); in a team it only names
     * who, so the person's own is read again and another member's face too.
     */
    private fun profileChanged(event: AgentEvent) {
        if (event.data["profile"] is JsonObject) return
        val id = event.data.string("userId") ?: return
        if (id != catalogState.value.userId) {
            scope.launch { reread(AgentCatalog.Stale(AgentCatalog.Stale.SNAPSHOT, "")) }
            return
        }
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
    private suspend fun readGit(ids: Set<String>) {
        if (client.cloud) return
        gitSnapshots.update { it.filterKeys(ids::contains) }
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
    }

    private suspend fun watchGit(initialIds: Set<String>) {
        // Happy Cloud has no folders, so no git.
        if (client.cloud) return
        var previous = initialIds
        combine(feed.map(::gitWorkspaceIds).distinctUntilChanged(), phase) { ids, phase ->
            ids to (phase == SyncPhase.Verified)
        }.distinctUntilChanged().collectLatest { (ids, connected) ->
            if (!connected) return@collectLatest
            if (ids != previous) { awaitChatReads(); readGit(ids) }
            previous = ids
            while (true) {
                delay(30_000)
                awaitChatReads()
                readGit(ids)
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
        // Happy Cloud has no folders to read.
        if (stale.kind == "workspace" && client.cloud) return
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
            if (phaseState.value != SyncPhase.Verified) return
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
     * Search's daemon half for [query] (`POST /v0/search`); null
     * where health hasn't said the daemon has it, and the phone's own
     * results stand alone.
     */
    suspend fun search(query: String): com.slopus.happy.search.SearchAnswer? =
        if (client.search) com.slopus.happy.search.SearchClient(client).search(query) else null

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
        /** Where the connection keeps whether it has pipelines. */
        const val PIPELINES_AVAILABLE = "pipelines-available"
        /** Where the connection keeps whether its accounts sign in here. */
        const val PROVIDER_SIGN_IN_AVAILABLE = "provider-sign-in-available"

        /** Surface events that come together read the snapshot once. */
        const val SNAPSHOT_COALESCE = 300L
        const val INITIAL_BACKOFF = 1_000L

        /** How long a refusal stays in home's notice (iOS SyncEngine's 5 s). */
        const val NOTICE_MILLIS = 5_000L
        const val MAX_BACKOFF = 5_000L
        const val JITTER = 0.5
    }
}
