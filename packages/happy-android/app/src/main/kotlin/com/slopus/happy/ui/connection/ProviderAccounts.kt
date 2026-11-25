package com.slopus.happy.ui.connection

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.chat.compactAgo
import com.slopus.happy.agent.ProviderCredential
import com.slopus.happy.agent.AccountStatus
import com.slopus.happy.agent.AccountLine
import com.slopus.happy.agent.AccountDot
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.CredentialSource
import com.slopus.happy.agent.ProviderAccount
import com.slopus.happy.agent.ProviderAccounts
import com.slopus.happy.agent.ProviderAccountsState
import com.slopus.happy.agent.ProviderSignIn
import com.slopus.happy.agent.ProviderSignInException
import com.slopus.happy.agent.ProviderSignInRefusal
import com.slopus.happy.agent.ProviderSignInRun
import com.slopus.happy.agent.ProviderSignIns
import com.slopus.happy.agent.SignInFailure
import com.slopus.happy.agent.SignInStep
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.model.providerIconKind
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ProviderIcon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.page
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Settings › Provider accounts of [connectionId]. */
@Serializable data class ProviderAccountsRoute(val connectionId: String)

/** One account's page: on or off, its login, and signing it in again. */
@Serializable data class ProviderAccountRoute(val connectionId: String, val providerId: String)

/** Signing account [providerId] in again. */
@Serializable data class ProviderSignInRoute(val connectionId: String, val providerId: String)

/** A Claude account's setup token. */
@Serializable data class ProviderTokenRoute(val connectionId: String, val providerId: String)

object ProviderAccountsTags {
    const val ROW = "agentSettings.providerAccounts"
    const val LOADING = "providerAccounts.loading"
    const val LIST = "providerAccounts.list"
    const val EMPTY = "providerAccounts.empty"
    const val FAILED = "providerAccounts.failed"
    const val ENABLED = "providerAccount.enabled"
    const val LAST_REFRESH = "providerAccount.lastRefresh"
    const val EXPIRES = "providerAccount.expires"
    const val REFRESH_ERROR = "providerAccount.refreshError"
    const val LAST_CHECKED = "providerAccount.lastChecked"
    const val CODE = "providerSignIn.code"
    const val COPY = "providerSignIn.copy"
    const val OPEN = "providerSignIn.open"
    const val FIELD = "providerSignIn.field"
    const val SUBMIT = "providerSignIn.submit"
    const val CANCEL = "providerSignIn.cancel"
    const val DONE = "providerSignIn.done"
    const val FAILURE = "providerSignIn.failure"
    const val RETRY = "providerSignIn.retry"
    const val STARTING = "providerSignIn.starting"
    fun account(id: String) = "providerAccounts.account.$id"
    fun dot(id: String) = "providerAccounts.dot.$id"
    fun source(id: String) = "providerAccounts.source.$id"
    fun signIn(id: String) = "providerAccounts.signIn.$id"
    fun token(id: String) = "providerAccounts.token.$id"
}

fun NavGraphBuilder.providerAccountRoutes(graph: AppGraph, nav: NavHostController) = providerAccountRoutes(nav) { connectionId ->
    remember(connectionId) { graph.agentSessions.session(connectionId)?.providerAccounts }
}

/** The provider account pages, each reading its connection's accounts through [accounts] (a debug fixture passes its own). */
fun NavGraphBuilder.providerAccountRoutes(nav: NavHostController, accounts: @Composable (connectionId: String) -> ProviderAccounts?) {
    page<ProviderAccountsRoute> { entry ->
        val connectionId = entry.toRoute<ProviderAccountsRoute>().connectionId
        val source = accounts(connectionId)
        if (source == null) ProviderAccountsScreen(ProviderAccountsState.Failed, emptyMap(), now = 0, onBack = { nav.popBackStack() })
        else ProviderAccountsPage(source, nav, connectionId)
    }
    page<ProviderAccountRoute> { entry ->
        val route = entry.toRoute<ProviderAccountRoute>()
        accounts(route.connectionId)?.let { ProviderAccountPage(it, nav, route.connectionId, route.providerId) }
    }
    page<ProviderSignInRoute> { entry ->
        val route = entry.toRoute<ProviderSignInRoute>()
        accounts(route.connectionId)?.let { ProviderSignInPage(it, nav, route.providerId) }
    }
    page<ProviderTokenRoute> { entry ->
        val route = entry.toRoute<ProviderTokenRoute>()
        accounts(route.connectionId)?.let { ProviderTokenPage(it, nav, route.providerId) }
    }
}

/** Reads [accounts] while the page shows. */
@Composable
private fun Follow(accounts: ProviderAccounts) {
    DisposableEffect(accounts) {
        val following = accounts.follow()
        onDispose { following.close() }
    }
}

/** The time now, a minute at a time, for "4m ago". */
@Composable
private fun rememberMinuteClock(): Long {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

@Composable
private fun ProviderAccountsPage(accounts: ProviderAccounts, nav: NavHostController, connectionId: String) {
    Follow(accounts)
    val state by accounts.accounts.collectAsStateWithLifecycle()
    val signIns by accounts.signIns.collectAsStateWithLifecycle()
    ProviderAccountsScreen(
        state = state,
        signIns = signIns,
        now = rememberMinuteClock(),
        onOpen = { nav.navigate(ProviderAccountRoute(connectionId, it.id)) },
        onRetry = accounts::refresh,
        onBack = { nav.popBackStack() },
    )
}

/** An account's name: its own, else its assistant's. */
internal fun ProviderAccount.shownName(): String = name ?: ModeCatalog.providerName(type)

/** Its credential as newest known: the sign-in object's, which a sign-in or a token changes before configuration is read again. */
private fun ProviderAccount.credentialNow(signIn: ProviderSignIn?): ProviderCredential = signIn?.credential ?: credential

/** Its plan: what usage read, else what the sign-in revealed. */
private fun ProviderAccount.planNow(signIn: ProviderSignIn?): String? = plan ?: signIn?.plan

/** The program that signs [cliId]'s accounts in, by its own name. */
internal fun programName(cliId: String): String = when (cliId) {
    "codex" -> "Codex"
    "claude" -> "Claude Code"
    "grok" -> "Grok"
    else -> ModeCatalog.providerName(cliId)
}

@Composable
private fun credentialLabel(source: CredentialSource): String = stringResource(
    when (source) {
        CredentialSource.Internal -> R.string.provider_accounts_internal
        CredentialSource.System -> R.string.provider_accounts_system
        CredentialSource.Configured -> R.string.provider_accounts_configured
    },
)

/** Why an account can't sign in from here, under its login; null when it can. */
@Composable
private fun blockedReason(account: ProviderAccount, signIn: ProviderSignIn?, ownerOnly: Boolean): String? = when {
    ownerOnly -> stringResource(R.string.provider_accounts_owner_only)
    signIn?.installed == false -> stringResource(R.string.provider_accounts_not_installed, programName(account.type))
    ProviderSignIns.phoneMethod(account.type, account.credentialNow(signIn)) == null -> stringResource(R.string.provider_accounts_computer_only)
    else -> null
}

/** "4m ago", or "just now" within the minute. */
@Composable
private fun ago(at: Long, now: Long): String =
    if (now - at < 60_000) stringResource(R.string.time_just_now)
    else stringResource(R.string.provider_accounts_ago, compactAgo(LocalResources.current, at, now))

/** "3h" until [at]. */
@Composable
private fun until(at: Long, now: Long): String = compactAgo(LocalResources.current, now, at)

/** "Nov 21" in the phone's language. */
private fun shortDate(at: Long): String {
    val locale = java.util.Locale.getDefault()
    return java.text.SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(locale, "MMMd"), locale).format(java.util.Date(at))
}

@Composable
private fun AccountDot.color(): Color {
    val colors = HappyTheme.colors
    return when (this) {
        AccountDot.Grey -> colors.status.disconnected
        AccountDot.Red -> colors.status.error
        AccountDot.Amber -> if (colors.dark) Color(0xFFFF9F0A) else Color(0xFFFF9500)
        AccountDot.Green -> colors.status.connected
    }
}

/** The line under an account's name, the first that applies. */
@Composable
internal fun AccountLine.text(now: Long): String {
    val dot = " · "
    return when (this) {
        AccountLine.Off -> stringResource(R.string.provider_accounts_off)
        is AccountLine.NeedsSignIn ->
            if (since == null) stringResource(R.string.provider_accounts_needs_sign_in_bare)
            else stringResource(R.string.provider_accounts_needs_sign_in, shortDate(since))
        is AccountLine.RefreshFailed ->
            if (reason == null) stringResource(R.string.provider_accounts_refresh_failed_bare, ago(at, now))
            else stringResource(R.string.provider_accounts_refresh_failed, reason, ago(at, now))
        is AccountLine.Healthy -> listOfNotNull(
            stringResource(R.string.provider_accounts_system_login).takeIf { system },
            lastUsedAt?.let { stringResource(R.string.provider_accounts_used, ago(it, now)) } ?: stringResource(R.string.provider_accounts_not_used),
            refreshedAt?.let { stringResource(R.string.provider_accounts_refreshed, ago(it, now)) },
        ).joinToString(dot)
        is AccountLine.Checked -> listOfNotNull(
            stringResource(R.string.provider_accounts_system_login).takeIf { system },
            checkedAt?.let { stringResource(R.string.provider_accounts_last_checked, ago(it, now)) },
        ).joinToString(dot)
    }
}

/** "Login expires in 3h", or that it has. */
@Composable
private fun expiryWarning(at: Long, now: Long): String =
    if (at <= now) stringResource(R.string.provider_accounts_login_expired) else stringResource(R.string.provider_accounts_login_expires, until(at, now))

/** The vendor's mark in the row's 32 icon box, the account's [dot] on its corner ringed in the card's colour. */
@Composable
private fun AccountIcon(type: String, dot: AccountDot?, tag: String) {
    val colors = HappyTheme.colors
    Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
        ProviderIcon(providerIconKind(type), size = 24.dp)
        if (dot != null) {
            Box(
                Modifier.align(Alignment.BottomEnd).testTag(tag).size(12.dp).clip(CircleShape).background(colors.surface)
                    .padding(2.dp).clip(CircleShape).background(dot.color()),
            )
        }
    }
}

/**
 * Settings › Provider accounts (happy-agent API.md, "Provider sign-in"):
 * one settings card with a row per Codex, Claude and Grok account and
 * nothing to press but the row. Each row is the vendor's mark with a 12 dot
 * on its corner, the account's name and plan, a chevron, and under the
 * name the first that applies ([AccountStatus]): Off (grey); Needs
 * sign-in, since a date where known (red); Couldn't refresh, why and when it was last
 * tried (amber); else when it was used and its login refreshed, green when
 * signed in and grey when unknown, "System login" first for the machine's
 * own. A login that runs out within a day while its refresh fails adds a
 * second line. A row opens the account's page ([ProviderAccountScreen]).
 */
@Composable
fun ProviderAccountsScreen(
    state: ProviderAccountsState,
    signIns: Map<String, ProviderSignIn>,
    now: Long,
    onOpen: (ProviderAccount) -> Unit = {},
    onRetry: () -> Unit = {},
    onBack: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    AgentPage(stringResource(R.string.provider_accounts_title), onBack) {
        when (state) {
            ProviderAccountsState.Loading -> ItemGroup(Modifier.testTag(ProviderAccountsTags.LOADING)) {
                Item(stringResource(R.string.common_loading), loading = true, showChevron = false)
            }
            ProviderAccountsState.Failed -> ItemGroup(Modifier.testTag(ProviderAccountsTags.FAILED)) {
                Item(stringResource(R.string.provider_accounts_load_failed), showChevron = false, titleLines = 0)
                Item(stringResource(R.string.cloud_providers_try_again), titleColor = colors.textLink, showChevron = false, onClick = onRetry)
            }
            is ProviderAccountsState.Loaded -> if (state.accounts.isEmpty()) {
                ItemGroup(Modifier.testTag(ProviderAccountsTags.EMPTY)) {
                    Item(stringResource(R.string.provider_accounts_empty), showChevron = false, titleLines = 0)
                }
            } else {
                ItemGroup(Modifier.testTag(ProviderAccountsTags.LIST), footer = stringResource(R.string.provider_accounts_footer)) {
                    for (account in state.accounts) {
                        val signIn = signIns[account.id]
                        val credential = account.credentialNow(signIn)
                        val status = AccountStatus.of(account, credential, now)
                        // Nothing known of an older agent's account: where its login comes from.
                        val line = status.line.text(now).ifEmpty { credentialLabel(credential.source) }
                        Item(
                            title = listOfNotNull(account.shownName(), account.planNow(signIn)).joinToString(" · "),
                            subtitle = listOfNotNull(line, status.expiresAt?.let { expiryWarning(it, now) }).joinToString("\n"),
                            subtitleLines = 3,
                            icon = { AccountIcon(account.type, status.dot, ProviderAccountsTags.dot(account.id)) },
                            onClick = { onOpen(account) },
                            modifier = Modifier.testTag(ProviderAccountsTags.account(account.id)),
                        )
                    }
                }
            }
        }
    }
}

// ---- One account ----------------------------------------------------------------------------

@Composable
private fun ProviderAccountPage(accounts: ProviderAccounts, nav: NavHostController, connectionId: String, providerId: String) {
    Follow(accounts)
    val state by accounts.accounts.collectAsStateWithLifecycle()
    val signIns by accounts.signIns.collectAsStateWithLifecycle()
    val ownerOnly by accounts.ownerOnly.collectAsStateWithLifecycle()
    val account = (state as? ProviderAccountsState.Loaded)?.accounts?.firstOrNull { it.id == providerId }
    val scope = rememberCoroutineScope()
    var toggleFailed by remember { mutableStateOf<String?>(null) }
    val ownerOnlyText = stringResource(R.string.provider_accounts_owner_only)
    if (account == null) {
        // Still reading, or the account was removed from configuration.
        ProviderAccountsScreen(state.takeIf { it !is ProviderAccountsState.Loaded } ?: ProviderAccountsState.Failed, emptyMap(), now = 0, onRetry = accounts::refresh, onBack = { nav.popBackStack() })
        return
    }
    ProviderAccountScreen(
        account = account,
        signIn = signIns[providerId],
        ownerOnly = ownerOnly,
        now = rememberMinuteClock(),
        onEnabled = { on ->
            scope.launch {
                try {
                    accounts.setEnabled(providerId, on)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Shown as it was again, and why where the agent said it was the owner's.
                    toggleFailed = if ((e as? ProviderSignInException)?.refusal == ProviderSignInRefusal.Forbidden) ownerOnlyText else ""
                }
            }
        },
        onSignIn = { nav.navigate(ProviderSignInRoute(connectionId, providerId)) },
        onToken = { nav.navigate(ProviderTokenRoute(connectionId, providerId)) },
        onBack = { nav.popBackStack() },
    )
    toggleFailed?.let { said ->
        val alert = Alert(stringResource(R.string.provider_accounts_toggle_failed), said.ifEmpty { null }, listOf(AlertButton(stringResource(R.string.common_ok))))
        HappyAlert(alert, onDismiss = { toggleFailed = null })
    }
}

/**
 * One provider account: its name and plan with its vendor, and Enabled
 * (`PATCH /v0/config`); then Login: its Source (with the email and plan of
 * Happy's own), its last refresh, when its token expires and the last
 * refresh error with its code and since when (an older agent says only
 * when usage last checked); then Sign in again ("In progress" while one
 * runs) and, for Claude, Update token, under them why they can't be done
 * here and what signing in does. Rows are [Item]s in [ItemGroup]s, as
 * every settings page; the words are iOS's.
 */
@Composable
fun ProviderAccountScreen(
    account: ProviderAccount,
    signIn: ProviderSignIn?,
    ownerOnly: Boolean,
    now: Long,
    onEnabled: (Boolean) -> Unit = {},
    onSignIn: () -> Unit = {},
    onToken: () -> Unit = {},
    onBack: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    val credential = account.credentialNow(signIn)
    val blocked = blockedReason(account, signIn, ownerOnly)
    val running = signIn?.operation?.finished == false
    val enabledTitle = stringResource(R.string.provider_accounts_enabled)
    AgentPage(account.shownName(), onBack) {
        ItemGroup {
            Item(
                title = account.shownName(),
                subtitle = account.planNow(signIn),
                detail = ModeCatalog.providerName(account.type),
                icon = { AccountIcon(account.type, null, "") },
                showChevron = false,
            )
            Item(
                title = enabledTitle,
                showChevron = false,
                rightElement = {
                    HappySwitch(account.enabled, onEnabled, Modifier.testTag(ProviderAccountsTags.ENABLED), enabled = !ownerOnly, label = enabledTitle)
                },
            )
        }
        ItemGroup(title = stringResource(R.string.provider_accounts_login)) {
            Item(
                title = stringResource(R.string.provider_accounts_source),
                subtitle = signIn?.takeIf { credential.source == CredentialSource.Internal }
                    ?.let { listOfNotNull(it.email, it.plan).joinToString(" · ").ifEmpty { null } },
                detail = credentialLabel(credential.source),
                showChevron = false,
                modifier = Modifier.testTag(ProviderAccountsTags.source(account.id)),
            )
            val login = account.login
            if (account.loginReported) {
                Item(
                    stringResource(R.string.provider_accounts_last_refresh),
                    detail = login?.refreshedAt?.let { ago(it, now) } ?: stringResource(R.string.provider_accounts_never),
                    showChevron = false,
                    modifier = Modifier.testTag(ProviderAccountsTags.LAST_REFRESH),
                )
                login?.expiresAt?.let {
                    Item(
                        stringResource(R.string.provider_accounts_token_expires),
                        detail = if (it <= now) stringResource(R.string.provider_accounts_token_expired) else stringResource(R.string.provider_accounts_in, until(it, now)),
                        showChevron = false,
                        modifier = Modifier.testTag(ProviderAccountsTags.EXPIRES),
                    )
                }
                login?.refreshError?.let { error ->
                    Item(
                        stringResource(R.string.provider_accounts_refresh_error),
                        subtitle = listOfNotNull(error.reason, stringResource(R.string.provider_accounts_since, shortDate(error.since))).joinToString(" · "),
                        titleColor = if (error.permanent) colors.textDestructive else Color.Unspecified,
                        showChevron = false,
                        modifier = Modifier.testTag(ProviderAccountsTags.REFRESH_ERROR),
                    )
                }
            } else {
                account.checkedAt?.let {
                    Item(stringResource(R.string.provider_accounts_last_checked_title), detail = ago(it, now), showChevron = false, modifier = Modifier.testTag(ProviderAccountsTags.LAST_CHECKED))
                }
            }
        }
        ItemGroup(footer = listOfNotNull(blocked, stringResource(R.string.provider_accounts_footer)).joinToString("\n")) {
            Item(
                title = stringResource(R.string.provider_accounts_sign_in_again),
                titleColor = colors.textLink,
                detail = if (running) stringResource(R.string.provider_accounts_in_progress) else null,
                showChevron = false,
                enabled = blocked == null,
                onClick = onSignIn,
                modifier = Modifier.testTag(ProviderAccountsTags.signIn(account.id)),
            )
            if (credential.acceptsToken) {
                Item(
                    title = stringResource(R.string.provider_accounts_update_token),
                    titleColor = colors.textLink,
                    showChevron = false,
                    enabled = !ownerOnly,
                    onClick = onToken,
                    modifier = Modifier.testTag(ProviderAccountsTags.token(account.id)),
                )
            }
        }
    }
}

// ---- Signing in again -----------------------------------------------------------------------

/** The sign-in this page shows, kept by its back stack entry; popping the page cancels it where unfinished. */
private class SignInHolder(accounts: ProviderAccounts, providerId: String) : ViewModel() {
    val run = ProviderSignInRun(accounts, providerId, viewModelScope)
    private var started = false

    /** Starts once, with the phone's method for the account. */
    fun startOnce(method: String?) {
        if (started) return
        started = true
        run.start(method)
    }

    override fun onCleared() {
        run.close()
    }
}

@Composable
private fun ProviderSignInPage(accounts: ProviderAccounts, nav: NavHostController, providerId: String) {
    val loaded = accounts.accounts.collectAsStateWithLifecycle().value as? ProviderAccountsState.Loaded
    val account = loaded?.accounts?.firstOrNull { it.id == providerId }
    val signIn = accounts.signIns.collectAsStateWithLifecycle().value[providerId]
    val cliId = account?.type ?: signIn?.cliId.orEmpty()
    val credential = signIn?.credential ?: account?.credential
    Follow(accounts)
    val holder = viewModel { SignInHolder(accounts, providerId) }
    // Never before the account's methods are known: left to itself the agent picks its first, a browser on the computer.
    LaunchedEffect(credential != null) { credential?.let { holder.startOnce(ProviderSignIns.phoneMethod(cliId, it)) } }
    val step by holder.run.step.collectAsStateWithLifecycle()
    // Back from the browser: the events it missed while away.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { holder.viewModelScope.launch { accounts.reread(providerId) } }
    LaunchedEffect(step) { if (step == SignInStep.Cancelled) nav.popBackStack() }
    val context = LocalContext.current
    val dark = HappyTheme.colors.dark
    ProviderSignInScreen(
        name = account?.shownName() ?: ModeCatalog.providerName(cliId),
        program = programName(cliId),
        step = step,
        onOpen = { openSignInPage(context, it, dark) },
        onCode = holder.run::sendCode,
        onCancel = holder.run::cancel,
        onRetry = holder.run::restart,
        onClose = { nav.popBackStack() },
    )
}

/**
 * Signing one account in again, on a stack page titled "Sign in again" with
 * the account's name heading its card. A device code is the 30 sp monospace
 * code with Copy (inverted, "Copied" for 2 s) and Open sign-in page, as
 * Happy Cloud's ChatGPT sign-in draws it; Claude's page is opened and its
 * code pasted back (Continue, "Checking…" once sent). A browser sign-in
 * started elsewhere for Codex or Grok only waits, since it finishes on the
 * computer. Under an unfinished one, Cancel in its own card. It ends in
 * Signed in (the email and plan) with Done, or a failure: its title, the
 * agent's own words (else "The account keeps the login it had."), Try
 * again and Close.
 */
@Composable
fun ProviderSignInScreen(
    name: String,
    program: String,
    step: SignInStep,
    onOpen: (String) -> Unit = {},
    onCode: (String) -> Unit = {},
    onCancel: () -> Unit = {},
    onRetry: () -> Unit = {},
    onClose: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.provider_accounts_sign_in_again), onClose) }, avoidKeyboard = true) {
        ItemList {
            when (step) {
                SignInStep.Starting, SignInStep.Cancelled -> ItemGroup(Modifier.testTag(ProviderAccountsTags.STARTING), title = name) {
                    Item(stringResource(R.string.provider_sign_in_starting), loading = true, showChevron = false)
                }
                is SignInStep.Device -> ItemGroup(title = name) {
                    FlowColumn {
                        Secondary(stringResource(R.string.provider_sign_in_enter_code))
                        step.userCode?.let { code ->
                            Text(
                                code,
                                style = happyTextStyle(fontSize = 30, lineHeight = 36, weight = FontWeight.SemiBold).copy(fontFamily = FontFamily.Monospace),
                                color = colors.text,
                                modifier = Modifier.testTag(ProviderAccountsTags.CODE),
                            )
                            CopyButton(code)
                        }
                        RoundButton(title = stringResource(R.string.provider_sign_in_open), onClick = { onOpen(step.url) }, modifier = Modifier.testTag(ProviderAccountsTags.OPEN))
                        Secondary(stringResource(R.string.cloud_providers_waiting))
                    }
                }
                is SignInStep.PasteCode -> ItemGroup(title = name) {
                    // Held only while the page is up; never saved with its state.
                    var code by remember { mutableStateOf("") }
                    FlowColumn {
                        Secondary(stringResource(R.string.provider_sign_in_paste_intro))
                        RoundButton(
                            title = stringResource(R.string.provider_sign_in_open),
                            display = RoundButtonDisplay.Inverted,
                            onClick = { onOpen(step.url) },
                            modifier = Modifier.testTag(ProviderAccountsTags.OPEN),
                        )
                        CodeField(code, { code = it }, stringResource(R.string.provider_sign_in_paste_code), enabled = !step.checking, hidden = false, onDone = { onCode(code) })
                        RoundButton(
                            title = stringResource(R.string.common_continue),
                            onClick = { onCode(code) },
                            enabled = code.isNotBlank(),
                            loading = step.checking,
                            loadingTitle = stringResource(R.string.provider_sign_in_checking),
                            modifier = Modifier.fillMaxWidth().testTag(ProviderAccountsTags.SUBMIT),
                        )
                    }
                }
                is SignInStep.OnComputer -> ItemGroup(title = name, footer = stringResource(R.string.provider_sign_in_on_computer)) {
                    Item(stringResource(R.string.cloud_providers_waiting), loading = true, showChevron = false)
                }
                is SignInStep.Done -> ItemGroup(
                    modifier = Modifier.testTag(ProviderAccountsTags.DONE),
                    title = name,
                    footer = listOfNotNull(step.email, step.plan).joinToString(" · ").ifEmpty { null },
                ) {
                    Item(stringResource(R.string.provider_sign_in_done), showChevron = false)
                    Item(stringResource(R.string.provider_sign_in_done_action), titleColor = colors.textLink, showChevron = false, onClick = onClose)
                }
                is SignInStep.Failed -> ItemGroup(
                    modifier = Modifier.testTag(ProviderAccountsTags.FAILURE),
                    title = name,
                    footer = when (step.failure) {
                        SignInFailure.OwnerOnly -> stringResource(R.string.provider_accounts_owner_only)
                        SignInFailure.NotInstalled -> stringResource(R.string.provider_accounts_not_installed, program)
                        else -> step.said ?: stringResource(R.string.provider_sign_in_kept)
                    },
                ) {
                    Item(
                        stringResource(
                            when (step.failure) {
                                SignInFailure.Expired -> R.string.provider_sign_in_expired
                                SignInFailure.SaveFailed -> R.string.provider_sign_in_save_failed
                                else -> R.string.cloud_providers_failed
                            },
                        ),
                        titleColor = colors.textDestructive,
                        showChevron = false,
                    )
                    if (step.failure != SignInFailure.OwnerOnly && step.failure != SignInFailure.NotInstalled) {
                        Item(
                            stringResource(R.string.cloud_providers_try_again),
                            titleColor = colors.textLink,
                            showChevron = false,
                            onClick = onRetry,
                            modifier = Modifier.testTag(ProviderAccountsTags.RETRY),
                        )
                    }
                    Item(stringResource(R.string.provider_sign_in_close), titleColor = colors.textLink, showChevron = false, onClick = onClose)
                }
            }
            if (step.unfinished) {
                ItemGroup {
                    Item(
                        stringResource(R.string.common_cancel),
                        titleColor = colors.textDestructive,
                        showChevron = false,
                        onClick = onCancel,
                        modifier = Modifier.testTag(ProviderAccountsTags.CANCEL),
                    )
                }
            }
        }
    }
}

@Composable
private fun CopyButton(code: String) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (!copied) return@LaunchedEffect
        delay(2_000)
        copied = false
    }
    RoundButton(
        title = stringResource(if (copied) R.string.common_copied else R.string.common_copy),
        display = RoundButtonDisplay.Inverted,
        onClick = {
            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(code, code))) }
            copied = true
        },
        modifier = Modifier.testTag(ProviderAccountsTags.COPY),
    )
}

@Composable
private fun FlowColumn(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) { content() }
}

@Composable
private fun Secondary(text: String) {
    Text(text, style = happyTextStyle(fontSize = 15, lineHeight = 21), color = HappyTheme.colors.textSecondary, textAlign = TextAlign.Center)
}

@Composable
private fun CodeField(value: String, onChange: (String) -> Unit, placeholder: String, enabled: Boolean, hidden: Boolean, onDone: () -> Unit) {
    HappyTextField(
        value = value,
        onValueChange = onChange,
        placeholder = placeholder,
        textStyle = happyTextStyle(fontSize = 15, lineHeight = 20),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
        minHeight = 44.dp,
        cornerRadius = 8.dp,
        singleLine = true,
        enabled = enabled,
        visualTransformation = if (hidden) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (hidden) KeyboardType.Password else KeyboardType.Ascii, imeAction = ImeAction.Done, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = Modifier.fillMaxWidth().testTag(ProviderAccountsTags.FIELD),
    )
}

// ---- Claude's setup token -------------------------------------------------------------------

@Composable
private fun ProviderTokenPage(accounts: ProviderAccounts, nav: NavHostController, providerId: String) {
    Follow(accounts)
    val loaded = accounts.accounts.collectAsStateWithLifecycle().value as? ProviderAccountsState.Loaded
    val account = loaded?.accounts?.firstOrNull { it.id == providerId }
    val scope = rememberCoroutineScope()
    var phase by remember { mutableStateOf<TokenPhase>(TokenPhase.Editing) }
    ProviderTokenScreen(
        name = account?.shownName() ?: ModeCatalog.providerName("claude"),
        phase = phase,
        onSave = { token ->
            phase = TokenPhase.Saving
            scope.launch {
                phase = try {
                    accounts.saveToken(providerId, token)
                    TokenPhase.Done
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ProviderSignInException) {
                    TokenPhase.Failed(e.said, ownerOnly = e.refusal == ProviderSignInRefusal.Forbidden)
                } catch (_: Exception) {
                    TokenPhase.Failed(null)
                }
            }
        },
        onRetry = { phase = TokenPhase.Editing },
        onClose = { nav.popBackStack() },
    )
}

/** Where saving a setup token stands. */
sealed interface TokenPhase {
    data object Editing : TokenPhase
    data object Saving : TokenPhase
    data object Done : TokenPhase
    /** [said]: the agent's own words; [ownerOnly]: refused as the team owner's alone. */
    data class Failed(val said: String?, val ownerOnly: Boolean = false) : TokenPhase
}

/**
 * Update token: a Claude account's setup token pasted into a hidden field
 * and saved once, as Happy Cloud's setup-token page takes it; the agent
 * strips whitespace and checks its shape. It ends in Token updated with
 * Done, or Couldn't update the token with the agent's words and Try again.
 */
@Composable
fun ProviderTokenScreen(
    name: String,
    phase: TokenPhase,
    onSave: (String) -> Unit = {},
    onRetry: () -> Unit = {},
    onClose: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    // Held only while the page is up; never saved with its state.
    var token by remember { mutableStateOf("") }
    Screen(header = { StackHeader(stringResource(R.string.provider_accounts_update_token), onClose) }, avoidKeyboard = true) {
        ItemList {
            when (phase) {
                TokenPhase.Done -> ItemGroup(Modifier.testTag(ProviderAccountsTags.DONE), title = name) {
                    Item(stringResource(R.string.provider_token_updated), showChevron = false)
                    Item(stringResource(R.string.provider_sign_in_done_action), titleColor = colors.textLink, showChevron = false, onClick = onClose)
                }
                is TokenPhase.Failed -> ItemGroup(
                    modifier = Modifier.testTag(ProviderAccountsTags.FAILURE),
                    title = name,
                    footer = if (phase.ownerOnly) stringResource(R.string.provider_accounts_owner_only) else phase.said ?: stringResource(R.string.cloud_failed),
                ) {
                    Item(stringResource(R.string.provider_token_failed), titleColor = colors.textDestructive, showChevron = false)
                    if (!phase.ownerOnly) {
                        Item(stringResource(R.string.cloud_providers_try_again), titleColor = colors.textLink, showChevron = false, onClick = onRetry, modifier = Modifier.testTag(ProviderAccountsTags.RETRY))
                    }
                }
                else -> ItemGroup(title = name, footer = stringResource(R.string.provider_token_hint)) {
                    val saving = phase == TokenPhase.Saving
                    FlowColumn {
                        CodeField(token, { token = it }, stringResource(R.string.cloud_providers_setup_token), enabled = !saving, hidden = true, onDone = { if (token.isNotBlank()) onSave(token) })
                        RoundButton(
                            title = stringResource(R.string.common_save),
                            onClick = { onSave(token) },
                            enabled = token.isNotBlank(),
                            loading = saving,
                            modifier = Modifier.fillMaxWidth().testTag(ProviderAccountsTags.SUBMIT),
                        )
                    }
                }
            }
        }
    }
}
