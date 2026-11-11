package com.slopus.happy.ui.connection

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
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
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.connection.CloudAccount
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudName
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.connection.ServerSignInFlow
import com.slopus.happy.connection.ServerSignInState
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.page
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Happy Cloud: the account's sign-in, then its servers. */
@Serializable data object CloudRoute

/** Bootstrap a server; [first] when the account has none, where Back signs out. */
@Serializable data class CloudCreateRoute(val first: Boolean = false)

@Serializable data object CloudJoinRoute

/**
 * Happy Cloud's way in, provided at the app's root: the first screen's Use
 * Happy Cloud and the account menu's "Connect to Happy Cloud"; null where
 * the build has no Happy Cloud, and both are left out.
 */
val LocalCloudConnect: ProvidableCompositionLocal<(() -> Unit)?> = compositionLocalOf { null }

/**
 * Connecting to Happy Cloud: full screen, on the first screen's gradient.
 * Signed out, or the account's hour up, it opens on a welcome whose Continue
 * starts the account's sign-in; signed in, on the account's servers.
 */
@Composable
fun rememberCloudConnect(graph: AppGraph, nav: NavHostController): (() -> Unit)? {
    val account = graph.cloudAccount ?: return null
    return remember(account, nav) {
        {
            // A pass whose hour is up signs out here: the + opens on the sign-in, not a picker that would refuse.
            account.signedIn()
            nav.navigate(CloudRoute) { launchSingleTop = true }
        }
    }
}

fun NavGraphBuilder.cloudRoutes(graph: AppGraph, nav: NavHostController) {
    val account = graph.cloudAccount ?: return
    page<CloudRoute> { Cloud(graph, account, nav) }
    page<CloudCreateRoute> { entry -> CloudCreate(graph, account, nav, entry.toRoute<CloudCreateRoute>().first) }
    page<CloudJoinRoute> { CloudJoin(graph, account, nav) }
    page<CloudMembersRoute> { entry -> CloudMembers(graph, nav, entry.toRoute<CloudMembersRoute>().connectionId) }
    page<MemberProfileRoute> { entry -> MemberProfileEntry(graph, nav, entry.toRoute<MemberProfileRoute>()) }
    page<CloudInstructionsRoute> { entry -> CloudInstructions(graph, nav, entry.toRoute<CloudInstructionsRoute>().connectionId) }
    cloudProviderRoutes(graph, nav)
    cloudComputePoolRoutes(graph, nav)
    cloudPushSettingsRoutes(graph, nav)
}

/**
 * Opens [server]: this person's connection to it if the phone has one,
 * else signs in to it with a token from the account, no browser.
 */
fun NavHostController.openCloudServer(graph: AppGraph, server: CloudServer) {
    val origin = server.origin ?: return
    val existing = HappyCloud.connection(graph.agentConnections.accounts.value, origin, graph.openAgentId.value)
    when {
        existing == null -> {
            graph.startServerSignIn(origin, cloudId = server.id)
            navigate(ServerSignInRoute) { popUpTo(CloudRoute); launchSingleTop = true }
        }
        existing.signInRequired -> {
            graph.startServerSignIn(origin, replacing = existing.id, cloudId = server.id)
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
    // Back from the Auth Tab with the redirect; a cancel leaves the welcome as it is, its button ready again.
    val authTab = rememberLauncherForActivityResult(AuthTabIntent.AuthenticateUserResultContract()) { result ->
        if (result.resultCode == AuthTabIntent.RESULT_OK) result.resultUri?.let { graph.oauthCallback(it.toString()) }
    }
    val openBrowser = { openAuthTab(context, authTab, account.browserUrl(), dark) }
    val accounts by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    LaunchedEffect(state) { if (state == CloudAccountState.SignedIn) picker.load() }
    // No servers yet: Bootstrap leads, and its Back signs out (desktop's create with nothing to go back to).
    LaunchedEffect(state, picker.servers) {
        if (state == CloudAccountState.SignedIn && picker.servers?.isEmpty() == true) {
            nav.navigate(CloudCreateRoute(first = true)) { launchSingleTop = true }
        }
    }
    // A join from the list signs in here, without leaving it; what needs the person (a name, a failure) goes to the sign-in screen.
    val flow by graph.serverSignIn.collectAsStateWithLifecycle()
    val signIn = key(flow) { flow?.state?.collectAsStateWithLifecycle()?.value }
    LaunchedEffect(signIn) {
        val server = picker.joining ?: return@LaunchedEffect
        when (signIn) {
            is ServerSignInState.Done -> {
                flow?.let(graph::endServerSignIn)
                picker.joined(server)
            }
            is ServerSignInState.NeedsName, is ServerSignInState.Failed, is ServerSignInState.Ready, is ServerSignInState.InBrowser -> {
                picker.gaveUp(server)
                nav.navigate(ServerSignInRoute) { launchSingleTop = true }
            }
            is ServerSignInState.Checking, is ServerSignInState.Finishing, null -> Unit
        }
    }
    val signOut = {
        if (picker.joining == null) {
            picker.forget()
            account.signOut()
        }
    }
    // Back leaves the account for the welcome while signed in, then leaves Happy Cloud.
    BackHandler(enabled = state == CloudAccountState.SignedIn) { signOut() }
    CloudScreen(
        state = state,
        servers = picker.servers,
        failure = picker.failure,
        here = accounts.filter { !it.signInRequired }.mapNotNull { it.server }.toSet(),
        joins = picker.joins,
        image = account::image,
        onOpenBrowser = openBrowser,
        signInWithPassword = account::signInWithPassword,
        onReload = picker::load,
        onJoinServer = { server ->
            val origin = server.origin
            if (origin != null && picker.joining == null) {
                val existing = HappyCloud.connection(accounts, origin, graph.openAgentId.value)
                picker.join(server.id)
                graph.startServerSignIn(origin, replacing = existing?.takeIf { it.signInRequired }?.id, cloudId = server.id)
            }
        },
        onContinue = {
            val servers = picker.servers.orEmpty()
            val here = accounts.filter { !it.signInRequired }.mapNotNull { it.server }.toSet()
            (servers.firstOrNull { it.id == picker.lastJoined } ?: servers.firstOrNull { it.origin in here })?.let { nav.openCloudServer(graph, it) }
        },
        onCreate = { nav.navigate(CloudCreateRoute()) },
        onInvite = { nav.navigate(CloudJoinRoute) },
        onSignOut = signOut,
        onBack = { nav.popBackStack() },
    )
}

/** The account's servers, loaded each time the list shows, and those joined from it. */
private class CloudServers(private val account: CloudAccount) : ViewModel() {
    var servers by mutableStateOf<List<CloudServer>?>(null)
        private set
    var failure by mutableStateOf<CloudException.Reason?>(null)
        private set
    val joins = mutableStateMapOf<String, CloudJoin>()
    /** The server being joined now, by id: one sign-in at a time. */
    val joining: String? get() = joins.entries.firstOrNull { it.value == CloudJoin.Joining }?.key
    /** The server joined last, which Continue opens. */
    var lastJoined by mutableStateOf<String?>(null)
        private set

    fun load() {
        failure = null
        // Not the last account's list while this one's comes: an empty one would lead to Bootstrap.
        servers = null
        viewModelScope.launch {
            try {
                servers = account.servers()
            } catch (e: CloudException) {
                failure = e.reason
            }
        }
    }

    fun join(id: String) {
        joins[id] = CloudJoin.Joining
    }

    fun joined(id: String) {
        joins[id] = CloudJoin.Joined
        lastJoined = id
    }

    fun gaveUp(id: String) {
        joins.remove(id)
    }

    /** Signing out: the next account's joins are its own. */
    fun forget() {
        joins.clear()
        lastJoined = null
    }
}

@Composable
private fun CloudCreate(graph: AppGraph, account: CloudAccount, nav: NavHostController, first: Boolean) {
    // The first server, with none to go back to: Back leaves the account for the welcome, as the list's does.
    val back = { if (first) account.signOut(); nav.popBackStack(); Unit }
    BackHandler(enabled = first) { back() }
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
        } catch (e: CloudException) {
            if (e.reason == CloudException.Reason.SignInRequired) nav.popBackStack(CloudRoute, inclusive = false)
            null
        }
    }
    CloudCreateScreen(
        name = name,
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
                    if (e.reason == CloudException.Reason.SignInRequired) nav.popBackStack(CloudRoute, inclusive = false)
                    failure = e.reason
                    if (e.reason == CloudException.Reason.Taken) availability = CloudName.Taken
                } finally {
                    busy = false
                }
            }
        },
        onBack = back,
        first = first,
        onInvite = { nav.navigate(CloudJoinRoute) },
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
                    if (e.reason == CloudException.Reason.SignInRequired) nav.popBackStack(CloudRoute, inclusive = false)
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

/**
 * The account's sign-in in the app, never the external browser: an Auth Tab,
 * ephemeral (no cookie of the browser's comes in, so after Back signs out
 * the next sign-in can pick another GitHub account), which hands the
 * `happy://` redirect straight back to [launcher]. A browser without Auth
 * Tab opens it as a Custom Tab, whose redirect comes through MainActivity as
 * any sign-in's does.
 */
internal fun openAuthTab(context: android.content.Context, launcher: ActivityResultLauncher<android.content.Intent>, url: String, dark: Boolean) {
    val intent = AuthTabIntent.Builder()
        .setEphemeralBrowsingEnabled(true)
        .setColorScheme(if (dark) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT)
        .build()
    try {
        intent.launch(launcher, android.net.Uri.parse(url), ServerSignInFlow.REDIRECT_SCHEME)
    } catch (_: android.content.ActivityNotFoundException) {
        android.widget.Toast.makeText(context, R.string.team_server_no_browser, android.widget.Toast.LENGTH_LONG).show()
    }
}
