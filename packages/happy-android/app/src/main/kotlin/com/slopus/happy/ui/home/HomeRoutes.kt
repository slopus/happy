package com.slopus.happy.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.model.Settings
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.parseJsonObject
import com.slopus.happy.projects.GitStatusServices
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.components.AvatarSettings
import com.slopus.happy.ui.components.AvatarStyle
import com.slopus.happy.ui.components.LocalAvatarSettings
import com.slopus.happy.ui.files.SessionChangesRoute
import com.slopus.happy.ui.machine.LiveMachineControls
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.machine.MachineScreen
import com.slopus.happy.ui.machine.MachineScreenActions
import com.slopus.happy.ui.machine.recentMachineSessions
import com.slopus.happy.ui.onboarding.LinkComputerChecklist
import com.slopus.happy.ui.onboarding.OnboardingLinkComputer
import com.slopus.happy.ui.onboarding.OnboardingSettingsRoute
import com.slopus.happy.ui.session.DuplicateSheet
import com.slopus.happy.ui.session.SessionInfoActions
import com.slopus.happy.ui.session.SessionInfoLive
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.session.SessionInfoScreen
import com.slopus.happy.ui.settings.AppearanceRoute
import com.slopus.happy.ui.settings.ChangelogRoute
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

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
            // router.navigate('/new'): a second tap while it is on top stays one screen.
            onNewSession = { nav.navigate(NewSessionRoute) { launchSingleTop = true } },
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
