package com.slopus.happy.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.slopus.happy.R
import com.slopus.happy.auth.AccountLinkRequest
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.HappyJson
import com.slopus.happy.ui.RestoreManualRoute
import com.slopus.happy.ui.RestoreRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.troubleshoot.TroubleshootComputer
import com.slopus.happy.ui.troubleshoot.TroubleshootScreen
import com.slopus.happy.ui.troubleshoot.TroubleshootSession
import com.slopus.happy.ui.troubleshoot.buildOfflineMachineTroubleshooting
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** onboarding/settings.tsx, the gear on Link Your Computer. */
@Serializable data object OnboardingSettingsRoute

/** troubleshoot.tsx */
@Serializable data object TroubleshootRoute

/**
 * The onboarding screens HappyApp's NavHost doesn't declare itself.
 * [onOpenMachine] opens the machine screen (Home's) from troubleshoot.
 */
fun NavGraphBuilder.onboardingRoutes(
    graph: AppGraph,
    nav: NavHostController,
    onOpenMachine: (id: String) -> Unit = {},
) {
    composable<RestoreRoute> { Restore(graph, nav) }
    composable<OnboardingSettingsRoute> {
        val serverUrl by graph.serverConfig.url.collectAsStateWithLifecycle()
        OnboardingSettingsScreen(
            customServerLabel = remember(serverUrl) { graph.serverConfig.customHostLabel },
            onServer = { nav.navigate(ServerRoute) },
            onLogout = { graph.logout() },
            onBack = { nav.popBackStack() },
        )
    }
    composable<TroubleshootRoute> {
        val uriHandler = LocalUriHandler.current
        val changes by graph.store.changes.collectAsStateWithLifecycle()
        val input by produceState(TroubleshootInput(emptyList(), emptyList()), changes) {
            value = withContext(Dispatchers.IO) { troubleshootInput(graph.store) }
        }
        val guide = remember(input) { buildOfflineMachineTroubleshooting(input.computers, input.sessions) }
        TroubleshootScreen(
            computers = input.computers,
            aiPrompt = guide.aiPrompt,
            onOpenMachine = onOpenMachine,
            onOpenUrl = uriHandler::openUri,
            onBack = { nav.popBackStack() },
        )
    }
}

/**
 * restore/index.tsx: registers a link request, shows its QR code and waits
 * for the other phone. Approval signs in, which replaces the signed-out
 * screens with home (happy-app's `router.dismissTo('/')`). A failure is an
 * alert and leaves the spinner, as in happy-app.
 */
@Composable
private fun Restore(graph: AppGraph, nav: NavHostController) {
    val request = remember { AccountLinkRequest(graph.authApi) }
    var ready by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val failed = Alert(
        stringResource(R.string.common_error),
        stringResource(R.string.errors_authentication_failed),
        listOf(AlertButton(stringResource(R.string.common_ok))),
    )
    LaunchedEffect(request) {
        try {
            request.start()
            ready = true
            val linked = request.awaitApproval()
            if (linked != null) graph.auth.signIn(linked.token, linked.secret) else alert = failed
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            alert = failed
        } finally {
            ready = false
        }
    }
    RestoreScreen(
        qrUrl = request.url.takeIf { ready },
        onBack = { nav.popBackStack() },
        onUseSecretKey = { nav.navigate(RestoreManualRoute) },
    )
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

private data class TroubleshootInput(val computers: List<TroubleshootComputer>, val sessions: List<TroubleshootSession>)

/**
 * Every machine as its own computer, named by `displayName` or `host`.
 * Happy Agent pairing (machineChoices.ts) arrives with Home's machine model,
 * which should feed [TroubleshootScreen] instead.
 */
private fun troubleshootInput(store: HappyStore): TroubleshootInput {
    fun parse(json: String?): JsonObject? = try {
        json?.let { HappyJson.parseToJsonElement(it).jsonObject }
    } catch (_: IllegalArgumentException) {
        null
    }
    fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

    val computers = store.machines().map { machine ->
        val metadata = parse(machine.metadataJson)
        TroubleshootComputer(
            id = machine.id,
            name = metadata?.text("displayName")?.ifEmpty { null } ?: metadata?.text("host") ?: "Unknown machine",
            online = machine.active,
            activeAt = machine.activeAt,
            happyHomeDir = metadata?.text("happyHomeDir"),
        )
    }
    val sessions = store.sessions().map { session ->
        val metadata = parse(session.metadataJson)
        TroubleshootSession(
            updatedAt = session.updatedAt,
            machineId = metadata?.text("machineId"),
            projectName = (metadata?.get("project") as? JsonObject)?.text("name"),
            path = metadata?.text("path"),
            happyHomeDir = metadata?.text("happyHomeDir"),
        )
    }
    return TroubleshootInput(computers, sessions)
}
