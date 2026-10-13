package com.slopus.happy.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.auth.AuthState
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.home.HomeScreen
import com.slopus.happy.ui.onboarding.RestoreManualScreen
import com.slopus.happy.ui.onboarding.RestoreScreen
import com.slopus.happy.ui.onboarding.WelcomeScreen
import com.slopus.happy.ui.server.ServerScreen
import com.slopus.happy.ui.settings.AccountScreen
import com.slopus.happy.ui.settings.AppearanceScreen
import com.slopus.happy.ui.settings.SettingsScreen
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

@Serializable data object WelcomeRoute
@Serializable data object ServerRoute
@Serializable data object RestoreRoute
@Serializable data object RestoreManualRoute
@Serializable data object HomeRoute
@Serializable data object SettingsRoute
@Serializable data object AccountRoute
@Serializable data object AppearanceRoute

/**
 * The whole UI. Signed out and signed in are separate back stacks: when the
 * account changes the stack is replaced, as happy-app's `router.dismissTo('/')`
 * after login and its reload after logout do.
 */
@Composable
fun HappyApp(graph: AppGraph, onDarkThemeChange: (Boolean) -> Unit = {}) {
    val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
    val auth by graph.auth.state.collectAsStateWithLifecycle()

    HappyTheme(preference = theme) {
        val dark = HappyTheme.colors.dark
        LaunchedEffect(dark) { onDarkThemeChange(dark) }

        val signedIn = auth as? AuthState.SignedIn
        key(signedIn != null) {
            val nav = rememberNavController()
            NavHost(navController = nav, startDestination = if (signedIn != null) HomeRoute else WelcomeRoute) {
                composable<WelcomeRoute> { Welcome(graph, nav) }
                composable<ServerRoute> { Server(graph, nav) }
                composable<RestoreRoute> {
                    RestoreScreen(onBack = { nav.popBackStack() }, onUseSecretKey = { nav.navigate(RestoreManualRoute) })
                }
                composable<RestoreManualRoute> { RestoreManual(graph, nav) }
                composable<HomeRoute> { HomeScreen(onSettings = { nav.navigate(SettingsRoute) }) }
                composable<SettingsRoute> {
                    val uriHandler = LocalUriHandler.current
                    SettingsScreen(
                        versionName = BuildConfig.VERSION_NAME,
                        onBack = { nav.popBackStack() },
                        onAccount = { nav.navigate(AccountRoute) },
                        onAppearance = { nav.navigate(AppearanceRoute) },
                        onOpenUrl = uriHandler::openUri,
                    )
                }
                composable<AccountRoute> { signedIn?.let { Account(graph, it, nav) } }
                composable<AppearanceRoute> {
                    AppearanceScreen(theme = theme, onThemeChange = graph.localSettings::setThemePreference, onBack = { nav.popBackStack() })
                }
            }
        }
    }
}

@Composable
private fun Welcome(graph: AppGraph, nav: NavHostController) {
    val scope = rememberCoroutineScope()
    val serverUrl by graph.serverConfig.url.collectAsStateWithLifecycle()
    val customServerLabel = remember(serverUrl) { graph.serverConfig.customHostLabel }
    var creating by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val failed = Alert(
        stringResource(R.string.common_error),
        stringResource(R.string.errors_authentication_failed),
        listOf(AlertButton(stringResource(R.string.common_ok))),
    )

    WelcomeScreen(
        customServerLabel = customServerLabel,
        creatingAccount = creating,
        onCreateAccount = {
            scope.launch {
                creating = true
                try {
                    graph.auth.createAccount()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    alert = failed
                } finally {
                    creating = false
                }
            }
        },
        onRestore = { nav.navigate(RestoreRoute) },
        onServer = { nav.navigate(ServerRoute) },
    )
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

@Composable
private fun Server(graph: AppGraph, nav: NavHostController) {
    val serverUrl by graph.serverConfig.url.collectAsStateWithLifecycle()
    ServerScreen(
        customUrl = serverUrl.takeIf { graph.serverConfig.isCustom },
        probe = graph.authApi::probeServer,
        onSave = graph.serverConfig::set,
        onReset = { graph.serverConfig.set(null) },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun RestoreManual(graph: AppGraph, nav: NavHostController) {
    val scope = rememberCoroutineScope()
    var secretKey by rememberSaveable { mutableStateOf("") }
    var restoring by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val error = stringResource(R.string.common_error)
    val ok = stringResource(R.string.common_ok)
    val enterKey = stringResource(R.string.connect_enter_secret_key)
    val invalidKey = stringResource(R.string.connect_invalid_secret_key)

    RestoreManualScreen(
        secretKey = secretKey,
        onSecretKeyChange = { secretKey = it },
        restoring = restoring,
        onRestore = {
            if (secretKey.isBlank()) {
                alert = Alert(error, enterKey, listOf(AlertButton(ok)))
            } else {
                scope.launch {
                    restoring = true
                    try {
                        graph.auth.restore(secretKey)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // Like happy-app: a bad key and a failed exchange read the same.
                        alert = Alert(error, invalidKey, listOf(AlertButton(ok)))
                    } finally {
                        restoring = false
                    }
                }
            }
        },
        onBack = { nav.popBackStack() },
    )
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

@Composable
private fun Account(graph: AppGraph, account: AuthState.SignedIn, nav: NavHostController) {
    val scope = rememberCoroutineScope()
    val changes by graph.store.changes.collectAsStateWithLifecycle()
    val analyticsOptOut by produceState(initialValue = false, changes) {
        value = withContext(Dispatchers.IO) {
            graph.store.effectiveSettings()["analyticsOptOut"]?.jsonPrimitive?.booleanOrNull ?: false
        }
    }

    AccountScreen(
        anonId = account.encryption.anonId,
        publicId = account.publicId,
        formattedSecretKey = account.formattedSecretKey,
        analyticsOptOut = analyticsOptOut,
        onAnalyticsOptOutChange = { optOut ->
            scope.launch {
                withContext(Dispatchers.IO) {
                    graph.store.changeSettings(JsonObject(mapOf("analyticsOptOut" to JsonPrimitive(optOut))))
                }
                graph.requestSync()
            }
        },
        onLogout = { graph.logout() },
        onBack = { nav.popBackStack() },
    )
}
