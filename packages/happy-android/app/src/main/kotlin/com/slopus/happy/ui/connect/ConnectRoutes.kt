package com.slopus.happy.ui.connect

import com.slopus.happy.ui.page
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.TERMINAL_URL_PREFIX
import com.slopus.happy.ui.HomeRoute
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** terminal/index.tsx: confirm a terminal that asked by link. */
@Serializable data class TerminalRoute(val publicKey: String? = null)

/** terminal/connect.tsx: the CLI's web link, opened in the app. */
@Serializable data object TerminalWebRoute

/** The signed-in connect screens. HappyApp's NavHost calls this once. */
fun NavGraphBuilder.connectRoutes(graph: AppGraph, nav: NavHostController) {
    page<TerminalRoute> { entry ->
        val publicKey = entry.toRoute<TerminalRoute>().publicKey
        val scope = rememberCoroutineScope()
        val connect = rememberTerminalConnect(graph, onSuccess = { nav.popBackStack() })
        TerminalConfirmScreen(
            publicKey = publicKey,
            connecting = connect.isLoading,
            onAccept = {
                if (publicKey != null) scope.launch { connect.processAuthUrl(TERMINAL_URL_PREFIX + publicKey) }
            },
            onReject = { nav.popBackStack() },
        )
    }
    page<TerminalWebRoute> { TerminalWebScreen(onBack = { nav.popBackStack() }) }
}

/**
 * Takes links from [DeepLinks] once the screens are up and opens their
 * screen over the current one; Home goes back to Home. Signed out, only
 * the screens that work without an account open (happy-app pushes the
 * others too, onto screens with nothing loaded); the rest are dropped,
 * except a terminal's link, which goes to the first screen's Add as if it
 * were pasted into Enter link manually: an account is made that approves
 * it.
 * Session links go to [onOpenSession], which the chat screen provides;
 * without it they are dropped too. Protocol V2 pairing codes open signed
 * in or out, through [LocalAgentPairing]. Happy URLs (edge SSO §7) go to
 * [onHappyLink] ([com.slopus.happy.ui.connection.HappyLinks.take]), signed
 * in or out; one waiting for a connection to open is left for that
 * connection's stack ([openConnection] is this one's).
 */
@Composable
fun DeepLinkEffect(
    nav: NavHostController,
    signedIn: Boolean,
    onOpenSession: ((String) -> Unit)? = null,
    openConnection: String? = null,
    onHappyLink: ((DeepLink) -> Unit)? = null,
) {
    val pending by DeepLinks.pending.collectAsStateWithLifecycle()
    val connectAgent = LocalAgentPairing.current
    val add = LocalAddFlow.current
    LaunchedEffect(pending, signedIn) {
        val link = pending ?: return@LaunchedEffect
        if (link is DeepLink.OnConnection && link.connectionId != openConnection) return@LaunchedEffect
        if (!DeepLinks.consume(link)) return@LaunchedEffect
        if (link is DeepLink.Instance || link is DeepLink.OnConnection) {
            onHappyLink?.invoke(link)
            return@LaunchedEffect
        }
        if (link is DeepLink.AgentPairing) {
            connectAgent?.invoke(link.code)
            return@LaunchedEffect
        }
        if (!signedIn) {
            if (link is DeepLink.Screen && link.signedOut) nav.navigate(link.route)
            if (link is DeepLink.Terminal && link.publicKey != null) add?.connectWithUrl(TERMINAL_URL_PREFIX + link.publicKey)
            return@LaunchedEffect
        }
        when (link) {
            is DeepLink.Terminal -> nav.navigate(TerminalRoute(link.publicKey))
            DeepLink.TerminalWeb -> nav.navigate(TerminalWebRoute)
            is DeepLink.Session -> onOpenSession?.invoke(link.id)
            is DeepLink.Screen -> nav.navigate(link.route)
            DeepLink.Home -> nav.popBackStack(HomeRoute, inclusive = false)
            is DeepLink.AgentPairing, is DeepLink.Instance, is DeepLink.OnConnection -> Unit
        }
    }
}
