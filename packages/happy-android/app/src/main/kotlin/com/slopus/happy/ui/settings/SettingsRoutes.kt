package com.slopus.happy.ui.settings

import android.content.ActivityNotFoundException
import android.os.Build
import android.provider.Settings
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalResources
import com.slopus.happy.model.settings.PushText
import com.slopus.happy.model.settings.PushTokensApi
import com.slopus.happy.push.rememberPushRegistration
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.auth.AuthState
import com.slopus.happy.model.Machine
import com.slopus.happy.model.MachineChoice
import com.slopus.happy.model.Profile
import com.slopus.happy.payments.Paywall
import com.slopus.happy.model.collectMachineChoices
import kotlinx.coroutines.flow.MutableStateFlow
import com.slopus.happy.model.settings.ConnectApi
import com.slopus.happy.model.settings.HttpConnectApi
import com.slopus.happy.model.settings.Languages
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.changelog.Changelog
import com.slopus.happy.ui.changelog.ChangelogScreen
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.connect.EnterTerminalUrlPrompt
import com.slopus.happy.ui.connect.rememberAccountLink
import com.slopus.happy.ui.connect.rememberTerminalConnect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import com.slopus.happy.ui.voice.voiceRoutes
import com.slopus.happy.ui.voice.VoiceSettingsRoute

@Serializable data object AccountRoute
@Serializable data object AppearanceRoute
@Serializable data object LanguageRoute
@Serializable data object AgentsRoute
@Serializable data object ConnectClaudeRoute
@Serializable data object ChangelogRoute

/** Settings and its screens. [SettingsRoute] is the entry point. */
fun NavGraphBuilder.settingsRoutes(graph: AppGraph, nav: NavHostController) {
    voiceRoutes(graph, nav)
    composable<SettingsRoute> { SettingsIndex(graph, nav) }
    composable<AccountRoute> { Account(graph, nav) }
    composable<AppearanceRoute> { Appearance(graph, nav) }
    composable<AgentsRoute> { Agents(graph, nav) }
    composable<ConnectClaudeRoute> { ConnectClaudeScreen(onBack = { nav.popBackStack() }) }
    composable<ChangelogRoute> {
        val resources = LocalResources.current
        val changelog = remember(resources) { Changelog.bundled(resources) }
        ChangelogScreen(changelog, onViewed = graph.changelog::markViewed, onBack = { nav.popBackStack() })
    }
    composable<LanguageRoute> {
        val settings by graph.settings.settings.collectAsStateWithLifecycle()
        LanguageScreen(
            preferredLanguage = settings.preferredLanguage,
            detectedLanguageName = Languages.detectedName(graph.language.deviceLocales()),
            onSelect = { code ->
                graph.settings.change { it.copy(preferredLanguage = code) }
                graph.language.apply(code)
            },
            onBack = { nav.popBackStack() },
        )
    }
}

@Composable
private fun Appearance(graph: AppGraph, nav: NavHostController) {
    val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val automatic = stringResource(R.string.settings_language_automatic)
    val preferred = settings.preferredLanguage
    val languageDetail = when {
        preferred == null -> "$automatic (${Languages.detectedName(graph.language.deviceLocales())})"
        Languages.byCode(preferred) != null -> Languages.byCode(preferred)!!.nativeName
        else -> automatic
    }
    AppearanceScreen(
        theme = theme,
        onThemeChange = graph.localSettings::setThemePreference,
        onBack = { nav.popBackStack() },
        settings = settings,
        onSettingsChange = graph.settings::change,
        languageDetail = languageDetail,
        onLanguage = { nav.navigate(LanguageRoute) },
    )
}

@Composable
private fun Agents(graph: AppGraph, nav: NavHostController) {
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val machines by rememberMachineChoices(graph)
    AgentsScreen(
        machines = machines,
        overrides = settings.agentDefaultOverrides,
        onOverridesChange = { overrides -> graph.settings.change { it.copy(agentDefaultOverrides = overrides) } },
        onMachine = { nav.navigate(MachineRoute(it.id)) },
        onBack = { nav.popBackStack() },
    )
}

/**
 * The account's computers in Settings › Agents order, re-read whenever the
 * store changes, with live presence over the stored online state.
 */
@Composable
private fun rememberMachineChoices(graph: AppGraph): State<List<MachineChoice>> {
    val changes by graph.store.changes.collectAsStateWithLifecycle()
    val account by graph.account.collectAsStateWithLifecycle()
    val presenceFlow = remember(account) { account?.presence?.machines ?: MutableStateFlow(emptyMap()) }
    val presence by presenceFlow.collectAsStateWithLifecycle()
    return produceState(emptyList(), changes, presence) {
        val machines = withContext(Dispatchers.IO) { graph.store.machines().map(Machine::from) }
        value = sortAgentMachines(
            collectMachineChoices(
                machines.map { machine -> presence[machine.id]?.let { machine.copy(active = it.active, activeAt = it.activeAt) } ?: machine },
            ),
        )
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

/** The Version row's detail: "versionName (versionCode)", see [SettingsScreen]. */
fun versionDetail(versionName: String, versionCode: Int) = "$versionName ($versionCode)"

/** openExternalUrl: a link nothing on the device can open is dropped, not a crash. */
internal fun openExternalUrl(uriHandler: UriHandler, url: String) {
    try {
        uriHandler.openUri(url)
    } catch (_: IllegalArgumentException) {
        // AndroidUriHandler's "Can't open $uri" when no activity takes the link.
    } catch (_: ActivityNotFoundException) {
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

/** Support us reports unavailable billing through the same localized alert as other settings actions. */
@Composable
internal fun rememberSupportAction(paywall: Paywall, onError: (String?) -> Unit): HappyAction {
    val unavailable = stringResource(R.string.settings_support_unavailable)
    return rememberHappyAction(onError) {
        val result = paywall.present("voluntary_support")
        if (!result.success) onError(unavailable)
    }
}

@Composable
private fun SettingsIndex(graph: AppGraph, nav: NavHostController) {
    val uriHandler = LocalUriHandler.current
    val profile by rememberProfile(graph)
    val api = rememberConnectApi(graph)
    val alerts = remember { Alerts() }
    val onError = errorAlert(alerts)
    val purchases by graph.purchases.purchases.collectAsStateWithLifecycle()
    val support = rememberSupportAction(graph.purchases, onError)

    val cancel = stringResource(R.string.common_cancel)
    val disconnect = stringResource(R.string.modals_disconnect)
    val disconnectClaudeTitle = stringResource(R.string.modals_disconnect_service, "Claude")
    val disconnectClaudeMessage = stringResource(R.string.modals_disconnect_service_confirm, "Claude")
    val disconnectGitHubTitle = stringResource(R.string.modals_disconnect_github)
    val disconnectGitHubMessage = stringResource(R.string.modals_disconnect_github_confirm)

    val connectGitHub = rememberHappyAction(onError) { openExternalUrl(uriHandler, api.gitHubOAuthUrl()) }
    val disconnectGitHub = rememberHappyAction(onError) {
        api.disconnectGitHub()
        graph.requestSync()
    }
    val disconnectClaude = rememberHappyAction(onError) {
        api.disconnectService("anthropic")
        graph.requestSync()
    }

    // Modal.confirm on Android: only a button closes it.
    fun confirm(title: String, message: String, action: HappyAction) = alerts.show(
        Alert(title, message, listOf(AlertButton(cancel), AlertButton(disconnect, destructive = true, onClick = action::run)), cancelable = false),
    )
    val connect = rememberTerminalConnect(graph)
    var enteringUrl by remember { mutableStateOf(false) }

    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val versionClicks = remember { MultiClick(required = 10) }
    val developerMode = stringResource(R.string.modals_developer_mode)
    val developerModeEnabled = stringResource(R.string.modals_developer_mode_enabled)
    val developerModeDisabled = stringResource(R.string.modals_developer_mode_disabled)
    val ok = stringResource(R.string.common_ok)

    SettingsScreen(
        versionName = versionDetail(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
        versionSubtitle = buildSubtitle(BuildConfig.BUILD_COMMIT_SHA, BuildConfig.BUILD_COMMIT_TIMESTAMP),
        profile = profile,
        onBack = { nav.popBackStack() },
        connectingTerminal = connect.isLoading,
        onScanQr = connect::scan,
        onEnterUrl = { enteringUrl = true },
        accounts = ConnectedAccounts(
            claudeConnected = "anthropic" in profile.connectedServices,
            claudeBusy = disconnectClaude.loading,
            gitHubLogin = profile.github?.login,
            gitHubBusy = connectGitHub.loading || disconnectGitHub.loading,
        ),
        onClaude = {
            if ("anthropic" in profile.connectedServices) confirm(disconnectClaudeTitle, disconnectClaudeMessage, disconnectClaude) else nav.navigate(ConnectClaudeRoute)
        },
        onGitHub = {
            if (profile.github != null) confirm(disconnectGitHubTitle, disconnectGitHubMessage, disconnectGitHub) else connectGitHub.run()
        },
        onAccount = { nav.navigate(AccountRoute) },
        onAppearance = { nav.navigate(AppearanceRoute) },
        onAgents = { nav.navigate(AgentsRoute) },
        onVoice = { nav.navigate(VoiceSettingsRoute) },
        onWhatsNew = { nav.navigate(ChangelogRoute) },
        isPro = BuildConfig.DEBUG || purchases.entitlements["pro"] == true,
        onSupport = support::run,
        onOpenUrl = { url -> openExternalUrl(uriHandler, url) },
        onVersion = {
            if (versionClicks.click()) {
                val enabled = !local.devModeEnabled
                graph.localSettings.change { it.copy(devModeEnabled = enabled) }
                alerts.show(Alert(developerMode, if (enabled) developerModeEnabled else developerModeDisabled, listOf(AlertButton(ok))))
            }
        },
    )
    if (enteringUrl) EnterTerminalUrlPrompt(connect, onDismiss = { enteringUrl = false })
    alerts.Host()
}

@Composable
private fun Account(graph: AppGraph, nav: NavHostController) {
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val account = auth as? AuthState.SignedIn ?: return
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val profile by rememberProfile(graph)
    val api = rememberConnectApi(graph)
    val tokensApi = remember(graph) { PushTokensApi(graph.http) { (graph.auth.state.value as? AuthState.SignedIn)?.credentials?.token } }
    val pushRegistration = rememberPushRegistration(graph)
    val scope = rememberCoroutineScope()
    val alerts = remember { Alerts() }
    val onError = errorAlert(alerts)
    val errorTitle = stringResource(R.string.common_error)
    val successTitle = stringResource(R.string.common_success)
    val ok = stringResource(R.string.common_ok)
    val resources = LocalResources.current
    fun showError(message: String) = alerts.show(Alert(errorTitle, message, listOf(AlertButton(ok))))
    fun showSuccess(message: String) = alerts.show(Alert(successTitle, message, listOf(AlertButton(ok))))

    val context = LocalContext.current
    val (deviceLabel, appLabel) = remember {
        PushText.deviceLabels(
            // expo-device's deviceName: the user-set name, else the model.
            deviceName = Settings.Global.getString(context.contentResolver, "device_name") ?: Build.MODEL,
            modelName = Build.MODEL,
            osVersion = Build.VERSION.RELEASE,
            appVersion = BuildConfig.VERSION_NAME,
            buildVersion = BuildConfig.VERSION_CODE.toString(),
            emulator = Build.FINGERPRINT.contains("generic") || Build.HARDWARE.contains("ranchu"),
        )
    }
    var push by remember { mutableStateOf(PushState(deviceLabel = deviceLabel, appLabel = appLabel)) }
    var disconnectingService by remember { mutableStateOf<String?>(null) }
    val link = rememberAccountLink(graph)

    suspend fun loadPush(showErrors: Boolean = false) {
        push = push.copy(loading = true)
        try {
            val tokens = tokensApi.list()
            push = push.copy(tokens = tokens, permission = pushRegistration.permission(), currentToken = pushRegistration.currentToken())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (showErrors) showError("Failed to load push notification settings.")
        } finally {
            push = push.copy(loading = false)
        }
    }
    // Loaded on every visit (useFocusEffect).
    LaunchedEffect(Unit) { loadPush() }

    val disconnectGitHub = rememberHappyAction(onError) {
        api.disconnectGitHub()
        graph.requestSync()
    }

    AccountScreen(
        anonId = account.encryption.anonId,
        publicId = account.publicId,
        formattedSecretKey = account.formattedSecretKey,
        analyticsOptOut = settings.analyticsOptOut,
        onAnalyticsOptOutChange = { optOut -> graph.settings.change { it.copy(analyticsOptOut = optOut) } },
        onLogout = { graph.logout() },
        onBack = { nav.popBackStack() },
        profile = profile,
        gitHubBusy = disconnectGitHub.loading,
        onDisconnectGitHub = disconnectGitHub::run,
        disconnectingService = disconnectingService,
        onDisconnectService = { service, name ->
            scope.launch {
                disconnectingService = service
                try {
                    api.disconnectService(service)
                    graph.requestSync()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    showError(resources.getString(R.string.errors_disconnect_service_failed, name))
                } finally {
                    disconnectingService = null
                }
            }
        },
        push = push,
        onRequestPush = {
            scope.launch {
                push = push.copy(requesting = true)
                try {
                    val result = pushRegistration.requestPermissionOrOpenSettings()
                    push = push.copy(permission = result.permission)
                    if (result.granted) {
                        pushRegistration.syncCurrentToken()
                        loadPush()
                        showSuccess("Push notifications are enabled for this device.")
                    } else {
                        loadPush()
                        if (result.openedSettings) {
                            alerts.show(Alert("Open Settings", "The system will not show the permission prompt again, so Happy opened Settings instead.", listOf(AlertButton(ok))))
                        } else {
                            showError("Push notification permission was not granted.")
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    showError("Failed to request push notification permission.")
                } finally {
                    push = push.copy(requesting = false)
                }
            }
        },
        onRefreshPush = {
            scope.launch {
                push = push.copy(refreshing = true)
                try {
                    val result = pushRegistration.syncCurrentToken()
                    push = push.copy(permission = result.permission)
                    loadPush()
                    if (result.permission.granted) showSuccess("This device push token was refreshed.")
                    else showError("Push notifications are not enabled for this device yet.")
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    showError("Failed to refresh this device push token.")
                } finally {
                    push = push.copy(refreshing = false)
                }
            }
        },
        onDeletePushToken = { token ->
            scope.launch {
                push = push.copy(deletingToken = token.token)
                try {
                    pushRegistration.removeToken(token.token)
                    loadPush()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    showError("Failed to delete push token.")
                } finally {
                    push = push.copy(deletingToken = null)
                }
            }
        },
        linkingDevice = link.isLoading,
        onLinkNewDevice = link::scan,
    )
    alerts.Host()
}
