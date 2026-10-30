package com.slopus.happy.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.slopus.happy.ui.voice.LocalVoiceController
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.auth.AuthState
import com.slopus.happy.push.PushRegistrationEffect
import com.slopus.happy.payments.PaywallHost
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.chat.chatRoutes
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.accounts.accountId
import com.slopus.happy.ui.connect.DeepLinkEffect
import com.slopus.happy.ui.connection.AgentHome
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.connect.LocalAgentPairing
import com.slopus.happy.ui.connect.rememberAddFlow
import com.slopus.happy.ui.tablet.TabletShell
import com.slopus.happy.ui.connect.connectRoutes
import com.slopus.happy.ui.files.filesRoutes
import com.slopus.happy.ui.home.homeRoutes
import com.slopus.happy.ui.onboarding.RestoreManualScreen
import com.slopus.happy.ui.onboarding.TroubleshootRoute
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.onboarding.onboardingRoutes
import com.slopus.happy.ui.connection.connectAgent
import com.slopus.happy.ui.connection.agentConnectionRoutes
import com.slopus.happy.ui.connection.AgentConnectionSettingsRoute
import com.slopus.happy.ui.connection.agentHomeRoutes
import com.slopus.happy.ui.conversation.composeConversation
import com.slopus.happy.ui.conversation.conversationRoutes
import com.slopus.happy.ui.conversation.openConversation
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.start.Start
import com.slopus.happy.ui.server.ServerScreen
import com.slopus.happy.ui.settings.AppearanceRoute
import com.slopus.happy.ui.settings.LocalizedContent
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
@Serializable data object SettingsRoute
@Serializable data object AgentHomeRoute

/**
 * The whole UI. Signed out and signed in are separate back stacks: when the
 * account changes the stack is replaced, as happy-app's `router.dismissTo('/')`
 * after login and its reload after logout do.
 */
@Composable
fun HappyApp(graph: AppGraph, onDarkThemeChange: (Boolean) -> Unit = {}) {
    val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val language by graph.language.language.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()

    // Avatar.tsx reads the avatar settings everywhere: the chat header and Settings as well as Home.
    LocalizedContent(language.locale) { HappyTheme(preference = theme) { ProvideAvatarSettings(settings) { CompositionLocalProvider(LocalVoiceController provides graph.voice) {
        val dark = HappyTheme.colors.dark
        LaunchedEffect(dark) { onDarkThemeChange(dark) }

        val agent by graph.openAgentId.collectAsStateWithLifecycle()
        val signedIn = auth as? AuthState.SignedIn
        PaywallHost(graph.purchases)
        // Each account has its own back stack, replaced when another opens.
        key(signedIn?.let { accountId(it.credentials) }, agent) {
            val nav = rememberNavController()
            val openSession = { id: String -> nav.navigate(SessionRoute(id)) }
            val troubleshoot = { nav.navigate(TroubleshootRoute) }
            val connectAgent = remember(nav) { { code: String -> nav.connectAgent(graph, code) } }
            // Every scanner, signed in or out, sends happy://direct? codes here.
            CompositionLocalProvider(LocalAgentPairing provides connectAgent) {
              // Add (the first screen's Connect, the account menu's Add): scan, then route the code.
              val add = rememberAddFlow(graph)
              CompositionLocalProvider(LocalAddFlow provides add) {
                // The tablet shell (sidebar beside the stack) or, on a phone, just the stack.
                TabletShell(graph, nav, signedIn = signedIn != null, onOpenSession = openSession, onTroubleshoot = troubleshoot) {
                    val start: Any = when {
                        agent != null -> AgentHomeRoute
                        signedIn != null -> HomeRoute
                        else -> StartRoute
                    }
                    val motion = rememberNavMotion()
                    NavHost(
                        navController = nav,
                        startDestination = start,
                        enterTransition = motion.enter,
                        exitTransition = motion.exit,
                        popEnterTransition = motion.popEnter,
                        popExitTransition = motion.popExit,
                        predictivePopEnterTransition = { _ -> motion.popEnter.invoke(this) },
                        predictivePopExitTransition = { _ -> motion.popExit.invoke(this) },
                    ) {
                        composable<StartRoute> { Start(graph, nav, add) }
                        composable<AgentHomeRoute> {
                            agent?.let { id ->
                                AgentHome(
                                    graph,
                                    id,
                                    onOpenConversation = { agentId -> nav.openConversation(id, agentId) },
                                    onCompose = { nav.composeConversation(id) },
                                    onSettings = { nav.navigate(AgentConnectionSettingsRoute(id)) },
                                    onAppearance = { nav.navigate(AppearanceRoute) },
                                )
                            }
                        }
                        composable<ServerRoute> { Server(graph, nav) }
                        composable<RestoreManualRoute> { RestoreManual(graph, nav) }
                        homeRoutes(
                            graph,
                            nav,
                            onOpenSession = openSession,
                            onTroubleshoot = troubleshoot,
                        )
                        settingsRoutes(graph, nav)
                        onboardingRoutes(graph, nav, onOpenMachine = { id -> nav.navigate(MachineRoute(id)) })
                        connectRoutes(graph, nav)
                        chatRoutes(graph, nav, onInfo = { id -> nav.navigate(SessionInfoRoute(id)) })
                        filesRoutes(graph, nav)
                        agentConnectionRoutes(graph, nav)
                        agentHomeRoutes(graph, nav, onAppearance = { nav.navigate(AppearanceRoute) })
                        conversationRoutes(graph, nav)
                    }
                }
                DeepLinkEffect(nav, signedIn = signedIn != null, onOpenSession = { id -> nav.navigate(SessionRoute(id)) })
              }
            }
            PushRegistrationEffect(graph)
        }
    } } } }
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
