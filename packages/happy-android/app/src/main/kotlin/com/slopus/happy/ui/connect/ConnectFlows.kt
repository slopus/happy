package com.slopus.happy.ui.connect

import com.slopus.happy.analytics.AnalyticsReasons
import com.slopus.happy.connection.PairingStart
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.analytics.SignInMethod
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.TERMINAL_URL_PREFIX
import com.slopus.happy.auth.approveAccountLink
import com.slopus.happy.auth.approveTerminal
import com.slopus.happy.crypto.AccountLink
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.connection.ServerInvite
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * One connect flow on screen: scan a QR code or take a pasted link, approve
 * it, and say so. [rememberTerminalConnect] and [rememberAccountLink] make
 * them; each shows its own alerts while it is composed.
 */
@Stable
class ConnectFlow internal constructor(
    private val kind: ConnectKind,
    private val scope: CoroutineScope,
) {
    /** A link is being approved (the hooks' `isLoading`). */
    var isLoading by mutableStateOf(false)
        internal set

    internal var alert by mutableStateOf<Alert?>(null)
    internal var errorTitle = ""
    internal var okTitle = ""
    internal var messages = ScanMessages()
    internal var scanner: QrScanner = QrScanner { ScanResult.Cancelled }

    /** What the scanner's ⋮ offers (Add's other ways in); empty, no ⋮. */
    internal var request = ScanRequest()

    /** Restore or the server, picked from the scanner's ⋮; a pasted link is the flow's own prompt. */
    internal var onWay: (ScannerWay) -> Unit = {}
    internal var connectAgent: ((String, PairingStart) -> Unit)? = null

    /**
     * A team server's code, from any scanner: opens that server or signs in
     * to it (edge SSO §8). False when it can't: a new server under a path
     * prefix.
     */
    internal var signInToServer: ((ServerInvite) -> Boolean)? = null

    /** Asked before a terminal code is approved; false leaves it (the migration screen's Happy server code). */
    internal var confirmTerminal: (suspend () -> Boolean)? = null

    /** No scanner on this device: instead of saying so, Add asks for the link. */
    internal var onUnavailable: (() -> Unit)? = null

    /** Add's "Enter link manually" prompt is open. */
    var enteringLink by mutableStateOf(false)
    internal var process: suspend (String) -> Boolean = { false }
    private var scanning = false

    /**
     * connectTerminal / connectAccount: opens the scanner and routes the
     * code it reads ([route]). Only a cancel does nothing. Unlike happy-app,
     * a code of another kind or a failed scan says so.
     */
    fun scan() {
        if (scanning) return
        scanning = true
        scope.launch {
            try {
                when (val result = scanner.scan(request)) {
                    ScanResult.Cancelled -> Unit
                    is ScanResult.Chose -> if (result.way == ScannerWay.EnterLink) enteringLink = true else onWay(result.way)
                    is ScanResult.Failed -> onUnavailable?.invoke() ?: run { alert = errorAlert(messages.failure(result.reason)) }
                    is ScanResult.Scanned -> route(result.value, PairingStart.Scan)
                }
            } finally {
                scanning = false
            }
        }
    }

    /**
     * A scanned code by kind: this flow's own is approved, a Protocol V2
     * pairing code starts pairing, and anything else is an alert naming
     * where it belongs.
     */
    internal suspend fun route(text: String, start: PairingStart) {
        when (val code = HappyCode.classify(text)) {
            is HappyCode.AgentPairing -> connectAgent?.invoke(code.text, start)
                ?: run { alert = errorAlert(messages.pairingUnavailable) }
            is HappyCode.Terminal -> when {
                kind != ConnectKind.Terminal && kind != ConnectKind.Add -> alert = errorAlert(messages.terminalElsewhere)
                confirmTerminal?.invoke() != false -> process(code.url)
            }
            is HappyCode.Account -> when (kind) {
                ConnectKind.Account -> process(code.url)
                ConnectKind.Add -> alert = Alert(messages.accountSignedOutTitle, messages.accountSignedOut, listOf(AlertButton(okTitle)))
                else -> alert = errorAlert(messages.accountElsewhere)
            }
            is HappyCode.Server -> {
                val signIn = signInToServer
                val invite = ServerInvite.parse(code.text)
                when {
                    // Only outside the app's root, which always provides it.
                    signIn == null -> alert = errorAlert(messages.notHappy)
                    invite == null -> alert = errorAlert(messages.serverInvalid)
                    // Opened if connected already; else, under a path prefix, not reachable yet.
                    !signIn(invite) -> alert = errorAlert(messages.serverAtPath)
                }
            }
            is HappyCode.NotHappy, is HappyCode.UnknownHappy -> alert = errorAlert(messages.notHappy)
        }
    }

    /**
     * connectWithUrl: a pasted link, routed by [route] exactly as the same
     * code read by the camera is, so typing a terminal link into Link New
     * Device names the screen it belongs to instead of calling it invalid.
     * Two read differently: a link of no kind this app knows is "Invalid
     * authentication URL", since nothing was scanned, and a team server's
     * is refused, since one is taken only from the camera.
     */
    fun connectWithUrl(url: String) {
        scope.launch {
            when (val code = HappyCode.classify(url)) {
                is HappyCode.NotHappy, is HappyCode.UnknownHappy -> alert = errorAlert(messages.invalidUrl)
                // A team server is added only from the camera (contract §8), never a pasted link.
                is HappyCode.Server -> alert = errorAlert(messages.serverScanOnly)
                else -> route(url, PairingStart.PasteLink)
            }
        }
    }

    /** processAuthUrl, awaited. True when the link was approved. */
    suspend fun processAuthUrl(url: String): Boolean = process(url)

    internal fun errorAlert(message: String) = Alert(errorTitle, message, listOf(AlertButton(okTitle)))
}

/** Which code a [ConnectFlow] approves itself. */
enum class ConnectKind(val prefix: String) {
    Terminal(TERMINAL_URL_PREFIX),
    Account(AccountLink.URL_PREFIX),

    /**
     * Add, from the first screen or the account menu: a terminal code
     * creates an account that approves it, a pairing code pairs, an account
     * code says it needs a signed-in phone.
     */
    Add(TERMINAL_URL_PREFIX),
}

/** What a scan that can't be approved here says. */
internal data class ScanMessages(
    val unavailable: String = "",
    val noCamera: String = "",
    val cameraFailed: String = "",
    val notHappy: String = "",
    val terminalElsewhere: String = "",
    val accountElsewhere: String = "",
    val pairingUnavailable: String = "",
    val accountSignedOutTitle: String = "",
    val accountSignedOut: String = "",
    val invalidUrl: String = "",
    val serverInvalid: String = "",
    val serverAtPath: String = "",
    val serverScanOnly: String = "",
) {
    /** What a scan that couldn't run says, by [reason]. */
    fun failure(reason: ScanFailure) = when (reason) {
        ScanFailure.NoCamera -> noCamera
        ScanFailure.CameraFailed -> cameraFailed
        ScanFailure.Unavailable -> unavailable
    }
}

/**
 * useConnectTerminal.ts: connects a terminal (the CLI or Happy Desktop) to
 * this account. Success is felt, not announced (a haptic, then [onSuccess]);
 * a failure is an alert unless [onError] reports it in the caller's own UI.
 */
@Composable
fun rememberTerminalConnect(
    graph: AppGraph,
    onSuccess: () -> Unit = {},
    onError: (() -> Unit)? = null,
): ConnectFlow = rememberTerminalConnect(
    approve = { url ->
        val account = graph.auth.state.value as? AuthState.SignedIn ?: error("Signed out")
        approveTerminal(graph.authApi, account.credentials, account.encryption, url)
    },
    onSuccess = onSuccess,
    onError = onError,
)

/** [rememberTerminalConnect] with the approval passed in, for tests. */
@Composable
fun rememberTerminalConnect(
    approve: suspend (url: String) -> Unit,
    onSuccess: () -> Unit = {},
    onError: (() -> Unit)? = null,
): ConnectFlow {
    val haptics = LocalHapticFeedback.current
    val currentOnSuccess by rememberUpdatedState(onSuccess)
    val currentOnError by rememberUpdatedState(onError)
    val failed = stringResource(R.string.modals_failed_to_connect_terminal)
    return rememberConnectFlow(ConnectKind.Terminal, approve) { flow, error ->
        if (error == null) {
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            currentOnSuccess()
        } else {
            val handler = currentOnError
            if (handler != null) handler() else flow.alert = flow.errorAlert(failed)
        }
    }
}

/**
 * useConnectAccount.ts: Settings › Account › Link New Device. Approves a
 * new phone that shows `happy:///account?…` by handing it this account's
 * secret. Success and failure are both alerts; [onSuccess] runs when the
 * success alert is closed.
 */
@Composable
fun rememberAccountLink(
    graph: AppGraph,
    onSuccess: () -> Unit = {},
    onError: () -> Unit = {},
): ConnectFlow = rememberAccountLink(
    approve = { url ->
        val account = graph.auth.state.value as? AuthState.SignedIn ?: error("Signed out")
        approveAccountLink(graph.authApi, account.credentials, url)
    },
    onSuccess = onSuccess,
    onError = onError,
)

/** [rememberAccountLink] with the approval passed in, for tests. */
@Composable
fun rememberAccountLink(
    approve: suspend (url: String) -> Unit,
    onSuccess: () -> Unit = {},
    onError: () -> Unit = {},
): ConnectFlow {
    val currentOnSuccess by rememberUpdatedState(onSuccess)
    val currentOnError by rememberUpdatedState(onError)
    val successTitle = stringResource(R.string.common_success)
    val linked = stringResource(R.string.modals_device_linked_successfully)
    val ok = stringResource(R.string.common_ok)
    val failed = stringResource(R.string.modals_failed_to_link_device)
    return rememberConnectFlow(ConnectKind.Account, approve) { flow, error ->
        if (error == null) {
            flow.alert = Alert(successTitle, linked, listOf(AlertButton(ok) { currentOnSuccess() }))
        } else {
            flow.alert = flow.errorAlert(failed)
            currentOnError()
        }
    }
}

@Composable
private fun rememberConnectFlow(
    kind: ConnectKind,
    approve: suspend (String) -> Unit,
    onResult: (flow: ConnectFlow, error: Throwable?) -> Unit,
): ConnectFlow {
    val scope = rememberCoroutineScope()
    val flow = remember(kind) { ConnectFlow(kind, scope) }
    val currentApprove by rememberUpdatedState(approve)
    val currentOnResult by rememberUpdatedState(onResult)
    val error = stringResource(R.string.common_error)
    val ok = stringResource(R.string.common_ok)
    val invalid = stringResource(R.string.modals_invalid_auth_url)
    flow.errorTitle = error
    flow.okTitle = ok
    flow.messages = ScanMessages(
        unavailable = stringResource(R.string.scan_unavailable),
        noCamera = stringResource(R.string.scan_no_camera),
        cameraFailed = stringResource(R.string.scan_camera_failed),
        notHappy = stringResource(R.string.scan_not_happy_code),
        terminalElsewhere = stringResource(R.string.scan_terminal_code_elsewhere),
        accountElsewhere = stringResource(R.string.scan_account_code_elsewhere),
        pairingUnavailable = stringResource(R.string.scan_pairing_unavailable),
        accountSignedOutTitle = stringResource(R.string.account_kind_device_needs_account_title),
        accountSignedOut = stringResource(R.string.account_kind_device_needs_cli_account),
        invalidUrl = invalid,
        serverInvalid = stringResource(R.string.team_server_code_invalid),
        serverAtPath = stringResource(R.string.team_server_code_path),
        serverScanOnly = stringResource(R.string.team_server_code_scan_only),
    )
    flow.scanner = rememberQrScanner()
    flow.connectAgent = LocalAgentPairing.current
    flow.signInToServer = com.slopus.happy.ui.connection.LocalServerSignIn.current
    val prefix = kind.prefix
    flow.process = process@{ url ->
        if (!url.startsWith(prefix)) {
            flow.alert = flow.errorAlert(invalid)
            return@process false
        }
        flow.isLoading = true
        try {
            currentApprove(url)
            currentOnResult(flow, null)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("ConnectFlow", "Approving $prefix failed", e)
            currentOnResult(flow, e)
            false
        } finally {
            flow.isLoading = false
        }
    }
    flow.alert?.let { HappyAlert(it, onDismiss = { flow.alert = null }) }
    return flow
}

/**
 * Add: the first screen's Connect and the account menu's Add
 * ([ConnectKind.Add]). A terminal code creates a Happy account and
 * approves the terminal with it in one step; the account is kept only if
 * the approval went through, and it opens. A pairing code pairs an agent.
 * Without a scanner, or from the first screen's menu, it asks for the link
 * instead ([ConnectFlow.enteringLink]). A failure is an alert. The
 * scanner's ⋮ has the other ways in (iOS's `AccountAdding.otherWays`): the
 * link, [onRestore], [onServer], whose custom host [serverLabel] names, and
 * Get help, which the scanner shows itself.
 */
@Composable
fun rememberAddFlow(graph: AppGraph, onRestore: () -> Unit, onServer: () -> Unit, serverLabel: String?): ConnectFlow = rememberAddConnect(
    approve = { url ->
        AnalyticsReasons.signingIn(SignInMethod.RelayCreate) {
            graph.auth.createAccount { account -> approveTerminal(graph.authApi, account.credentials, account.encryption, url) }
        }
    },
    onRestore = onRestore,
    onServer = onServer,
    serverLabel = serverLabel,
)

/** [rememberAddFlow] with the approval passed in, for tests. */
@Composable
fun rememberAddConnect(
    approve: suspend (url: String) -> Unit,
    onRestore: () -> Unit = {},
    onServer: () -> Unit = {},
    serverLabel: String? = null,
): ConnectFlow {
    val haptics = LocalHapticFeedback.current
    val failed = stringResource(R.string.modals_failed_to_connect_terminal)
    val flow = rememberConnectFlow(ConnectKind.Add, approve) { flow, error ->
        if (error == null) haptics.performHapticFeedback(HapticFeedbackType.Confirm) else flow.alert = flow.errorAlert(failed)
    }
    flow.onUnavailable = { flow.enteringLink = true }
    val currentOnRestore by rememberUpdatedState(onRestore)
    val currentOnServer by rememberUpdatedState(onServer)
    flow.request = ScanRequest(listOf(ScannerWay.EnterLink, ScannerWay.Restore, ScannerWay.Server, ScannerWay.Help), serverLabel)
    flow.onWay = { way ->
        when (way) {
            ScannerWay.Server -> currentOnServer()
            ScannerWay.Restore -> currentOnRestore()
            // Get help is answered in the scanner, and a link is asked for before this.
            ScannerWay.Help, ScannerWay.EnterLink -> Unit
        }
    }
    if (flow.enteringLink) {
        PromptModal(
            prompt = Prompt(
                title = stringResource(R.string.start_enter_link_title),
                message = stringResource(R.string.account_kind_enter_link_message),
                placeholder = "happy://…",
                confirmText = stringResource(R.string.start_connect),
                onResult = { url -> url?.trim()?.takeIf { it.isNotEmpty() }?.let(flow::connectWithUrl) },
            ),
            onDismiss = { flow.enteringLink = false },
        )
    }
    return flow
}

/** The app's one Add flow, provided by HappyApp; null where nothing provides it (tests). */
val LocalAddFlow: ProvidableCompositionLocal<ConnectFlow?> = compositionLocalOf { null }

/**
 * Settings' "Enter URL manually" (SettingsView.tsx): the prompt for a
 * terminal's auth link, then [flow]'s `connectWithUrl`. Show it while the
 * row's state says so; [onDismiss] runs when it closes either way.
 */
@Composable
fun EnterTerminalUrlPrompt(flow: ConnectFlow, onDismiss: () -> Unit) {
    PromptModal(
        prompt = Prompt(
            title = stringResource(R.string.modals_authenticate_terminal),
            message = stringResource(R.string.modals_paste_url_from_terminal),
            placeholder = "happy://terminal?...",
            confirmText = stringResource(R.string.common_authenticate),
            onResult = { url -> url?.trim()?.takeIf { it.isNotEmpty() }?.let(flow::connectWithUrl) },
        ),
        onDismiss = onDismiss,
    )
}
