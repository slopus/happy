package com.slopus.happy.ui

import com.slopus.happy.ui.connection.openAgentSettingsRow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.slopus.happy.ui.voice.LocalVoiceController
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.OpenAccount
import com.slopus.happy.ui.components.ProvideRowReveal
import com.slopus.happy.ui.home.LegacyHome
import com.slopus.happy.ui.settings.AccountSettings
import androidx.compose.runtime.saveable.listSaver
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph
import androidx.navigation.toRoute
import com.slopus.happy.push.PushRegistrationEffect
import com.slopus.happy.payments.PaywallHost
import com.slopus.happy.ui.artifacts.AgentArtifactsRoute
import com.slopus.happy.ui.artifacts.BrowserRoute
import com.slopus.happy.ui.artifacts.computerName
import com.slopus.happy.ui.artifacts.openArtifact
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.chat.chatRoutes
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.connect.DeepLinkEffect
import com.slopus.happy.ui.connection.AgentHome
import com.slopus.happy.ui.connection.AgentSurfaceRoute
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.connect.LocalAgentPairing
import com.slopus.happy.ui.connection.LocalServerSignIn
import com.slopus.happy.ui.connection.LocalHappyLinks
import com.slopus.happy.ui.connection.rememberHappyLinks
import com.slopus.happy.ui.connection.signInToServer
import com.slopus.happy.ui.connection.signInToServerAgain
import com.slopus.happy.connection.ServerInvite
import com.slopus.happy.ui.connect.rememberAddFlow
import com.slopus.happy.ui.start.rememberCustomServerLabel
import com.slopus.happy.ui.tablet.TabletShell
import com.slopus.happy.ui.tablet.MainPanelKey
import com.slopus.happy.ui.tablet.MainPanelOpener
import com.slopus.happy.ui.tablet.MainPanelPlaceholder
import com.slopus.happy.ui.home.LocalHomeInSidebar
import com.slopus.happy.ui.connect.connectRoutes
import com.slopus.happy.ui.files.filesRoutes
import com.slopus.happy.ui.home.homeRoutes
import com.slopus.happy.ui.onboarding.RestoreManualScreen
import com.slopus.happy.ui.onboarding.TroubleshootRoute
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.onboarding.onboardingRoutes
import com.slopus.happy.ui.connection.connectAgent
import com.slopus.happy.ui.connection.agentConnectionRoutes
import com.slopus.happy.ui.connection.agentHomeRoutes
import com.slopus.happy.ui.conversation.composeConversation
import com.slopus.happy.ui.conversation.conversationRoutes
import com.slopus.happy.ui.conversation.openConversation
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.start.InstallDesktop
import com.slopus.happy.ui.start.InstallDesktopRoute
import com.slopus.happy.ui.start.Start
import com.slopus.happy.ui.server.ServerScreen
import com.slopus.happy.ui.settings.LocalizedContent
import com.slopus.happy.ui.components.avatar.LocalAnimatedAvatars
import com.slopus.happy.ui.home.ProvideAvatarSettings
import com.slopus.happy.ui.settings.settingsRoutes
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable data object StartRoute
@Serializable data object ServerRoute
@Serializable data object RestoreRoute
@Serializable data object RestoreManualRoute
@Serializable data object HomeRoute
/** Settings, of whichever account is open; [reveal]: the row home's search found there ([ProvideRowReveal]). */
@Serializable data class SettingsRoute(val reveal: String? = null)

/**
 * The whole UI. Signed out and signed in are separate back stacks: when the
 * account changes the stack is replaced, as happy-app's `router.dismissTo('/')`
 * after login and its reload after logout do. A switch made in Settings
 * ([AccountSwitcher]) keeps the stack, Settings over home, and both show the
 * new account: home and Settings follow [AppGraph.openAccount].
 */
@Composable
fun HappyApp(graph: AppGraph, onNavigationReady: (NavHostController) -> Unit = {}, onDarkThemeChange: (Boolean) -> Unit = {}) {
    val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
    val language by graph.language.language.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val animatedAvatars by graph.liveAvatars.enabled.collectAsStateWithLifecycle()

    // Avatar.tsx reads the avatar settings everywhere: the chat header and Settings as well as Home.
    LocalizedContent(language.locale) { HappyTheme(preference = theme) { ProvideAvatarSettings(settings) { CompositionLocalProvider(LocalVoiceController provides graph.voice, LocalAnimatedAvatars provides animatedAvatars) {
        val dark = HappyTheme.colors.dark
        // In the frame that composes it, before that frame is drawn: the window's colour is the theme's from the first frame.
        SideEffect { onDarkThemeChange(dark) }

        val open by graph.openAccount.collectAsStateWithLifecycle()
        val agent = (open as? OpenAccount.Agent)?.id
        val signedIn = open is OpenAccount.Happy
        val dissolve = remember { Dissolve() }
        val scope = rememberCoroutineScope()
        val switcher = remember(graph) { AccountSwitcher(graph, scope, dissolve) }
        val shown = remember { arrayOfNulls<NavHostController>(1) }
        val stack = rememberStackGeneration(open) { switcher.keepsSettings && open != OpenAccount.None && shown[0]?.isSettingsOverHome() == true }
        // RevenueCat's paywall host, once the start is over: no paywall opens before a tap.
        val afterStart = LocalAfterStart.current
        val started by produceState(false) { afterStart.await(); value = true }
        if (started) PaywallHost(graph.purchases)
        DissolveBox(dissolve) { CompositionLocalProvider(LocalAccountSwitcher provides switcher) {
        // Each account has its own back stack, replaced when another opens (but not from Settings).
        key(stack) {
            val nav = rememberNavController()
            shown[0] = nav
            SideEffect { onNavigationReady(nav) }
            val openSession = { id: String -> nav.navigate(SessionRoute(id)) }
            val troubleshoot = { nav.navigate(TroubleshootRoute) }
            val connectAgent = remember(nav) { { code: String -> nav.connectAgent(graph, code) } }
            val signInToServer = remember(nav) { { invite: ServerInvite -> nav.signInToServer(graph, invite) } }
            // Happy URLs (edge SSO §7): external ones only on their own installation's connection.
            val happyLinks = rememberHappyLinks(graph, nav, agent)
            // Every scanner, signed in or out, sends happy://direct? codes here.
            CompositionLocalProvider(LocalAgentPairing provides connectAgent, LocalServerSignIn provides signInToServer, LocalHappyLinks provides happyLinks) {
              // Add (the first screen's Connect, the account menu's Add): scan, then route the code.
              val add = rememberAddFlow(
                  graph,
                  onRestore = { nav.navigate(RestoreRoute) },
                  onServer = { nav.navigate(ServerRoute) },
                  serverLabel = rememberCustomServerLabel(graph),
              )
              CompositionLocalProvider(LocalAddFlow provides add) {
                // Links: through the open agent connection in its browser, or as ever on a Happy account.
                ProvideLinks(rememberLinks(graph, nav, agent)) {
                // The account's home, sending what it opens through [go]: the stack's own pushes on its page, the
                // main panel's new root from the tablet's sidebar. A switch made in Settings changes the covered home too.
                val home: @Composable (MainPanelOpener) -> Unit = { go ->
                    key(open.key) {
                        when (val account = open) {
                            is OpenAccount.Agent -> AgentHome(
                                graph,
                                account.id,
                                onOpenConversation = { agentId -> go.open(MainPanelKey.conversation(agentId)) { nav.openConversation(account.id, agentId) } },
                                onCompose = { go.open(null) { nav.composeConversation(account.id) } },
                                onComposeWithPicture = { go.open(null) { nav.composeConversation(account.id, attach = true) } },
                                onSettings = { go.open(MainPanelKey.SETTINGS) { nav.navigate(SettingsRoute()) } },
                                onSettingsRow = { row -> go.open(null) { nav.openAgentSettingsRow(account.id, row) } },
                                onOpenArtifacts = { go.open(MainPanelKey.ARTIFACTS) { nav.navigate(AgentArtifactsRoute(account.id)) } },
                                onOpenSurface = { go.open(MainPanelKey.surface(it.id)) { nav.navigate(AgentSurfaceRoute(account.id, it.id, it.type, it.name)) } },
                                onOpenArtifact = { go.open(null) { nav.openArtifact(account.id, it) } },
                                onSignIn = { server -> go.open(null) { nav.signInToServerAgain(graph, server, replacing = account.id) } },
                            )
                            is OpenAccount.Happy -> LegacyHome(graph, nav, onOpenSession = openSession, onTroubleshoot = troubleshoot, go = go)
                            OpenAccount.None -> Unit
                        }
                    }
                }
                // The tablet shell (home in a sidebar beside the stack) or, on a phone, just the stack.
                TabletShell(graph, nav, hasHome = open != OpenAccount.None, sidebar = home) {
                    val start: Any = if (open == OpenAccount.None) StartRoute else HomeRoute
                    val motion = rememberNavMotion()
                    RetainedNavHost(nav, start, motion, modifier = Modifier.backdrop(nav)) {
                        page<StartRoute> { Start(graph, nav, add) }
                        page<InstallDesktopRoute> { InstallDesktop(graph, nav, add) }
                        // Home itself, or with home in the tablet's sidebar the empty main panel.
                        page<HomeRoute> { if (LocalHomeInSidebar.current) MainPanelPlaceholder() else home(MainPanelOpener.Push) }
                        // The open account's Settings, of either kind; a switch made here changes it in place.
                        page<SettingsRoute> { entry ->
                            ProvideRowReveal(entry.toRoute<SettingsRoute>().reveal) { AccountSettings(graph, nav, open) }
                        }
                        page<ServerRoute> { Server(graph, nav) }
                        page<RestoreManualRoute> { RestoreManual(graph, nav) }
                        homeRoutes(graph, nav, onOpenSession = openSession)
                        settingsRoutes(graph, nav)
                        onboardingRoutes(graph, nav, onOpenMachine = { id -> nav.navigate(MachineRoute(id)) })
                        connectRoutes(graph, nav)
                        chatRoutes(graph, nav, onInfo = { id -> nav.navigate(SessionInfoRoute(id)) })
                        filesRoutes(graph, nav)
                        agentConnectionRoutes(graph, nav)
                        agentHomeRoutes(graph, nav)
                        conversationRoutes(graph, nav)
                    }
                }
                }
                DeepLinkEffect(nav, signedIn = signedIn, onOpenSession = { id -> nav.navigate(SessionRoute(id)) }, openConnection = agent, onHappyLink = happyLinks::take)
              }
            }
            PushRegistrationEffect(graph)
        }
        } }
    } } } }
}

/** Settings on top of home and nothing else in the stack: a switch made there keeps both. */
internal fun NavHostController.isSettingsOverHome(): Boolean {
    val screens = currentBackStack.value.filter { it.destination !is NavGraph }
    return screens.size == 2 && screens[0].destination.hasRoute<HomeRoute>() && screens[1].destination.hasRoute<SettingsRoute>()
}

/** Which back stack HappyApp shows and the account it is of; saved, so the stack is restored with it. */
private class StackGeneration(var account: String, var generation: Int)

/**
 * The key of HappyApp's back stack: a new one whenever [open] changes,
 * unless [keep] says the switch keeps the stack (one made in Settings).
 * Saved with the stack, so a recreation or process death restores it.
 */
@Composable
private fun rememberStackGeneration(open: OpenAccount, keep: () -> Boolean): Int {
    val saved = rememberSaveable(saver = listSaver(save = { listOf(it.account, it.generation) }, restore = { StackGeneration(it[0] as String, it[1] as Int) })) {
        StackGeneration(open.key, 0)
    }
    return remember(open) {
        if (saved.account != open.key) {
            if (!keep()) saved.generation++
            saved.account = open.key
        }
        saved.generation
    }
}

/**
 * The app's links for the open account: with agent connection [agent] open,
 * the in-app browser through it (its local host workspace; a chat narrows
 * that to its agent's); on a Happy account, the phone's browser as before.
 */
@Composable
private fun rememberLinks(graph: AppGraph, nav: NavHostController, agent: String?): LinkOpener {
    val context = LocalContext.current
    if (agent == null) {
        val system = LocalUriHandler.current
        val dark = HappyTheme.colors.dark
        return remember(system, dark) { LinkOpener.legacy(context, system, dark) }
    }
    val computer = computerName(graph, agent)
    return remember(nav, agent, computer) { LinkOpener.agent(context, computer) { url -> nav.navigate(BrowserRoute(agent, url)) } }
}

@Composable
private fun Server(graph: AppGraph, nav: NavHostController) {
    val serverUrl by graph.serverConfig.url.collectAsStateWithLifecycle()
    ServerScreen(
        customUrl = serverUrl.takeIf { graph.serverConfig.isCustom },
        probe = graph.authApi::probeServer,
        onSave = graph.serverConfig::set,
        onReset = { graph.serverConfig.set(null) },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun RestoreManual(graph: AppGraph, nav: NavHostController) {
    val scope = rememberCoroutineScope()
    var secretKey by rememberSaveable { mutableStateOf("") }
    var restoring by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val error = stringResource(R.string.common_error)
    val ok = stringResource(R.string.common_ok)
    val enterKey = stringResource(R.string.connect_enter_secret_key)
    val invalidKey = stringResource(R.string.connect_invalid_secret_key)

    RestoreManualScreen(
        secretKey = secretKey,
        onSecretKeyChange = { secretKey = it },
        restoring = restoring,
        onRestore = {
            if (secretKey.isBlank()) {
                alert = Alert(error, enterKey, listOf(AlertButton(ok)))
            } else {
                scope.launch {
                    restoring = true
                    try {
                        graph.auth.restore(secretKey)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // Like happy-app: a bad key and a failed exchange read the same.
                        alert = Alert(error, invalidKey, listOf(AlertButton(ok)))
                    } finally {
                        restoring = false
                    }
                }
            }
        },
        onBack = { nav.popBackStack() },
    )
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}
