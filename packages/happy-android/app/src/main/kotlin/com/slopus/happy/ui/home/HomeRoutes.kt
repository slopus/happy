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
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.model.Machine
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.model.Session
import com.slopus.happy.model.Settings
import com.slopus.happy.model.WorkspaceOrigin
import com.slopus.happy.model.forkSource
import com.slopus.happy.model.parseJsonObject
import com.slopus.happy.sync.OpResult
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
import com.slopus.happy.net.HappyJson
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

/**
 * The home screens' long-lived state, one per [AppGraph]: the list derived
 * in the background and kept warm between visits, the archive in flight,
 * and the store-version check.
 */
class HomeServices private constructor(graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val account = graph.account
    private val store = graph.store
    private val settings = graph.settings.settings

    val sessionActions: SessionActions = LiveSessionActions { account.value?.sessionOps }
    val archiver = SessionArchiver(sessionActions)

    /** Resume, fork and spawn; null while signed out. */
    val machineOps: MachineOps? get() = account.value?.machineOps

    val continuations: SessionContinuations = LiveSessionContinuations { account.value?.machineOps }

    val infoControls: SessionInfoControls = object : SessionInfoControls {
        override suspend fun archive(session: Session): ArchiveResult = archiver.archive(session)

        override suspend fun delete(session: Session): OpResult {
            // Best effort: a running agent would otherwise keep writing into a deleted session.
            if (session.isOnline) sessionActions.kill(session.id)
            return sessionActions.delete(session.id)
        }
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
            )
        }
        .stateIn(scope, SharingStarted.Eagerly, null)

    val list = HomeListModel(
        snapshots = snapshots,
        settings = graph.settings.settings,
        localSettings = graph.localSettings.values,
        // Read state belongs to the chat; nothing is unread until it lands.
        unreadSessionIds = flowOf(emptySet()),
        archivingSessionIds = archiver.archiving,
        scope = scope,
    )

    private val update = MutableStateFlow<String?>(null)

    /** The store page of a required native update (UpdateBanner's first case). */
    val updateUrl: StateFlow<String?> = update.asStateFlow()

    init {
        scope.launch { update.value = checkNativeUpdate(graph.http, BuildConfig.APPLICATION_ID, BuildConfig.VERSION_NAME) }
    }

    fun session(id: String): Session? = snapshots.value?.sessions?.find { it.id == id }

    fun machine(id: String?): Machine? = id?.let { machineId -> snapshots.value?.machines?.find { it.id == machineId } }

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    private var newSessionServices: NewSessionServices? = null

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
            sender = LiveFirstMessageSender { account.value },
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
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val session = snapshot?.sessions?.find { it.id == id }
    val machine = snapshot?.machines?.find { it.id == session?.metadata?.machineId }
    // The chat owns the typed agent state; this screen only counts and shows it.
    val agentState by produceState<JsonObject?>(null, session) {
        value = withContext(Dispatchers.IO) { parseJsonObject(graph.store.session(id)?.agentStateJson) }
    }
    val context = LocalContext.current
    val actions = remember(nav, onOpenSession, context) {
        val home = { nav.popBackStack(HomeRoute, inclusive = false); Unit }
        SessionInfoActions(
            onBack = { nav.popBackStack() },
            onOpenSession = onOpenSession,
            onOpenMachine = { machineId -> nav.navigate(MachineRoute(machineId)) },
            onChanges = { id -> nav.navigate(SessionChangesRoute(id)) },
            onArchived = home,
            onDeleted = home,
            copyToClipboard = { text -> copyToClipboard(context, text) },
        )
    }
    SessionInfoScreen(
        session = session,
        ready = snapshot?.ready == true,
        agentState = agentState,
        machine = machine,
        continuationExperiments = settings.expResumeSession,
        devMode = BuildConfig.DEBUG || local.devModeEnabled,
        controls = services.infoControls,
        continuations = services.continuations,
        actions = actions,
    )
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
) {
    /** useSessionActionAlert: "Session", one button per action, then Cancel. */
    fun open(sessionId: String) {
        val session = services.session(sessionId) ?: return
        buildMenu(session)
    }

    /** useSessionArchiveAction: the same archive the menu runs. */
    fun archive(sessionId: String) {
        val session = services.session(sessionId) ?: return
        services.launch {
            val result = services.archiver.archive(session)
            if (result is ArchiveResult.Failed) showError(result.message, result.bot)
        }
    }
}

@Composable
private fun rememberSessionMenus(
    services: HomeServices,
    continuationExperiments: Boolean,
    devMode: Boolean,
    onOpenSession: (String) -> Unit,
    onDetails: ((String) -> Unit)?,
    onDuplicate: (Session) -> Unit,
    showAlert: (Alert) -> Unit,
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
    )
    return remember(services, continuationExperiments, devMode, onOpenSession, onDetails, onDuplicate, strings, context, scope, showAlert) {
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
                                    val ops = services.machineOps ?: return@launch error(strings.resumeFailed)
                                    spawned(ops.resumeSession(machineId, session.id), strings.resumeFailed)
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
                        SessionActionId.Archive -> AlertButton(strings.archive, destructive = true) { menus.archive(session.id) }
                    }
                }
                Alert(strings.title, null, buttons + AlertButton(strings.cancel)).also(showAlert)
            },
            showError = { message, bot -> error(message ?: if (bot) strings.botArchiveFailed else strings.archiveFailed) },
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
)

private val prettyJson = Json(HappyJson) { prettyPrint = true }

internal fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Happy", text))
}
