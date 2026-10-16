package com.slopus.happy.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.auth.AuthState
import com.slopus.happy.model.Profile
import com.slopus.happy.model.settings.ConnectApi
import com.slopus.happy.model.settings.HttpConnectApi
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

@Serializable data object AccountRoute
@Serializable data object AppearanceRoute

/** Settings and its screens. [SettingsRoute] is the entry point. */
fun NavGraphBuilder.settingsRoutes(graph: AppGraph, nav: NavHostController) {
    composable<SettingsRoute> { SettingsIndex(graph, nav) }
    composable<AccountRoute> { Account(graph, nav) }
    composable<AppearanceRoute> {
        val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
        AppearanceScreen(theme = theme, onThemeChange = graph.localSettings::setThemePreference, onBack = { nav.popBackStack() })
    }
}

/** The stored profile, re-read whenever the store changes. */
@Composable
internal fun rememberProfile(graph: AppGraph): State<Profile> {
    val changes by graph.store.changes.collectAsStateWithLifecycle()
    return produceState(Profile.Defaults, changes) {
        value = withContext(Dispatchers.IO) { Profile.parse(graph.store.profile()) }
    }
}

@Composable
internal fun rememberConnectApi(graph: AppGraph): ConnectApi =
    remember(graph) { HttpConnectApi(graph.http) { (graph.auth.state.value as? AuthState.SignedIn)?.credentials?.token } }

/** Alerts a screen shows: [show] one, and put [Host] in the composition. */
internal class Alerts {
    var current by mutableStateOf<Alert?>(null)

    fun show(alert: Alert) {
        current = alert
    }

    @Composable
    fun Host() {
        current?.let { HappyAlert(it, onDismiss = { current = null }) }
    }
}

/** Shows useHappyAction's error alert: "Error", the message or "Unknown error", OK. */
@Composable
internal fun errorAlert(alerts: Alerts): (String?) -> Unit {
    val title = stringResource(R.string.common_error)
    val unknown = stringResource(R.string.happy_action_unknown_error)
    val ok = stringResource(R.string.common_ok)
    return { message -> alerts.show(Alert(title, message ?: unknown, listOf(AlertButton(ok)))) }
}

@Composable
private fun SettingsIndex(graph: AppGraph, nav: NavHostController) {
    val uriHandler = LocalUriHandler.current
    val profile by rememberProfile(graph)
    val api = rememberConnectApi(graph)
    val alerts = remember { Alerts() }
    val onError = errorAlert(alerts)

    val cancel = stringResource(R.string.common_cancel)
    val ok = stringResource(R.string.common_ok)
    val disconnect = stringResource(R.string.modals_disconnect)
    val disconnectClaudeTitle = stringResource(R.string.modals_disconnect_service, "Claude")
    val disconnectClaudeMessage = stringResource(R.string.modals_disconnect_service_confirm, "Claude")
    val disconnectGitHubTitle = stringResource(R.string.modals_disconnect_github)
    val disconnectGitHubMessage = stringResource(R.string.modals_disconnect_github_confirm)
    val terminalUnavailable = stringResource(R.string.settings_connect_terminal_unavailable)

    val connectGitHub = rememberHappyAction(onError) { uriHandler.openUri(api.gitHubOAuthUrl()) }
    val disconnectGitHub = rememberHappyAction(onError) {
        api.disconnectGitHub()
        graph.requestSync()
    }
    val disconnectClaude = rememberHappyAction(onError) {
        api.disconnectService("anthropic")
        graph.requestSync()
    }

    fun confirm(title: String, message: String, action: HappyAction) = alerts.show(
        Alert(title, message, listOf(AlertButton(cancel), AlertButton(disconnect, destructive = true, onClick = action::run))),
    )
    // STUB: terminal connect (QR scanner, URL prompt) belongs to the connect flow.
    val terminalStub = { alerts.show(Alert(terminalUnavailable, null, listOf(AlertButton(ok)))) }

    SettingsScreen(
        versionName = BuildConfig.VERSION_NAME,
        versionSubtitle = buildSubtitle(BuildConfig.BUILD_COMMIT_SHA, BuildConfig.BUILD_COMMIT_TIMESTAMP),
        profile = profile,
        onBack = { nav.popBackStack() },
        onScanQr = terminalStub,
        onEnterUrl = terminalStub,
        accounts = ConnectedAccounts(
            claudeConnected = "anthropic" in profile.connectedServices,
            claudeBusy = disconnectClaude.loading,
            gitHubLogin = profile.github?.login,
            gitHubBusy = connectGitHub.loading || disconnectGitHub.loading,
        ),
        onClaude = {
            if ("anthropic" in profile.connectedServices) confirm(disconnectClaudeTitle, disconnectClaudeMessage, disconnectClaude) else terminalStub()
        },
        onGitHub = {
            if (profile.github != null) confirm(disconnectGitHubTitle, disconnectGitHubMessage, disconnectGitHub) else connectGitHub.run()
        },
        onAccount = { nav.navigate(AccountRoute) },
        onAppearance = { nav.navigate(AppearanceRoute) },
        onAgents = terminalStub,
        onWhatsNew = terminalStub,
        onOpenUrl = uriHandler::openUri,
    )
    alerts.Host()
}

@Composable
private fun Account(graph: AppGraph, nav: NavHostController) {
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val account = auth as? AuthState.SignedIn ?: return
    val settings by graph.settings.settings.collectAsStateWithLifecycle()

    AccountScreen(
        anonId = account.encryption.anonId,
        publicId = account.publicId,
        formattedSecretKey = account.formattedSecretKey,
        analyticsOptOut = settings.analyticsOptOut,
        onAnalyticsOptOutChange = { optOut -> graph.settings.change { it.copy(analyticsOptOut = optOut) } },
        onLogout = { graph.logout() },
        onBack = { nav.popBackStack() },
    )
}
