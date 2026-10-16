package com.slopus.happy.ui.home

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentServices
import com.slopus.happy.attachments.AttachmentUploadResult
import com.slopus.happy.attachments.readAttachmentBytes
import com.slopus.happy.diagnostics.ClientLogs
import com.slopus.happy.model.Machine
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.SessionListInputs
import com.slopus.happy.model.buildSessionListViewData
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.worktreeTabSuccessor
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.session.SessionInfoLive
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.model.Session
import com.slopus.happy.model.Settings
import com.slopus.happy.model.WorkspaceOrigin
import com.slopus.happy.model.forkSource
import com.slopus.happy.model.parseJsonObject
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SendException
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.sync.SendResult
import com.slopus.happy.ui.files.SessionChangesRoute
import com.slopus.happy.ui.session.DuplicateSheet
import com.slopus.happy.ui.session.LiveSessionContinuations
import com.slopus.happy.ui.session.SessionContinuations
import com.slopus.happy.ui.session.SessionInfoActions
import com.slopus.happy.ui.session.SessionInfoControls
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.session.SessionInfoScreen
import androidx.compose.runtime.produceState
import kotlinx.coroutines.withContext
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.projects.GitStatusServices
import com.slopus.happy.projects.ProjectServices
import com.slopus.happy.projects.SessionAvatarServices
import com.slopus.happy.net.HappyJson
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.MachineOps
import com.slopus.happy.sync.MachinePresence
import com.slopus.happy.sync.SessionPresence
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.sync.SyncEngine
import com.slopus.happy.ui.machine.LiveMachineControls
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.machine.MachineScreen
import com.slopus.happy.ui.machine.MachineScreenActions
import com.slopus.happy.ui.machine.recentMachineSessions
import com.slopus.happy.ui.onboarding.LinkComputerChecklist
import com.slopus.happy.ui.onboarding.OnboardingLinkComputer
import com.slopus.happy.ui.onboarding.OnboardingSettingsRoute
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.changelog.Changelog
import com.slopus.happy.ui.settings.AppearanceRoute
import com.slopus.happy.ui.settings.ChangelogRoute
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.AvatarSettings
import com.slopus.happy.ui.components.AvatarStyle
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.LocalAvatarSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.util.WeakHashMap
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.Flow
import com.slopus.happy.resume.ResumeOutcome
import com.slopus.happy.resume.ResumeTexts
import com.slopus.happy.resume.SessionResumer
import com.slopus.happy.resume.rememberResumeTexts

/**
 * The home screens' long-lived state, one per [AppGraph]: the list derived
 * in the background and kept warm between visits, the archive in flight,
 * and the store-version check.
 */
class HomeServices private constructor(private val graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val account = graph.account
    private val store = graph.store
    private val settings = graph.settings.settings

    val sessionActions: SessionActions = LiveSessionActions { account.value?.sessionOps }
    val archiver = SessionArchiver(sessionActions)

    /** Resume, fork and spawn; null while signed out. */
    val machineOps: MachineOps? get() = account.value?.machineOps

    val continuations: SessionContinuations =
        LiveSessionContinuations({ account.value?.machineOps }, SessionResumer.of(graph)) { SessionResumer.ops(graph) }

    val infoControls: SessionInfoControls = object : SessionInfoControls {
        override suspend fun archive(session: Session): ArchiveResult = archiver.archive(session)

        override suspend fun delete(session: Session): OpResult {
            // Best effort: a running agent would otherwise keep writing into a deleted session.
            if (session.isOnline) sessionActions.kill(session.id)
            return sessionActions.delete(session.id)
        }

        override suspend fun cleanupWorktree(session: Session, confirm: suspend () -> Boolean) = this@HomeServices.cleanupWorktree(session, confirm)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    val snapshots: StateFlow<HomeSnapshot?> = graph.account
        .flatMapLatest { account ->
            homeSnapshots(
                graph.store,
                account?.presence?.sessions ?: flowOf(emptyMap<String, SessionPresence>()),
                account?.presence?.machines ?: flowOf(emptyMap<String, MachinePresence>()),
                // A full session listing has been stored once: every sync after the first.
                synced = (account?.isSyncing ?: flowOf(false))
                    .map { graph.store.cursor(SyncEngine.CURSOR_SESSIONS_LISTED_AT) != null }
                    .flowOn(Dispatchers.IO),
                projects = ProjectServices.of(graph).projects,
                sessionAvatars = SessionAvatarServices.of(graph).avatars,
                gitStatuses = GitStatusServices.of(graph).statuses,
                // storage.ts updateSessionDraft: a blank draft is no draft.
                drafts = account?.composer?.mirrors
                    ?.map { mirrors -> mirrors.mapNotNull { (id, mirror) -> mirror.draft?.takeIf { it.isNotBlank() }?.let { id to it } }.toMap() }
                    ?: flowOf(emptyMap()),
            )
        }
        .stateIn(scope, SharingStarted.Eagerly, null)

    /** Unread chats and the chat on screen ([SessionViewingEffect]); per account, in memory. */
    val reads = SessionReadState()

    val list = HomeListModel(
        snapshots = snapshots,
        settings = graph.settings.settings,
        localSettings = graph.localSettings.values,
        unreadSessionIds = reads.unreadSessionIds,
        archivingSessionIds = archiver.archiving,
        scope = scope,
    )

    private val update = MutableStateFlow<String?>(null)

    /** The store page of a required native update (UpdateBanner's first case). */
    val updateUrl: StateFlow<String?> = update.asStateFlow()

    init {
        scope.launch {
            var account: AccountSync? = null
            graph.account.collect { next -> if (next !== account) { account = next; reads.reset() } }
        }
        scope.launch { snapshots.collect { snapshot -> if (snapshot != null) reads.observe(snapshot.sessions) } }
        scope.launch {
            nativeUpdateChecks(graph.isForeground) { checkNativeUpdate(graph.http, BuildConfig.APPLICATION_ID, BuildConfig.VERSION_NAME) }
                .collect { update.value = it }
        }
    }

    fun session(id: String): Session? = snapshots.value?.sessions?.find { it.id == id }

    fun machine(id: String?): Machine? = id?.let { machineId -> snapshots.value?.machines?.find { it.id == machineId } }

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    /** maybeCleanupWorktree over the session's machine shell, against the chats active now. */
    suspend fun cleanupWorktree(session: Session, confirm: suspend () -> Boolean) {
        val ops = machineOps ?: return
        val active = snapshots.value?.sessions.orEmpty().filter { it.active }
        maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId, active, ops::bash, confirm)
    }

    /** useWorktreeTabSuccessor, read now: the archived chat's neighbouring tab in the project layout. */
    fun tabSuccessor(sessionId: String): String? {
        val grouping = settings.value.sessionListGrouping
        if (grouping != SessionListGrouping.Project) return null
        val snapshot = snapshots.value ?: return null
        val inputs = SessionListInputs(
            snapshot.sessions,
            snapshot.machines.associateBy { it.id },
            snapshot.projects,
            archivingSessionIds = archiver.archiving.value,
            gitStatuses = snapshot.gitStatuses,
        )
        return worktreeTabSuccessor(buildSessionListViewData(inputs), sessionId, grouping)
    }

    private var newSessionServices: NewSessionServices? = null

    /** pendingChats.ts: chats opened from a tab strip's `+` that no machine has answered for yet. */
    val pendingChats = PendingChatStore()

    private val pendingFailures = MutableStateFlow<String?>(null)

    /** A strip start that failed, in its own words, until the screen has shown it. */
    val pendingChatFailure: StateFlow<String?> = pendingFailures.asStateFlow()

    fun dismissPendingChatFailure() {
        pendingFailures.value = null
    }

    val pendingChatHandover = PendingChatHandover(
        pendingChats,
        object : PendingChatSessions {
            override suspend fun send(sessionId: String, text: String): Boolean {
                val sender = account.value?.sender ?: return false
                return when (val result = sender.send(sessionId, text, SendOptions(source = "new_session"))) {
                    is SendResult.Accepted -> true
                    is SendResult.NotSent -> result.message?.let { throw SendException(it) } ?: false
                }
            }

            override fun draft(sessionId: String): String? = account.value?.composer?.mirrors?.value?.get(sessionId)?.draft

            override suspend fun writeDraft(sessionId: String, text: String) {
                account.value?.composer?.setText(sessionId, text)
            }

            override fun exists(sessionId: String): Boolean = session(sessionId) != null

            override fun alert(message: String) {
                pendingFailures.value = message
            }
        },
    )

    /** Where each checkout's tab strip was scrolled to (first item, offset), across the screens that show it. */
    val stripOffsets = java.util.concurrent.ConcurrentHashMap<String, Pair<Int, Int>>()

    private var pendingChatStarter: PendingChatStarter? = null

    /** The tab strip's `+`, starting with the new-session [SessionStarter] one start at a time. */
    @Synchronized
    fun pendingChatStarter(context: Context): PendingChatStarter = pendingChatStarter ?: run {
        val starter = newSession(context).starter
        PendingChatStarter(
            pendingChats,
            pendingChatHandover,
            scope,
            start = { request -> starter.start(request.draft, target = request.target) { false } },
            failed = { pendingFailures.value = it },
        )
    }.also { pendingChatStarter = it }

    /** The new-session composer, its draft in the app's own preferences. */
    @Synchronized
    fun newSession(context: Context): NewSessionServices = newSessionServices ?: run {
        val drafts = NewSessionDraftStore(context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE))
        val machineActions = LiveMachineActions { account.value?.machineOps }
        val starter = SessionStarter(
            machines = { snapshots.value?.machines.orEmpty() },
            sessions = { snapshots.value?.sessions.orEmpty() },
            settings = { settings.value },
            drafts = drafts,
            machineActions = machineActions,
            sessionActions = sessionActions,
            sender = LiveFirstMessageSender(
                account = { account.value },
                metadata = { id -> withContext(Dispatchers.IO) { store.session(id)?.metadataJson?.let(SessionMetadata::parse) } },
                upload = { id, images ->
                    AttachmentServices.of(graph).transfers?.upload(id, images, ::readAttachmentBytes) ?: AttachmentUploadResult(emptyList(), images.size)
                },
            ),
            awaitSession = ::awaitSession,
            scope = scope,
        )
        val resources = context.resources
        NewSessionServices(drafts, snapshots, settings, machineActions, starter, newSessionLabels(resources), resources::getString, scope)
    }.also { newSessionServices = it }

    /** sync.ts ensureSessionReady: the new session's row in the store, pulled in by a sync if need be. */
    private suspend fun awaitSession(id: String): Boolean {
        suspend fun stored() = withContext(Dispatchers.IO) { store.session(id) != null }
        var attempt = 0
        while (!stored() && attempt < 3) {
            if (attempt > 0) delay(300L * attempt)
            account.value?.let { withTimeoutOrNull(4_000) { it.syncNow() } }
            attempt++
        }
        return stored()
    }

    companion object {
        private val instances = WeakHashMap<AppGraph, HomeServices>()

        @Synchronized
        fun of(graph: AppGraph): HomeServices = instances.getOrPut(graph) { HomeServices(graph) }
    }
}

/**
 * sync.ts's nativeUpdateSync: [check] now, then again on every return to the
 * foreground; a newer check replaces one still running.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun nativeUpdateChecks(foreground: StateFlow<Boolean>, check: suspend () -> String?): Flow<String?> =
    foreground.drop(1).filter { it }.map { }.onStart { emit(Unit) }.mapLatest { check() }

/**
 * sync.ts fetchNativeUpdate: POST /v1/version with this build; the store
 * URL when the server says an update is required, else null (also on any
 * failure: the banner is a nicety).
 */
suspend fun checkNativeUpdate(http: HappyHttp, appId: String, version: String): String? = try {
    val body = JsonObject(mapOf("platform" to JsonPrimitive("android"), "version" to JsonPrimitive(version), "app_id" to JsonPrimitive(appId)))
    val response = http.post("/v1/version", body, JsonObject.serializer(), JsonObject.serializer())
    val required = response["update_required"]?.jsonPrimitive?.booleanOrNull == true
    response["update_url"]?.jsonPrimitive?.contentOrNull?.takeIf { required && it.isNotEmpty() }
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}

/** Where the home list's taps lead: the same for the phone home and the tablet sidebar. */
class HomeNavigation(
    val onSettings: () -> Unit,
    val onAppearance: () -> Unit,
    val onWhatsNew: () -> Unit,
    val onOnboardingSettings: () -> Unit,
    val onOpenSession: (String) -> Unit,
    val onOpenMachine: (String) -> Unit,
    val onTroubleshoot: () -> Unit,
    val onNewSession: () -> Unit,
    val onDetails: (String) -> Unit,
) {
    companion object {
        fun of(nav: NavHostController, onOpenSession: (String) -> Unit, onTroubleshoot: () -> Unit) = HomeNavigation(
            onSettings = { nav.navigate(SettingsRoute) },
            onAppearance = { nav.navigate(AppearanceRoute) },
            onWhatsNew = { nav.navigate(ChangelogRoute) },
            onOnboardingSettings = { nav.navigate(OnboardingSettingsRoute) },
            onOpenSession = onOpenSession,
            onOpenMachine = { id -> nav.navigate(MachineRoute(id)) },
            onTroubleshoot = onTroubleshoot,
            onNewSession = { nav.navigate(NewSessionRoute) },
            onDetails = { id -> nav.navigate(SessionInfoRoute(id)) },
        )
    }
}

/**
 * Set by the tablet shell while its sidebar holds the session list: the home
 * route then leaves the detail blank (MainView.tsx's `isTablet` branch).
 */
val LocalHomeInSidebar = staticCompositionLocalOf { false }

/** The home routes. [onOpenSession] belongs to the chat, [onTroubleshoot] to onboarding. */
fun NavGraphBuilder.homeRoutes(
    graph: AppGraph,
    nav: NavHostController,
    onOpenSession: (sessionId: String) -> Unit = {},
    onTroubleshoot: () -> Unit = {},
) {
    composable<HomeRoute> {
        if (LocalHomeInSidebar.current) {
            Box(Modifier.fillMaxSize().background(HappyTheme.colors.grouped.background).testTag(HomeTags.TABLET_BLANK))
        } else {
            HomeListHost(graph, remember(nav) { HomeNavigation.of(nav, onOpenSession, onTroubleshoot) }, withDock = true) { host ->
                HomeScreen(
                    state = host.state,
                    connectionStatus = host.connectionStatus,
                    grouping = host.grouping,
                    callbacks = host.callbacks,
                    actions = host.actions,
                    update = host.update,
                    linkContent = { OnboardingLinkComputer(graph, onSettings = host.navigation.onOnboardingSettings) },
                    offlineContent = { computers, onShowArchived ->
                        LinkComputerChecklist(graph, computers = computers, onTroubleshoot = host.navigation.onTroubleshoot, onShowArchived = onShowArchived)
                    },
                    dock = host.dock?.state,
                    dockActions = host.dock?.actions,
                )
            }
        }
    }
    composable<NewSessionRoute> {
        val dock = rememberNewSessionDock(
            graph,
            focused = true,
            onFocusChange = { focused -> if (!focused) nav.popBackStack() },
            onStarted = onOpenSession,
            initialPrompt = { HomeServices.of(graph).newSession(nav.context.applicationContext).draft.value.input },
        )
        NewSessionScreen(dock, onBack = { nav.popBackStack() })
    }
    composable<SessionInfoRoute> { entry ->
        SessionInfoRouteScreen(graph, entry.toRoute<SessionInfoRoute>().id, nav, onOpenSession)
    }
    composable<MachineRoute> { entry ->
        val id = entry.toRoute<MachineRoute>().id
        val services = remember(graph) { HomeServices.of(graph) }
        val snapshot by services.snapshots.collectAsStateWithLifecycle()
        val machine = snapshot?.machines?.find { it.id == id }
        val sessions = remember(snapshot?.sessions, id) { recentMachineSessions(snapshot?.sessions.orEmpty(), id) }
        val controls = remember(graph) { LiveMachineControls { graph.account.value } }
        val actions = remember(nav, onOpenSession) {
            MachineScreenActions(onBack = { nav.popBackStack() }, onOpenSession = onOpenSession, onDeleted = { nav.popBackStack() })
        }
        MachineScreen(machine, sessions, controls, actions)
    }
}

@Composable
private fun SessionInfoRouteScreen(graph: AppGraph, id: String, nav: NavHostController, onOpenSession: (String) -> Unit) {
    val services = remember(graph) { HomeServices.of(graph) }
    val snapshot by services.snapshots.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val session = snapshot?.sessions?.find { it.id == id }
    val machine = snapshot?.machines?.find { it.id == session?.metadata?.machineId }
    // The chat owns the typed agent state; this screen only counts and shows it.
    val agentState by produceState<JsonObject?>(null, session) {
        value = withContext(Dispatchers.IO) { parseJsonObject(graph.store.session(id)?.agentStateJson) }
    }
    // What the screen reads live: the checkout's git status and files, the session's picks.
    val account by graph.account.collectAsStateWithLifecycle()
    val git = remember(graph) { GitStatusServices.of(graph) }
    LaunchedEffect(git, id, account) { if (account != null) git.sessionVisible(id) }
    val statuses by git.statuses.collectAsStateWithLifecycle()
    val pathKey = gitStatusKey(session?.metadata?.machineId, session?.metadata?.path)
    val mirror by remember(account, id) { account?.composer?.mirror(id) ?: flowOf(ComposerMirror()) }.collectAsStateWithLifecycle(ComposerMirror())
    val live = SessionInfoLive(
        gitStatus = pathKey?.let(statuses::get),
        gitStatusFiles = pathKey?.let { account?.fileCache?.statusFiles(it)?.files },
        composer = mirror,
    )
    val context = LocalContext.current
    val actions = remember(nav, onOpenSession, context, services, id) {
        SessionInfoActions(
            onBack = { nav.popBackStack() },
            onOpenSession = onOpenSession,
            onOpenMachine = { machineId -> nav.navigate(MachineRoute(machineId)) },
            onChanges = { sessionId -> nav.navigate(SessionChangesRoute(sessionId)) },
            onArchived = { successor -> nav.leaveSessionInfo(id, successor, onOpenSession) },
            onDeleted = { nav.leaveSessionInfo(id, null, onOpenSession) },
            copyToClipboard = { text -> copyToClipboard(context, text) },
            tabSuccessor = services::tabSuccessor,
            // DuplicateSheet's replaceToSession: the copy takes this screen's place.
            onReplaceWithSession = { sessionId -> nav.navigate(SessionRoute(sessionId)) { popUpTo<SessionInfoRoute> { inclusive = true } } },
        )
    }
    SessionInfoScreen(
        session = session,
        ready = snapshot?.ready == true,
        agentState = agentState,
        machine = machine,
        continuationExperiments = settings.expResumeSession,
        debugBuild = BuildConfig.DEBUG,
        controls = services.infoControls,
        continuations = services.continuations,
        actions = actions,
        live = live,
    )
}

/**
 * info.tsx's exit after an archive or delete: leave session info, then the
 * chat behind it (`router.back()` twice), so the user lands where the chat
 * was opened from. With a [successor] (the checkout's neighbouring tab) the
 * chat is replaced by it instead. Opened from anywhere but its chat (the
 * home menu's Details), only session info goes, and a successor opens on top.
 */
internal fun NavHostController.leaveSessionInfo(sessionId: String, successor: String?, openSession: (String) -> Unit) {
    popBackStack()
    val top = currentBackStackEntry
    val chatBehind = top?.destination?.hasRoute<SessionRoute>() == true && top.toRoute<SessionRoute>().id == sessionId
    when {
        successor != null && chatBehind -> navigate(SessionRoute(successor)) { popUpTo<SessionRoute> { inclusive = true } }
        successor != null -> openSession(successor)
        chatBehind -> popBackStack()
    }
}

/** The synced avatar settings, for every avatar under [content]. */
@Composable
fun ProvideAvatarSettings(settings: Settings, content: @Composable () -> Unit) {
    val avatars = remember(settings.avatarStyle, settings.avatarMonochrome, settings.showFlavorIcons, settings.showHarnessIconInSessionHeader) {
        AvatarSettings(
            style = AvatarStyle.normalize(settings.avatarStyle),
            monochrome = settings.avatarMonochrome,
            showFlavorIcons = settings.showFlavorIcons,
            showHarnessIconInSessionHeader = settings.showHarnessIconInSessionHeader,
        )
    }
    CompositionLocalProvider(LocalAvatarSettings provides avatars, content = content)
}

/** What [HomeListHost] hands its content: the list's state and its wiring. */
class HomeListScope(
    val state: HomeListState?,
    val connectionStatus: ConnectionStatus,
    val grouping: SessionListGrouping,
    val callbacks: HomeListCallbacks,
    val actions: HomeScreenActions,
    val update: HomeUpdate?,
    val navigation: HomeNavigation,
    /** The phone home's new-session dock; null in the tablet sidebar. */
    val dock: NewSessionDock?,
)

/**
 * The home list's state, row callbacks, session menus and their alerts and
 * sheets, around [content]. [withDock] (the phone home) adds the new-session
 * dock, which a project's "+" opens on a new workspace; without it (the tablet
 * sidebar) "+" prepares the workspace and opens the new-session screen.
 */
@Composable
fun HomeListHost(graph: AppGraph, navigation: HomeNavigation, withDock: Boolean = false, content: @Composable (HomeListScope) -> Unit) {
    val onOpenSession = navigation.onOpenSession
    val services = remember(graph) { HomeServices.of(graph) }
    val state by services.list.state.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val connection by graph.connectionStatus.collectAsStateWithLifecycle()
    val updateUrl by services.updateUrl.collectAsStateWithLifecycle()
    val resources = LocalResources.current
    val latestChangelog = remember(resources) { Changelog.bundled(resources).latestTitle }
    val lastViewedChangelog by graph.changelog.lastViewedTitle.collectAsStateWithLifecycle()
    // useChangelog: a first install has seen everything so far; only what comes later is news.
    LaunchedEffect(latestChangelog) {
        if (graph.changelog.lastViewedTitle.value.isEmpty() && latestChangelog.isNotEmpty()) graph.changelog.markViewed(latestChangelog)
    }
    val update = HomeUpdate.resolve(updateUrl, lastViewedChangelog.isNotEmpty() && graph.changelog.hasUnread(latestChangelog))
    val uriHandler = LocalUriHandler.current
    var alert by remember { mutableStateOf<Alert?>(null) }
    val showAlert = remember { { next: Alert -> alert = next } }
    var duplicating by remember { mutableStateOf<Session?>(null) }
    val menus = rememberSessionMenus(
        services = services,
        continuationExperiments = settings.expResumeSession,
        devMode = BuildConfig.DEBUG || local.devModeEnabled,
        onOpenSession = onOpenSession,
        onDetails = navigation.onDetails,
        onDuplicate = { duplicating = it },
        showAlert = showAlert,
    )
    var dockFocused by rememberSaveable { mutableStateOf(false) }
    val dock = if (withDock) {
        rememberNewSessionDock(
            graph,
            focused = dockFocused,
            onFocusChange = { dockFocused = it },
            onStarted = onOpenSession,
            showScrim = state?.rows?.isNotEmpty() == true,
        )
    } else {
        null
    }
    val context = LocalContext.current
    // ProjectHomeList's "+": the dock (or the new-session screen) opens on a new workspace of that project.
    val onCreateWorkspace = remember(services, context, withDock, navigation) {
        { origin: WorkspaceOrigin ->
            services.newSession(context.applicationContext).prepareWorkspace(origin.machineId, origin.projectId, origin.path)
            if (withDock) dockFocused = true else navigation.onNewSession()
        }
    }
    val createWorkspaceLabel = stringResource(R.string.home_create_workspace)
    val cancelLabel = stringResource(R.string.common_cancel)

    val callbacks = remember(services, menus, navigation) {
        HomeListCallbacks(
            onOpen = onOpenSession,
            onMenu = menus::open,
            onArchive = menus::archive,
            onSetArchiveHidden = { hidden -> graph.settings.change { it.copy(hideInactiveSessions = hidden) } },
            onToggleProject = { id ->
                graph.localSettings.change { it.copy(expandedProjects = it.expandedProjects + (id to it.expandedProjects[id].let { open -> open != true })) }
            },
            onOpenMachine = navigation.onOpenMachine,
            onCreateWorkspace = onCreateWorkspace,
            onProjectMenu = { name, origin ->
                alert = Alert(name, null, listOf(AlertButton(cancelLabel), AlertButton(createWorkspaceLabel) { onCreateWorkspace(origin) }))
            },
        )
    }
    val actions = remember(navigation, uriHandler) {
        HomeScreenActions(
            onSettings = navigation.onSettings,
            onAppearance = navigation.onAppearance,
            onSetGrouping = { grouping -> graph.settings.change { it.copy(sessionListGrouping = grouping) } },
            onNewSession = navigation.onNewSession,
            onTroubleshoot = navigation.onTroubleshoot,
            onOpenUrl = uriHandler::openUri,
            onWhatsNew = navigation.onWhatsNew,
        )
    }

    ProvideAvatarSettings(settings) {
        content(HomeListScope(state, connection, settings.sessionListGrouping, callbacks, actions, update, navigation, dock))
    }
    dock?.dialogs?.invoke()
    duplicating?.let { session ->
        DuplicateSheet(
            source = session.forkSource(),
            continuations = services.continuations,
            onDismiss = { duplicating = null },
            onDuplicated = onOpenSession,
        )
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

/** The session alert and the archive, as the list's rows run them. */
class SessionMenus(
    private val services: HomeServices,
    private val buildMenu: (Session) -> Alert?,
    private val showError: (String?, Boolean) -> Unit,
    /** maybeCleanupWorktree's "Delete Worktree?". */
    private val confirmCleanup: suspend () -> Boolean = { false },
    /** On the press, before the machine is asked: a screen standing on the chat leaves first. */
    private val onBeforeArchive: (sessionId: String) -> Unit = {},
) {
    /** useSessionActionAlert: "Session", one button per action, then Cancel. */
    fun open(sessionId: String) {
        val session = services.session(sessionId) ?: return
        buildMenu(session)
    }

    /** useSessionArchiveAction: the same archive the menu runs. */
    fun archive(sessionId: String) {
        val session = services.session(sessionId) ?: return
        onBeforeArchive(sessionId)
        services.launch {
            val result = services.archiver.archive(session) { services.cleanupWorktree(session, confirmCleanup) }
            if (result is ArchiveResult.Failed) showError(result.message, result.bot)
        }
    }
}

@Composable
internal fun rememberSessionMenus(
    services: HomeServices,
    continuationExperiments: Boolean,
    devMode: Boolean,
    onOpenSession: (String) -> Unit,
    onDetails: ((String) -> Unit)?,
    onDuplicate: (Session) -> Unit,
    showAlert: (Alert) -> Unit,
    onBeforeArchive: (sessionId: String) -> Unit = {},
): SessionMenus {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val strings = SessionMenuStrings(
        title = stringResource(R.string.session_actions_title),
        details = stringResource(R.string.profile_details),
        resume = stringResource(R.string.session_info_resume_session),
        fork = stringResource(R.string.session_fork_action),
        duplicate = stringResource(R.string.session_duplicate_action),
        copyMetadata = stringResource(R.string.session_info_copy_metadata),
        cleanupTitle = stringResource(R.string.session_info_worktree_cleanup_title),
        cleanupMessage = stringResource(R.string.session_info_worktree_cleanup_message),
        cleanupDelete = stringResource(R.string.session_info_worktree_cleanup_delete),
        cleanupKeep = stringResource(R.string.session_info_worktree_cleanup_keep),
        archive = stringResource(R.string.session_archive_action),
        cancel = stringResource(R.string.common_cancel),
        error = stringResource(R.string.common_error),
        ok = stringResource(R.string.common_ok),
        archiveFailed = stringResource(R.string.session_info_failed_to_archive_session),
        botArchiveFailed = stringResource(R.string.home_bot_archive_offline),
        forkFailed = stringResource(R.string.session_fork_error_generic),
        resumeFailed = stringResource(R.string.session_info_resume_session_subtitle),
        blocks = mapOf(
            ResumeBlock.MissingMachine to stringResource(R.string.session_info_resume_session_missing_machine),
            ResumeBlock.MissingBackendId to stringResource(R.string.session_info_resume_session_missing_backend_id),
            ResumeBlock.SameMachineOnly to stringResource(R.string.session_info_resume_session_same_machine_only),
            ResumeBlock.MachineOffline to stringResource(R.string.session_info_resume_session_machine_offline),
        ),
        metadataCopied = stringResource(R.string.session_info_metadata_copied),
        success = stringResource(R.string.common_success),
        resumeTexts = rememberResumeTexts(),
    )
    return remember(services, continuationExperiments, devMode, onOpenSession, onDetails, onDuplicate, strings, context, scope, showAlert, onBeforeArchive) {
        fun error(message: String) = showAlert(Alert(strings.error, message, listOf(AlertButton(strings.ok))))

        // Resume and fork answer like a spawn; anything but a session is a failure here.
        fun spawned(result: SpawnSessionResult, fallback: String) = when (result) {
            is SpawnSessionResult.Success -> onOpenSession(result.sessionId)
            is SpawnSessionResult.Error -> error(result.errorMessage.ifEmpty { fallback })
            else -> error(fallback)
        }
        lateinit var menus: SessionMenus
        menus = SessionMenus(
            services = services,
            buildMenu = { session ->
                val machine = services.machine(session.metadata?.machineId)
                val ids = sessionActionIds(session, machine, continuationExperiments, devMode)
                val buttons = ids.mapNotNull { id ->
                    when (id) {
                        SessionActionId.Details -> onDetails?.let { AlertButton(strings.details) { it(session.id) } }
                        SessionActionId.Resume -> AlertButton(strings.resume) {
                            val availability = resumeAvailability(session, machine)
                            val machineId = session.metadata?.machineId
                            if (!availability.canResume || machineId == null) {
                                error(availability.block?.let(strings.blocks::getValue) ?: strings.resumeFailed)
                            } else {
                                scope.launch {
                                    when (val outcome = services.continuations.resume(machineId, session.id, session.metadata, strings.resumeTexts)) {
                                        is ResumeOutcome.Resumed -> onOpenSession(outcome.sessionId)
                                        is ResumeOutcome.Failed -> error(outcome.message)
                                        ResumeOutcome.InFlight -> Unit
                                    }
                                }
                            }
                        }
                        SessionActionId.Fork -> AlertButton(strings.fork) {
                            val source = session.forkSource() ?: return@AlertButton
                            scope.launch {
                                val ops = services.machineOps ?: return@launch error(strings.forkFailed)
                                spawned(ops.forkAndSpawn(source), strings.forkFailed)
                            }
                        }
                        SessionActionId.Duplicate -> AlertButton(strings.duplicate) { onDuplicate(session) }
                        SessionActionId.CopyMetadata -> AlertButton(strings.copyMetadata) {
                            val metadata = session.metadata ?: return@AlertButton error(strings.error)
                            copyToClipboard(context, prettyJson.encodeToString(JsonObject.serializer(), metadata.raw))
                            showAlert(Alert(strings.success, strings.metadataCopied, listOf(AlertButton(strings.ok))))
                        }
                        SessionActionId.CopyMetadataAndLogs -> AlertButton(strings.copyMetadata + " & Client Logs") {
                            val metadata = session.metadata ?: return@AlertButton error(strings.error)
                            scope.launch {
                                val logs = withContext(Dispatchers.IO) { ClientLogs.read() }
                                copyToClipboard(context, ClientLogs.metadataAndLogs(prettyJson.encodeToString(JsonObject.serializer(), metadata.raw), logs))
                                showAlert(Alert(strings.success, strings.metadataCopied, listOf(AlertButton(strings.ok))))
                            }
                        }
                        SessionActionId.Archive -> AlertButton(strings.archive, destructive = true) { menus.archive(session.id) }
                    }
                }
                Alert(strings.title, null, buttons + AlertButton(strings.cancel)).also(showAlert)
            },
            showError = { message, bot -> error(message ?: if (bot) strings.botArchiveFailed else strings.archiveFailed) },
            confirmCleanup = {
                confirm(showAlert, strings.cleanupTitle, strings.cleanupMessage, strings.cleanupDelete, strings.cleanupKeep, destructive = true)
            },
            onBeforeArchive = onBeforeArchive,
        )
        menus
    }
}

private data class SessionMenuStrings(
    val title: String,
    val details: String,
    val resume: String,
    val fork: String,
    val duplicate: String,
    val copyMetadata: String,
    val cleanupTitle: String,
    val cleanupMessage: String,
    val cleanupDelete: String,
    val cleanupKeep: String,
    val archive: String,
    val cancel: String,
    val error: String,
    val ok: String,
    val archiveFailed: String,
    val botArchiveFailed: String,
    val forkFailed: String,
    val resumeFailed: String,
    val blocks: Map<ResumeBlock, String>,
    val metadataCopied: String,
    val success: String,
    val resumeTexts: ResumeTexts,
)

/** JSON.stringify(value, null, 2). */
private val prettyJson = Json(HappyJson) { prettyPrint = true; prettyPrintIndent = "  " }

internal fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Happy", text))
}
