package com.slopus.happy.ui.connection

import com.slopus.happy.ui.vaults.vaultRoutes
import com.slopus.happy.ui.page
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.connection.PairingFlow
import com.slopus.happy.connection.PairingState
import com.slopus.happy.connection.ServerInvite
import com.slopus.happy.connection.ServerSignInFlow
import com.slopus.happy.connection.ServerSignInState
import com.slopus.happy.ui.artifacts.artifactRoutes
import com.slopus.happy.ui.feed.feedRoutes
import com.slopus.happy.ui.surfaces.surfaceRoutes
import kotlinx.serialization.Serializable

/**
 * Pairing an agent over Happy Protocol V2. Carries no code: the code is a
 * secret and a route is saved with the back stack, so the pairing itself
 * waits in [AppGraph.agentPairing].
 */
@Serializable data object PairingRoute

/**
 * Signing in to a team server (edge SSO). Carries nothing: the sign-in's
 * PKCE verifier is a secret, so it waits in [AppGraph.serverSignIn].
 */
@Serializable data object ServerSignInRoute

/**
 * Where a scanned team server code goes to be signed in to (the only way
 * a phone adds one), provided at the app's root; null where nothing can.
 */
val LocalServerSignIn: androidx.compose.runtime.ProvidableCompositionLocal<((ServerInvite) -> Boolean)?> = androidx.compose.runtime.compositionLocalOf { null }

/** The Protocol V2 screens, signed in or out. HappyApp's NavHost calls this once. */
fun NavGraphBuilder.agentConnectionRoutes(graph: AppGraph, nav: NavHostController) {
    page<PairingRoute> { Pairing(graph, nav) }
    page<ServerSignInRoute> { ServerSignIn(graph, nav) }
    artifactRoutes(graph, nav)
    feedRoutes(graph, nav)
    surfaceRoutes(graph, nav)
    vaultRoutes(graph, nav)
}

/** Starts pairing [code] and shows it, over whatever screen is up. */
fun NavHostController.connectAgent(graph: AppGraph, code: String) {
    graph.startAgentPairing(code)
    navigate(PairingRoute) { launchSingleTop = true }
}

@Composable
private fun Pairing(graph: AppGraph, nav: NavHostController) {
    val holder = viewModel { PairingHolder(graph) }
    // A second code opened while this screen is up replaces the pairing in place.
    val flow by graph.agentPairing.collectAsStateWithLifecycle()
    LaunchedEffect(flow) { flow?.let { holder.flow = it } }
    val state = key(flow) { flow?.state?.collectAsStateWithLifecycle()?.value }
    PairingScreen(
        state = state,
        onConfirm = { flow?.confirm() },
        onReject = { flow?.reject() },
        onBack = { nav.popBackStack() },
        onDone = {
            // A new connection opens, as on iOS; a failed pairing just leaves.
            (state as? PairingState.Paired)?.let { graph.open(it.account.id) } ?: nav.popBackStack()
        },
    )
}

/**
 * The pairing this screen shows, kept by its back stack entry: popping the
 * screen, by Back, Done or the system, rejects a pairing that hadn't
 * finished. Recomposition and configuration changes don't.
 */
private class PairingHolder(private val graph: AppGraph) : ViewModel() {
    var flow: PairingFlow? = graph.agentPairing.value

    override fun onCleared() {
        flow?.let(graph::endAgentPairing)
    }
}

/**
 * The team server a scanned code names (contract §8): opens the connection
 * already on that installation, adding nothing; otherwise starts signing
 * in to it, and shows that. False, with nothing asked or kept, for a new
 * server under a path prefix, which connections can't reach yet.
 */
fun NavHostController.signInToServer(graph: AppGraph, invite: ServerInvite): Boolean {
    val known = graph.agentConnections.accounts.value.firstOrNull { it.instanceId == invite.instanceId }
    if (known != null) {
        graph.open(known.id)
        return true
    }
    val origin = invite.origin ?: return false
    graph.startServerSignIn(origin.value, instanceId = invite.instanceId)
    navigate(ServerSignInRoute) { launchSingleTop = true }
    return true
}

/** Signs [replacing], the team server at [address], in again, and shows it. */
fun NavHostController.signInToServerAgain(graph: AppGraph, address: String, replacing: String) {
    graph.startServerSignIn(address, replacing)
    navigate(ServerSignInRoute) { launchSingleTop = true }
}

@Composable
private fun ServerSignIn(graph: AppGraph, nav: NavHostController) {
    val holder = viewModel { ServerSignInHolder(graph) }
    val flow by graph.serverSignIn.collectAsStateWithLifecycle()
    LaunchedEffect(flow) { flow?.let { holder.flow = it } }
    val state = key(flow) { flow?.state?.collectAsStateWithLifecycle()?.value } ?: ServerSignInState.Checking("")
    val context = androidx.compose.ui.platform.LocalContext.current
    val dark = com.slopus.happy.ui.theme.HappyTheme.colors.dark
    LaunchedEffect(state) {
        val done = state as? ServerSignInState.Done ?: return@LaunchedEffect
        // Signed in again: back where the person was. A new server opens, as a new agent does, and so
        // does another member's connection, which took the place of the one signed in again on.
        if (flow?.replacing == done.account.id) nav.popBackStack() else graph.open(done.account.id)
    }
    ServerSignInScreen(
        state = state,
        onOpenBrowser = { flow?.browserUrl()?.let { url -> openSignInPage(context, url, dark) } },
        onSubmitName = { flow?.submitName(it) },
        onRetry = { flow?.retry() },
        onBack = { nav.popBackStack() },
    )
}

/**
 * The authorization page in a Custom Tab (RFC 8252: the system browser,
 * never a WebView), so the person's SSO session and password manager are
 * there; where no browser has Custom Tabs, the default browser.
 */
private fun openSignInPage(context: android.content.Context, url: String, dark: Boolean) {
    val intent = androidx.browser.customtabs.CustomTabsIntent.Builder()
        .setShowTitle(true)
        .setColorScheme(if (dark) androidx.browser.customtabs.CustomTabsIntent.COLOR_SCHEME_DARK else androidx.browser.customtabs.CustomTabsIntent.COLOR_SCHEME_LIGHT)
        .build()
    try {
        intent.launchUrl(context, android.net.Uri.parse(url))
    } catch (_: android.content.ActivityNotFoundException) {
        android.widget.Toast.makeText(context, R.string.team_server_no_browser, android.widget.Toast.LENGTH_LONG).show()
    }
}

/** The sign-in this screen shows, kept by its back stack entry; popping the screen ends it. */
private class ServerSignInHolder(private val graph: AppGraph) : ViewModel() {
    var flow: ServerSignInFlow? = graph.serverSignIn.value

    override fun onCleared() {
        flow?.let(graph::endServerSignIn)
    }
}
