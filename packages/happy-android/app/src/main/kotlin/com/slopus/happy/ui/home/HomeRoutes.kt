package com.slopus.happy.ui.home

import com.slopus.happy.ui.onboarding.DESKTOP_URL

import androidx.compose.ui.platform.LocalUriHandler

import com.slopus.happy.ui.migration.DesktopMigrationSpec

import com.slopus.happy.ui.migration.DesktopMigrationScreen
import com.slopus.happy.ui.migration.rememberMigrationScan

import com.slopus.happy.ui.migration.DesktopMigrationRoute

import com.slopus.happy.ui.migration.MigrationPath

import com.slopus.happy.ui.page
import androidx.activity.compose.ReportDrawnWhen
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.chat.ComposerModeResolver
import com.slopus.happy.connection.accountLinkState
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.chat.rememberShownLinkState
import com.slopus.happy.ui.connection.rememberNetworkPath
import com.slopus.happy.model.Settings
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.parseJsonObject
import com.slopus.happy.projects.GitStatusServices
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.chat.shownSessionId
import com.slopus.happy.ui.chat.composeChat
import com.slopus.happy.ui.components.AvatarSettings
import com.slopus.happy.ui.components.LocalAvatarSettings
import com.slopus.happy.ui.files.SessionChangesRoute
import com.slopus.happy.ui.machine.LiveMachineControls
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.machine.MachineScreen
import com.slopus.happy.ui.machine.MachineScreenActions
import com.slopus.happy.ui.machine.recentMachineSessions
import com.slopus.happy.ui.onboarding.LinkComputerChecklist
import com.slopus.happy.ui.session.DuplicateSheet
import com.slopus.happy.ui.session.SessionInfoActions
import com.slopus.happy.ui.session.SessionInfoLive
import com.slopus.happy.ui.session.SessionInfoPermission
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.session.SessionInfoScreen
import com.slopus.happy.model.resolveAvatar
import com.slopus.happy.ui.settings.ChangelogRoute
import com.slopus.happy.ui.tablet.MainPanelKey
import com.slopus.happy.ui.tablet.MainPanelOpener
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** Where the home list's taps lead: the same for the phone home and the tablet sidebar. */
class HomeNavigation(
    val onSettings: () -> Unit,
    val onWhatsNew: () -> Unit,
    val onOpenSession: (String) -> Unit,
    val onOpenMachine: (String) -> Unit,
    val onTroubleshoot: () -> Unit,
    /** The new-session screen (new/index.tsx), where `/new` leads. */
    val onNewSession: () -> Unit,
    val onDetails: (String) -> Unit,
    /** Compose: an empty chat whose first send starts the session, on the phone and in the tablet's detail pane. */
    val onCompose: () -> Unit = onNewSession,
    /** The migration card's screen for its path (iOS ea1a0902f). */
    val onMigration: (MigrationPath) -> Unit = {},
) {
    companion object {
        fun of(graph: AppGraph, nav: NavHostController, onOpenSession: (String) -> Unit, onTroubleshoot: () -> Unit) = HomeNavigation(
            onSettings = { nav.navigate(SettingsRoute()) },
            onWhatsNew = { nav.navigate(ChangelogRoute) },
            onOpenSession = onOpenSession,
            onOpenMachine = { id -> nav.navigate(MachineRoute(id)) },
            onTroubleshoot = onTroubleshoot,
            // router.navigate('/new'): a second tap while it is on top stays one screen.
            onNewSession = { nav.navigate(NewSessionRoute) { launchSingleTop = true } },
            onDetails = { id -> nav.navigate(SessionInfoRoute(id)) },
            onCompose = { nav.composeChat() },
            onMigration = { path -> nav.navigate(DesktopMigrationRoute(path.wire)) },
        )
    }
}

/**
 * Set by the tablet shell while its sidebar holds the account's home: the
 * home route's page is then the empty main panel (happy-ios docs/IPAD.md).
 */
val LocalHomeInSidebar = staticCompositionLocalOf { false }

/**
 * Where home's taps lead through [go] ([MainPanelOpener]): pushes on the
 * phone, the main panel's new root from the tablet's sidebar, each named
 * by what it opens so opening it again goes back to it.
 */
fun HomeNavigation.through(go: MainPanelOpener): HomeNavigation = HomeNavigation(
    onSettings = { go.open(MainPanelKey.SETTINGS, onSettings) },
    onWhatsNew = { go.open(MainPanelKey.CHANGELOG, onWhatsNew) },
    onOpenSession = { id -> go.open(MainPanelKey.session(id)) { onOpenSession(id) } },
    onOpenMachine = { id -> go.open(MainPanelKey.machine(id)) { onOpenMachine(id) } },
    onTroubleshoot = { go.open(MainPanelKey.TROUBLESHOOT, onTroubleshoot) },
    onNewSession = { go.open(MainPanelKey.NEW_SESSION, onNewSession) },
    onDetails = { id -> go.open(MainPanelKey.info(id)) { onDetails(id) } },
    onCompose = { go.open(null, onCompose) },
    onMigration = { path -> go.open(null) { onMigration(path) } },
)

/**
 * A Happy account's home, [HomeRoute]'s while one is open (HappyApp), or the
 * tablet's sidebar. [onOpenSession] belongs to the chat, [onTroubleshoot] to
 * onboarding; [go] is where what it opens goes.
 */
@Composable
fun LegacyHome(
    graph: AppGraph,
    nav: NavHostController,
    onOpenSession: (sessionId: String) -> Unit,
    onTroubleshoot: () -> Unit,
    go: MainPanelOpener = MainPanelOpener.Push,
) {
    HomeListHost(graph, remember(nav, go) { HomeNavigation.of(graph, nav, onOpenSession, onTroubleshoot).through(go) }, phone = true) { host ->
        // Fully drawn (cold start's timeToFullDisplay, research/cold-start.md): the rows are read from disk.
        ReportDrawnWhen { host.state != null }
        HomeScreen(
            state = host.state,
            connectionStatus = host.connectionStatus,
            grouping = host.grouping,
            callbacks = host.callbacks,
            actions = host.actions,
            update = host.update,
            migration = host.migration,
            offlineContent = { computers, onShowArchived ->
                LinkComputerChecklist(graph, computers = computers, onTroubleshoot = host.navigation.onTroubleshoot, onShowArchived = onShowArchived)
            },
            accounts = rememberAccountMenu(graph),
            listState = host.listState,
            syncing = host.syncing,
            link = rememberShownLinkState(
                accountLinkState(host.connectionStatus == ConnectionStatus.CONNECTED, catchingUp = host.syncing || host.state == null, network = rememberNetworkPath()),
            ),
        )
    }
}

/** The screens beside a Happy account's home. [onOpenSession] belongs to the chat. */
fun NavGraphBuilder.homeRoutes(
    graph: AppGraph,
    nav: NavHostController,
    onOpenSession: (sessionId: String) -> Unit = {},
) {
    page<DesktopMigrationRoute> { entry ->
        val path = MigrationPath.of(entry.toRoute<DesktopMigrationRoute>().path) ?: MigrationPath.Desktop
        val scan = rememberMigrationScan(graph)
        val uriHandler = LocalUriHandler.current
        DesktopMigrationScreen(
            path = path,
            scanning = scan.isLoading,
            onBack = { nav.popBackStack() },
            onScan = scan::scan,
            onOpenSite = { uriHandler.openUri(DESKTOP_URL) },
            onLearnMore = { uriHandler.openUri(DesktopMigrationSpec.LEARN_MORE_URL) },
        )
    }
    page<NewSessionRoute> {
        val dock = rememberNewSessionDock(
            graph,
            focused = true,
            onFocusChange = { focused -> if (!focused) nav.popBackStack() },
            onStarted = onOpenSession,
            initialPrompt = { HomeServices.of(graph).newSession(nav.context.applicationContext).draft.value.input },
        )
        NewSessionScreen(dock, onBack = { nav.popBackStack() })
    }
    page<SessionInfoRoute> { entry ->
        SessionInfoRouteScreen(graph, entry.toRoute<SessionInfoRoute>().id, nav, onOpenSession)
    }
    page<MachineRoute> { entry ->
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
        avatar = session?.resolveAvatar(snapshot?.projects.orEmpty()),
    )
    // Opened over its chat, the chat's permission mode is picked here, as its header's menu picks it (iOS da5fda505).
    val overChat = remember(nav, id) {
        nav.previousBackStackEntry?.let { it.destination.hasRoute<SessionRoute>() && it.shownSessionId() == id } == true
    }
    val resources = LocalResources.current
    val metadata = session?.metadata
    val modes = remember(metadata, mirror, settings.agentDefaultOverrides) {
        ComposerModeResolver.resolve(metadata, mirror, settings.agentDefaultOverrides, resources::getString)
    }
    val latestMirror by rememberUpdatedState(mirror)
    val latestMetadata by rememberUpdatedState(metadata)
    val permission = if (!overChat) null else remember(modes, account, id) {
        SessionInfoPermission(modes) { field, option ->
            account?.composer?.setAgentModes(id, ComposerModeResolver.patch(field, option, latestMetadata, latestMirror))
        }
    }
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
        permission = permission,
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
    val chatBehind = top?.destination?.hasRoute<SessionRoute>() == true && top.shownSessionId() == sessionId
    when {
        successor != null && chatBehind -> navigate(SessionRoute(successor)) { popUpTo<SessionRoute> { inclusive = true } }
        successor != null -> openSession(successor)
        chatBehind -> popBackStack()
    }
}

/** The synced avatar settings, for every avatar under [content]. */
@Composable
fun ProvideAvatarSettings(settings: Settings, content: @Composable () -> Unit) {
    val avatars = remember(settings.avatarMonochrome, settings.showFlavorIcons, settings.showHarnessIconInSessionHeader) {
        AvatarSettings(
            monochrome = settings.avatarMonochrome,
            showFlavorIcons = settings.showFlavorIcons,
            showHarnessIconInSessionHeader = settings.showHarnessIconInSessionHeader,
        )
    }
    CompositionLocalProvider(LocalAvatarSettings provides avatars, content = content)
}
