package com.slopus.happy.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.auth.AccountLinkRequest
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.collectMachineChoices
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

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
 * alert and leaves the spinner, as in happy-app. The request lives as long
 * as the screen is on the back stack ([RestoreLink]): "Use secret key"
 * covers it without ending the wait, so an approval made meanwhile still
 * signs in.
 */
@Composable
private fun Restore(graph: AppGraph, nav: NavHostController) {
    val link = viewModel { RestoreLink(graph) }
    val ready by link.ready.collectAsStateWithLifecycle()
    val failedNow by link.failed.collectAsStateWithLifecycle()
    val failed = Alert(
        stringResource(R.string.common_error),
        stringResource(R.string.errors_authentication_failed),
        listOf(AlertButton(stringResource(R.string.common_ok))),
    )
    RestoreScreen(
        qrUrl = link.request.url.takeIf { ready },
        onBack = { nav.popBackStack() },
        onUseSecretKey = { nav.navigate(RestoreManualRoute) },
    )
    if (failedNow) HappyAlert(failed, onDismiss = { link.failed.value = false })
}

/**
 * [Restore]'s link request and its wait, kept by the Restore back stack
 * entry: expo-router leaves restore/index mounted under restore/manual, and
 * a covered Compose destination would otherwise drop both. Popping the
 * screen cancels the wait.
 */
internal class RestoreLink(graph: AppGraph) : ViewModel() {
    val request = AccountLinkRequest(graph.authApi)
    val ready = MutableStateFlow(false)
    val failed = MutableStateFlow(false)

    init {
        viewModelScope.launch {
            try {
                request.start()
                ready.value = true
                val linked = request.awaitApproval()
                if (linked != null) graph.auth.signIn(linked.token, linked.secret) else failed.value = true
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                failed.value = true
            } finally {
                ready.value = false
            }
        }
    }
}

private data class TroubleshootInput(val computers: List<TroubleshootComputer>, val sessions: List<TroubleshootSession>)

/** The computers as Home groups them (machineChoices.ts) and every session, read off the main thread. */
private fun troubleshootInput(store: HappyStore): TroubleshootInput {
    val computers = collectMachineChoices(store.machines().map(Machine::from)).map { choice ->
        TroubleshootComputer(
            id = choice.id,
            name = choice.name,
            machineIds = choice.machineIds,
            online = choice.online,
            activeAt = choice.activeAt,
            happyHomeDir = choice.happyMachine?.metadata?.happyHomeDir ?: choice.rigMachine?.metadata?.happyHomeDir,
        )
    }
    val sessions = store.sessions().map(Session::from).map { session ->
        TroubleshootSession(
            updatedAt = session.updatedAt,
            machineId = session.metadata?.machineId,
            projectName = session.metadata?.project?.name,
            path = session.metadata?.path,
            happyHomeDir = session.metadata?.happyHomeDir,
        )
    }
    return TroubleshootInput(computers, sessions)
}
