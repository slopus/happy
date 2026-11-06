package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.connection.CloudAccount
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudName
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.page
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Happy Cloud: the account's sign-in, then its servers. */
@Serializable data object CloudRoute

@Serializable data object CloudCreateRoute

@Serializable data object CloudJoinRoute

/**
 * The account menu's "Connect to Happy Cloud", provided at the app's root;
 * null where the build has no Happy Cloud, and the row is left out.
 */
val LocalCloudConnect: ProvidableCompositionLocal<(() -> Unit)?> = compositionLocalOf { null }

/**
 * Connecting to Happy Cloud: with the account signed in it shows its
 * servers at once; otherwise it asks first ("Connect to Happy Cloud?",
 * Cancel / Connect), and Connect opens the account's sign-in. Composes its
 * own alert while it asks.
 */
@Composable
fun rememberCloudConnect(graph: AppGraph, nav: NavHostController): (() -> Unit)? {
    val account = graph.cloudAccount ?: return null
    var asking by remember { mutableStateOf(false) }
    if (asking) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.cloud_connect_title),
                message = stringResource(R.string.cloud_connect_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.cloud_connect_confirm)) { nav.navigate(CloudRoute) { launchSingleTop = true } },
                ),
            ),
            onDismiss = { asking = false },
        )
    }
    return remember(account, nav) {
        { if (account.state.value == CloudAccountState.SignedIn) nav.navigate(CloudRoute) { launchSingleTop = true } else asking = true }
    }
}

fun NavGraphBuilder.cloudRoutes(graph: AppGraph, nav: NavHostController) {
    val account = graph.cloudAccount ?: return
    page<CloudRoute> { Cloud(graph, account, nav) }
    page<CloudCreateRoute> { CloudCreate(graph, account, nav) }
    page<CloudJoinRoute> { CloudJoin(graph, account, nav) }
}

/**
 * Opens [server]: this person's connection to it if the phone has one,
 * else the team server sign-in on its origin, which for a Happy Cloud
 * server needs no page (the browser holds the account's session).
 */
fun NavHostController.openCloudServer(graph: AppGraph, server: CloudServer) {
    val origin = server.origin ?: return
    val existing = HappyCloud.connection(graph.agentConnections.accounts.value, origin, graph.openAgentId.value)
    when {
        existing == null -> {
            graph.startServerSignIn(origin)
            navigate(ServerSignInRoute) { popUpTo(CloudRoute); launchSingleTop = true }
        }
        existing.signInRequired -> {
            graph.startServerSignIn(origin, replacing = existing.id)
            navigate(ServerSignInRoute) { popUpTo(CloudRoute); launchSingleTop = true }
        }
        // Already open: opening it changes nothing, so back to its home.
        graph.openAgentId.value == existing.id -> popBackStack(HomeRoute, inclusive = false)
        else -> graph.open(existing.id)
    }
}

@Composable
private fun Cloud(graph: AppGraph, account: CloudAccount, nav: NavHostController) {
    val state by account.state.collectAsStateWithLifecycle()
    val picker = viewModel { CloudServers(account) }
    val context = LocalContext.current
    val dark = com.slopus.happy.ui.theme.HappyTheme.colors.dark
    val openBrowser = { openSignInPage(context, account.browserUrl(), dark) }
    // Connect was the person's go-ahead: the sign-in page opens without another tap.
    LaunchedEffect(Unit) { if (account.state.value == CloudAccountState.SignedOut) openBrowser() }
    LaunchedEffect(state) { if (state == CloudAccountState.SignedIn) picker.load() }
    CloudScreen(
        state = state,
        servers = picker.servers,
        failure = picker.failure,
        here = graph.agentConnections.accounts.collectAsStateWithLifecycle().value.mapNotNull { it.server }.toSet(),
        image = account::image,
        onOpenBrowser = openBrowser,
        onRetrySignIn = account::reset,
        onReload = picker::load,
        onPick = { nav.openCloudServer(graph, it) },
        onCreate = { nav.navigate(CloudCreateRoute) },
        onJoin = { nav.navigate(CloudJoinRoute) },
        onBack = { nav.popBackStack() },
    )
}

/** The account's servers, loaded each time the picker shows. */
private class CloudServers(private val account: CloudAccount) : ViewModel() {
    var servers by mutableStateOf<List<CloudServer>?>(null)
        private set
    var failure by mutableStateOf<CloudException.Reason?>(null)
        private set

    fun load() {
        failure = null
        viewModelScope.launch {
            try {
                servers = account.servers()
            } catch (e: CloudException) {
                failure = e.reason
            }
        }
    }
}

@Composable
private fun CloudCreate(graph: AppGraph, account: CloudAccount, nav: NavHostController) {
    var name by remember { mutableStateOf("") }
    var availability by remember { mutableStateOf<CloudName?>(null) }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<CloudException.Reason?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(name) {
        availability = null
        if (name.length < 3) return@LaunchedEffect
        // Asked once the person pauses typing, not per keystroke.
        delay(300)
        availability = try {
            account.availability(name)
        } catch (_: CloudException) {
            null
        }
    }
    CloudCreateScreen(
        name = name,
        base = account.origin.host.removePrefix("accounts."),
        availability = availability,
        busy = busy,
        failure = failure,
        onName = { typed -> name = CloudNames.typed(typed); failure = null },
        onCreate = {
            busy = true
            scope.launch {
                try {
                    nav.openCloudServer(graph, account.create(name))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CloudException) {
                    failure = e.reason
                    if (e.reason == CloudException.Reason.Taken) availability = CloudName.Taken
                } finally {
                    busy = false
                }
            }
        },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun CloudJoin(graph: AppGraph, account: CloudAccount, nav: NavHostController) {
    var name by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<CloudException.Reason?>(null) }
    val scope = rememberCoroutineScope()
    CloudJoinScreen(
        name = name,
        code = code,
        base = account.origin.host.removePrefix("accounts."),
        busy = busy,
        failure = failure,
        onName = { name = CloudNames.typed(it); failure = null },
        onCode = { code = it.trim(); failure = null },
        onJoin = {
            busy = true
            scope.launch {
                try {
                    nav.openCloudServer(graph, account.join(name, code))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CloudException) {
                    failure = e.reason
                } finally {
                    busy = false
                }
            }
        },
        onBack = { nav.popBackStack() },
    )
}

/** Server names as typed: lower case, only what a name may hold, at most 32. */
internal object CloudNames {
    fun typed(text: String): String = text.lowercase().filter { it in 'a'..'z' || it in '0'..'9' || it == '-' }.take(32)
}
