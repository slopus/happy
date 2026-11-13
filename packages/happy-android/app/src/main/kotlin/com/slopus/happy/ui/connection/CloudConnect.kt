package com.slopus.happy.ui.connection

import android.os.SystemClock
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
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.PolicyDocument
import com.slopus.happy.connection.CloudAccount
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudInvite
import com.slopus.happy.connection.inviteImage
import com.slopus.happy.connection.CloudName
import com.slopus.happy.connection.CloudProvider
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.connection.GoogleSignIn
import com.slopus.happy.connection.EmailSignIn
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.connection.ServerSignInFlow
import com.slopus.happy.connection.ServerSignInState
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.page
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Happy Cloud: the account's sign-in, then its servers. */
@Serializable data object CloudRoute

/** Bootstrap a server; [first] when the account has none, where Back signs out. */
@Serializable data class CloudCreateRoute(val first: Boolean = false)

/** An invite link's Join screen; its token waits in [CloudInvites], never in the route. */
@Serializable data object CloudInviteRoute

/** Continue with email: the address, then [CloudEmailCodeRoute] for the code mailed to it. */
@Serializable data object CloudEmailRoute

@Serializable data class CloudEmailCodeRoute(val email: String)

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
    page<CloudInviteRoute> { CloudInviteEntry(graph, account, nav) }
    page<CloudEmailRoute> { CloudEmailStart(account, nav) }
    page<CloudEmailCodeRoute> { entry -> CloudEmailCode(account, nav, entry.toRoute<CloudEmailCodeRoute>().email) }
    page<CloudMembersRoute> { entry -> CloudMembers(graph, nav, entry.toRoute<CloudMembersRoute>().connectionId) }
    page<MemberProfileRoute> { entry -> MemberProfileEntry(graph, nav, entry.toRoute<MemberProfileRoute>()) }
    page<CloudInstructionsRoute> { entry -> CloudInstructions(graph, nav, entry.toRoute<CloudInstructionsRoute>().connectionId) }
    page<PolicyDocumentRoute> { entry ->
        val route = entry.toRoute<PolicyDocumentRoute>()
        PolicyDocument.of(route.document)?.let { PolicyDocumentPage(graph, nav, route.connectionId, it) }
    }
    cloudProviderRoutes(graph, nav)
    cloudComputeRoutes(graph, nav)
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
    val openBrowser = { provider: CloudProvider -> openAuthTab(context, authTab, account.browserUrl(provider), dark) }
    // Google's own sheet; with no Google account or Play services here, Google's sign-in in the Auth Tab instead.
    val google = remember { GoogleSignIn() }
    val scope = rememberCoroutineScope()
    val signInWithGoogle = {
        scope.launch {
            if (!account.signInWithGoogle { nonce -> google.credential(context, nonce) }) openBrowser(CloudProvider.Google)
        }
        Unit
    }
    val accounts by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    LaunchedEffect(state) {
        if (state != CloudAccountState.SignedIn) return@LaunchedEffect
        // Signed in for an invite link: back to its Join screen, which accepts it.
        if (nav.popBackStack<CloudInviteRoute>(inclusive = false)) return@LaunchedEffect
        picker.load()
        // Back from the browser, where an invite link may have added a server.
        serversOnReturn(graph.isForeground, account::servers).collect(picker::show)
    }
    // No servers yet: Bootstrap leads, and its Back signs out (desktop's create with nothing to go back to).
    LaunchedEffect(state, picker.servers) {
        if (state == CloudAccountState.SignedIn && picker.servers?.isEmpty() == true && nav.currentDestination?.hasRoute<CloudRoute>() == true) {
            // Not this empty list again on the way back: it loads anew, with any server joined in the browser meanwhile.
            picker.clear()
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
        onSignInWithGoogle = signInWithGoogle,
        onEmail = { nav.navigate(CloudEmailRoute) { launchSingleTop = true } },
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
        onSignOut = signOut,
        onBack = { nav.popBackStack() },
    )
}

/**
 * The account's servers each time the app comes back to the foreground, not
 * the foreground it is in now: an invite is a link, accepted in the browser,
 * which adds its server there. One that fails to load is skipped.
 */
internal fun serversOnReturn(foreground: StateFlow<Boolean>, servers: suspend () -> List<CloudServer>): Flow<List<CloudServer>> =
    foreground.drop(1).filter { it }.mapNotNull {
        try {
            servers()
        } catch (_: CloudException) {
            null
        }
    }

/** The account's servers, loaded each time the list shows or the app comes back, and those joined from it. */
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

    /** Loaded again on the app's return: the list stays as it is meanwhile. */
    fun show(servers: List<CloudServer>) {
        failure = null
        this.servers = servers
    }

    fun clear() {
        servers = null
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
    // The account's first server, joined from an invite link in the browser meanwhile: Join a server takes this one's place, still signed in.
    if (first) LaunchedEffect(Unit) {
        serversOnReturn(graph.isForeground, account::servers).first { it.isNotEmpty() }
        nav.popBackStack(CloudRoute, inclusive = false)
    }
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
    )
}

/** The open invite's flow, kept across the sign-in it may need; a newer link's replaces it. */
private class CloudInviteHolder(private val account: CloudAccount) : ViewModel() {
    var flow by mutableStateOf<CloudInviteFlow?>(null)
        private set
    private var scope: CoroutineScope? = null

    fun open(invite: CloudInvite) {
        scope?.cancel()
        val next = CoroutineScope(viewModelScope.coroutineContext + Job(viewModelScope.coroutineContext[Job]))
        scope = next
        flow = CloudInviteFlow(invite, account, next)
    }
}

@Composable
private fun CloudInviteEntry(graph: AppGraph, account: CloudAccount, nav: NavHostController) {
    val holder = viewModel { CloudInviteHolder(account) }
    val incoming by CloudInvites.pending.collectAsStateWithLifecycle()
    LaunchedEffect(incoming) {
        CloudInvites.take()?.let(holder::open)
        // Restored after the process went: the token went with it.
        if (holder.flow == null) nav.popBackStack()
    }
    // A pass whose hour is up signs out here, so Join asks for the sign-in rather than failing.
    LaunchedEffect(Unit) { account.signedIn() }
    val flow = holder.flow ?: return
    val state by account.state.collectAsStateWithLifecycle()
    val step = flow.step
    LaunchedEffect(step) {
        val joined = step as? CloudInviteStep.Joined ?: return@LaunchedEffect
        nav.popBackStack<CloudInviteRoute>(inclusive = true)
        nav.openCloudServer(graph, joined.server)
    }
    val signIn = { nav.navigate(CloudRoute) { launchSingleTop = true } }
    CloudInviteScreen(
        step = step,
        signedIn = state == CloudAccountState.SignedIn,
        image = { url -> inviteImage(url) ?: account.image(url) },
        onJoin = { flow.join(signIn) },
        onRetry = flow::load,
        onOtherAccount = {
            account.signOut()
            flow.signInAgain(signIn)
        },
        onBack = { nav.popBackStack() },
    )
}

/**
 * Continue with email's first step: Send code mails one to the address and
 * opens its code step. A 429 holds Send code for its `Retry-After`.
 */
@Composable
private fun CloudEmailStart(account: CloudAccount, nav: NavHostController) {
    var email by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var outcome by remember { mutableStateOf<EmailSignIn?>(null) }
    var waitUntil by rememberSaveable { mutableLongStateOf(0L) }
    val wait = secondsUntil(waitUntil)
    val scope = rememberCoroutineScope()
    CloudEmailScreen(
        email = email,
        busy = busy,
        outcome = outcome,
        wait = wait,
        onEmail = { email = it; outcome = null },
        onSend = {
            val address = email.trim()
            busy = true
            outcome = null
            scope.launch {
                try {
                    when (val answer = account.startEmail(address)) {
                        EmailSignIn.Sent -> nav.navigate(CloudEmailCodeRoute(address)) { launchSingleTop = true }
                        else -> {
                            if (answer is EmailSignIn.RateLimited) waitUntil = SystemClock.elapsedRealtime() + answer.seconds * 1000
                            outcome = answer
                        }
                    }
                } finally {
                    busy = false
                }
            }
        },
        onBack = { nav.popBackStack() },
    )
}

/**
 * Continue with email's code step, for [email]: the code is checked as its
 * sixth digit comes, and the account is signed in as with a password, back
 * to Happy Cloud's servers; a wrong code is cleared. Resend waits a minute after each code, and a
 * 429 holds Verify and Resend for its `Retry-After`.
 */
@Composable
private fun CloudEmailCode(account: CloudAccount, nav: NavHostController, email: String) {
    var code by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var outcome by remember { mutableStateOf<EmailSignIn?>(null) }
    // The first code was sent on the way here.
    var resendUntil by rememberSaveable { mutableLongStateOf(SystemClock.elapsedRealtime() + CloudEmail.RESEND_SECONDS * 1000) }
    var waitUntil by rememberSaveable { mutableLongStateOf(0L) }
    val wait = secondsUntil(waitUntil)
    val resendWait = secondsUntil(resendUntil)
    val scope = rememberCoroutineScope()
    fun ask(call: suspend () -> EmailSignIn) {
        busy = true
        outcome = null
        scope.launch {
            try {
                when (val answer = call()) {
                    EmailSignIn.SignedIn -> nav.popBackStack(CloudRoute, inclusive = false)
                    else -> {
                        when (answer) {
                            is EmailSignIn.RateLimited -> waitUntil = SystemClock.elapsedRealtime() + answer.seconds * 1000
                            EmailSignIn.Sent -> resendUntil = SystemClock.elapsedRealtime() + CloudEmail.RESEND_SECONDS * 1000
                            // Cleared for the next try, the keyboard still up.
                            EmailSignIn.InvalidCode -> code = ""
                            else -> Unit
                        }
                        outcome = answer
                    }
                }
            } finally {
                busy = false
            }
        }
    }
    val verify = { if (!busy && wait <= 0 && code.length == CloudEmail.CODE_LENGTH) ask { account.verifyEmail(email, code) } }
    CloudEmailCodeScreen(
        email = email,
        code = code,
        busy = busy,
        outcome = outcome,
        wait = wait,
        resendWait = resendWait,
        onCode = onCode@{ typed ->
            if (busy) return@onCode
            val complete = typed.length == CloudEmail.CODE_LENGTH && code.length != CloudEmail.CODE_LENGTH
            code = typed
            if (typed.length < CloudEmail.CODE_LENGTH) outcome = null
            // The sixth digit, typed or filled in, checks it: nothing more to press.
            if (complete) verify()
        },
        onVerify = verify,
        onResend = { ask { account.startEmail(email) } },
        onChangeEmail = { nav.popBackStack() },
        onBack = { nav.popBackStack() },
    )
}

/** Whole seconds left until [until] (elapsed realtime), counting down each second; 0 once it is past. */
@Composable
private fun secondsUntil(until: Long): Long {
    fun left() = ((until - SystemClock.elapsedRealtime() + 999) / 1000).coerceAtLeast(0)
    var seconds by remember(until) { mutableLongStateOf(left()) }
    LaunchedEffect(until) {
        while (seconds > 0) {
            // To the next whole second left.
            delay((until - SystemClock.elapsedRealtime()).mod(1000L).takeIf { it > 0 } ?: 1000L)
            seconds = left()
        }
    }
    return seconds
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
