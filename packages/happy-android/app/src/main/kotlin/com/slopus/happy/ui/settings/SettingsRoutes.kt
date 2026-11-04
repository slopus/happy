package com.slopus.happy.ui.settings

import com.slopus.happy.ui.page
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
import androidx.navigation.toRoute
import com.slopus.happy.ui.components.ProvideRowReveal
import com.slopus.happy.ui.voice.voicePageEntries
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
import com.slopus.happy.ui.RestoreManualRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.OpenAccount
import com.slopus.happy.ui.LocalAccountSwitcher
import com.slopus.happy.ui.AccountSwitcher
import com.slopus.happy.ui.ProvideSettingsDissolve
import com.slopus.happy.ui.connection.AgentConnectionSettings
import com.slopus.happy.ui.connection.LegacyDataStorageRoute
import com.slopus.happy.ui.connection.dataStorageRoutes
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import com.slopus.happy.accounts.accountId
import com.slopus.happy.ui.connection.rememberAccountsCardActions
import com.slopus.happy.ui.home.rememberAccountMenu
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

// A page Settings' search opens has [reveal], the row it found there ([ProvideRowReveal]).
@Serializable data class AccountRoute(val reveal: String? = null)
@Serializable data class BackupRoute(val reveal: String? = null)
@Serializable data object AppearanceRoute
@Serializable data class LanguageRoute(val reveal: String? = null)
@Serializable data object AgentsRoute
@Serializable data object ConnectClaudeRoute
@Serializable data object ChangelogRoute

/** Settings' screens; [SettingsRoute] itself is HappyApp's ([AccountSettings]). */
fun NavGraphBuilder.settingsRoutes(graph: AppGraph, nav: NavHostController) {
    voiceRoutes(graph, nav)
    dataStorageRoutes(graph, nav)
    page<AccountRoute> { entry -> ProvideRowReveal(entry.toRoute<AccountRoute>().reveal) { Account(graph, nav) } }
    page<BackupRoute> { entry -> ProvideRowReveal(entry.toRoute<BackupRoute>().reveal) { Backup(graph, nav) } }
    page<AppearanceRoute> { Appearance(graph, nav) }
    page<AgentsRoute> { Agents(graph, nav) }
    page<ConnectClaudeRoute> { ConnectClaudeScreen(onBack = { nav.popBackStack() }) }
    page<ChangelogRoute> {
        val resources = LocalResources.current
        val changelog = remember(resources) { Changelog.bundled(resources) }
        ChangelogScreen(changelog, onViewed = graph.changelog::markViewed, onBack = { nav.popBackStack() })
    }
    page<LanguageRoute> { entry ->
        val settings by graph.settings.settings.collectAsStateWithLifecycle()
        ProvideRowReveal(entry.toRoute<LanguageRoute>().reveal) {
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
}

@Composable
private fun Appearance(graph: AppGraph, nav: NavHostController) {
    val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
    val animatedAvatars by graph.liveAvatars.enabled.collectAsStateWithLifecycle()
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
        onLanguage = { nav.navigate(LanguageRoute()) },
        animatedAvatars = animatedAvatars,
        onAnimatedAvatarsChange = graph.liveAvatars::set,
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

/** What About shows for this build, and Support us for this account's purchases. */
@Composable
internal fun rememberAboutInfo(graph: AppGraph): AboutInfo {
    val resources = LocalResources.current
    val purchases by graph.purchases.purchases.collectAsStateWithLifecycle()
    return AboutInfo(
        versionName = versionDetail(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
        versionSubtitle = buildSubtitle(BuildConfig.BUILD_COMMIT_SHA, BuildConfig.BUILD_COMMIT_TIMESTAMP, resources.getString(R.string.settings_commit)) {
            resources.getString(R.string.settings_commit_at, it)
        },
        isPro = BuildConfig.DEBUG || purchases.entitlements["pro"] == true,
    )
}

/**
 * About's and Support us' actions, the same on both kinds of page: links
 * open outside, What's New, ten taps on Version toggle developer mode (with
 * its alert), Support us presents the paywall. Shows its own alerts.
 */
@Composable
internal fun rememberAboutActions(graph: AppGraph, nav: NavHostController): AboutActions {
    val uriHandler = LocalUriHandler.current
    val alerts = remember { Alerts() }
    val onError = errorAlert(alerts)
    val support = rememberSupportAction(graph.purchases, onError)
    val versionClicks = remember { MultiClick(required = 10) }
    val developerMode = stringResource(R.string.modals_developer_mode)
    val developerModeEnabled = stringResource(R.string.modals_developer_mode_enabled)
    val developerModeDisabled = stringResource(R.string.modals_developer_mode_disabled)
    val ok = stringResource(R.string.common_ok)
    alerts.Host()
    return remember(graph, nav, uriHandler, support, developerMode, developerModeEnabled, developerModeDisabled, ok) {
        AboutActions(
            onOpenUrl = { url -> openExternalUrl(uriHandler, url) },
            onWhatsNew = { nav.navigate(ChangelogRoute) },
            onVersion = {
                if (versionClicks.click()) {
                    val enabled = !graph.localSettings.values.value.devModeEnabled
                    graph.localSettings.change { it.copy(devModeEnabled = enabled) }
                    alerts.show(Alert(developerMode, if (enabled) developerModeEnabled else developerModeDisabled, listOf(AlertButton(ok))))
                }
            },
            onSupport = support::run,
        )
    }
}

/** The open Happy account's server host, or null for the default server. */
private fun serverHost(graph: AppGraph): String? =
    graph.serverUrl.takeIf { it != graph.serverConfig.defaultUrl }?.let { url -> runCatching { java.net.URI(url).host }.getOrNull() ?: url }

/**
 * Settings of the open account ([AppGraph.openAccount]), of either kind,
 * on one scroll position. A switch made here ([AccountSwitcher.fromSettings])
 * changes the page in place where it was scrolled to, clamped to the new
 * page's end (iOS's `SettingsLayout.keptOffset`): the picture, name, line
 * and accounts card head both kinds alike, so they stay put.
 */
@Composable
fun AccountSettings(graph: AppGraph, nav: NavHostController, open: OpenAccount) {
    val scroll = rememberScrollState()
    ProvideSettingsDissolve {
        when (open) {
            is OpenAccount.Happy -> SettingsIndex(graph, nav, scroll)
            is OpenAccount.Agent -> AgentConnectionSettings(graph, nav, open.id, scroll)
            OpenAccount.None -> Unit
        }
    }
}

/** [value] while there is one, else the last there was: what a page keeps showing while its account goes. */
@Composable
internal fun <T : Any> rememberLast(value: T?): T? {
    val last = remember { arrayOfNulls<Any>(1) }
    if (value != null) last[0] = value
    @Suppress("UNCHECKED_CAST")
    return last[0] as T?
}

@Composable
private fun SettingsIndex(graph: AppGraph, nav: NavHostController, scroll: ScrollState) {
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    // Signing out from here, the page stays as it was until the next account's takes its place.
    val signedIn = rememberLast(auth as? AuthState.SignedIn) ?: return
    val stored by rememberProfile(graph)
    val registry by graph.accountStore.registry.collectAsStateWithLifecycle()
    val connect = rememberTerminalConnect(graph)
    var enteringUrl by remember { mutableStateOf(false) }
    val kind = stringResource(R.string.account_kind_cli)
    val id = accountId(signedIn.credentials) ?: stored.id
    // The store follows a switch a moment after the account: until it is this one's, the switcher's copy.
    val profile = stored.takeIf { it.id.isNotEmpty() && it.id == signedIn.publicId }
    val display = registry.entry(id)?.display
    val login = profile?.github?.login ?: display?.username
    val switcher = LocalAccountSwitcher.current
    val name = profile?.displayName ?: display?.name ?: login ?: kind

    SettingsScreen(
        profile = SettingsProfile(
            id = id,
            name = name,
            // One with no name of its own is already called by its kind (iOS's SettingsViewController).
            subtitle = if (name == kind) "" else kindSubtitle(kind, login?.let { "@$it" }),
            imageUri = profile?.avatarUrl ?: display?.avatarUrl,
            thumbhash = profile?.avatar?.thumbhash ?: display?.avatarThumbhash,
        ),
        about = rememberAboutInfo(graph),
        accounts = rememberAccountMenu(graph).shownAs(id),
        accountActions = rememberAccountsCardActions(graph),
        actions = remember(graph, nav, connect, switcher) {
            HappySettingsActions(
                onBack = { nav.popBackStack() },
                onAccount = { nav.navigate(AccountRoute()) },
                onBackup = { nav.navigate(BackupRoute()) },
                onAppearance = { nav.navigate(AppearanceRoute) },
                onLanguage = { nav.navigate(LanguageRoute()) },
                onVoice = { nav.navigate(VoiceSettingsRoute()) },
                onAgents = { nav.navigate(AgentsRoute) },
                onDataStorage = { nav.navigate(LegacyDataStorageRoute) },
                onScanTerminal = connect::scan,
                onEnterTerminal = { enteringUrl = true },
                onSignOut = { if (switcher != null) switcher.removingFromSettings { graph.logout().join() } else graph.logout() },
            )
        },
        aboutActions = rememberAboutActions(graph, nav),
        connectingTerminal = connect.isLoading,
        pages = rememberPageEntries(graph, nav, signedIn, profile ?: Profile.Defaults),
        scroll = scroll,
    )
    if (enteringUrl) EnterTerminalUrlPrompt(connect, onDismiss = { enteringUrl = false })
}

/**
 * The rows of a Happy account's own pages, for Settings' search (iOS's
 *  for a Happy account: Account, Backup & Restore, Voice and
 * Language; its Support us is the paywall here, not a page). Each opens
 * its page at the row.
 */
@Composable
private fun rememberPageEntries(graph: AppGraph, nav: NavHostController, account: AuthState.SignedIn, profile: Profile): List<SettingsEntry> {
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val purchases by graph.purchases.purchases.collectAsStateWithLifecycle()
    return accountPageEntries(
        anonId = account.encryption.anonId,
        publicId = account.publicId,
        displayName = profile.displayName,
        username = profile.github?.login,
        server = serverHost(graph),
    ) { nav.navigate(AccountRoute(reveal = it)) } +
        backupPageEntries { nav.navigate(BackupRoute(reveal = it)) } +
        voicePageEntries(settings, purchases.entitlements["pro"] == true) { nav.navigate(VoiceSettingsRoute(reveal = it)) } +
        languagePageEntries(settings.preferredLanguage, Languages.detectedName(graph.language.deviceLocales())) { nav.navigate(LanguageRoute(reveal = it)) }
}

@Composable
private fun Backup(graph: AppGraph, nav: NavHostController) {
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val account = auth as? AuthState.SignedIn ?: return
    val link = rememberAccountLink(graph)
    BackupScreen(
        formattedSecretKey = account.formattedSecretKey,
        onBack = { nav.popBackStack() },
        linkingDevice = link.isLoading,
        onLinkNewDevice = link::scan,
        onRestore = { nav.navigate(RestoreManualRoute) },
    )
}

@Composable
private fun Account(graph: AppGraph, nav: NavHostController) {
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val account = auth as? AuthState.SignedIn ?: return
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val profile by rememberProfile(graph)
    val tokensApi = remember(graph) { PushTokensApi(graph.http) { (graph.auth.state.value as? AuthState.SignedIn)?.credentials?.token } }
    val pushRegistration = rememberPushRegistration(graph)
    val scope = rememberCoroutineScope()
    val alerts = remember { Alerts() }
    val errorTitle = stringResource(R.string.common_error)
    val successTitle = stringResource(R.string.common_success)
    val ok = stringResource(R.string.common_ok)
    fun showError(message: String) = alerts.show(Alert(errorTitle, message, listOf(AlertButton(ok))))
    fun showSuccess(message: String) = alerts.show(Alert(successTitle, message, listOf(AlertButton(ok))))

    val context = LocalContext.current
    val resources = LocalResources.current
    val (deviceLabel, appLabel) = remember(resources) {
        PushText.deviceLabels(
            resources,
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

    suspend fun loadPush(showErrors: Boolean = false) {
        push = push.copy(loading = true)
        try {
            val tokens = tokensApi.list()
            push = push.copy(tokens = tokens, permission = pushRegistration.permission(), currentToken = pushRegistration.currentToken())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (showErrors) showError(resources.getString(R.string.push_load_failed))
        } finally {
            push = push.copy(loading = false)
        }
    }
    // Loaded on every visit (useFocusEffect).
    LaunchedEffect(Unit) { loadPush() }

    AccountScreen(
        anonId = account.encryption.anonId,
        publicId = account.publicId,
        analyticsOptOut = settings.analyticsOptOut,
        onAnalyticsOptOutChange = { optOut -> graph.settings.change { it.copy(analyticsOptOut = optOut) } },
        onBack = { nav.popBackStack() },
        displayName = profile.displayName,
        username = profile.github?.login,
        server = serverHost(graph),
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
                        showSuccess(resources.getString(R.string.push_enabled))
                    } else {
                        loadPush()
                        if (result.openedSettings) {
                            alerts.show(Alert(resources.getString(R.string.scan_open_settings), resources.getString(R.string.push_opened_settings), listOf(AlertButton(ok))))
                        } else {
                            showError(resources.getString(R.string.push_not_granted))
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    showError(resources.getString(R.string.push_request_failed))
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
                    if (result.permission.granted) showSuccess(resources.getString(R.string.push_refreshed))
                    else showError(resources.getString(R.string.push_not_enabled))
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    showError(resources.getString(R.string.push_refresh_failed))
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
                    showError(resources.getString(R.string.push_delete_failed))
                } finally {
                    push = push.copy(deletingToken = null)
                }
            }
        },
    )
    alerts.Host()
}
