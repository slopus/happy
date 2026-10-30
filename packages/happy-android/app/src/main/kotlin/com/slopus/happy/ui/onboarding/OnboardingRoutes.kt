package com.slopus.happy.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalUriHandler
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AccountLinkRequest
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.ui.RestoreManualRoute
import com.slopus.happy.ui.RestoreRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.troubleshoot.TroubleshootComputer
import com.slopus.happy.ui.troubleshoot.TroubleshootScreen
import com.slopus.happy.ui.troubleshoot.TroubleshootSession
import com.slopus.happy.ui.troubleshoot.buildOfflineMachineTroubleshooting
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
 * screens with home (happy-app's `router.dismissTo('/')`). A failure says
 * so in the code's place with Retry, which starts a new request; happy-app
 * leaves its spinner turning with nothing behind it. The request lives as
 * long as the screen is on the back stack ([RestoreLink]): "Use secret key"
 * covers it without ending the wait, so an approval made meanwhile still
 * signs in.
 */
@Composable
private fun Restore(graph: AppGraph, nav: NavHostController) {
    val link = viewModel { RestoreLink(graph) }
    val code by link.code.collectAsStateWithLifecycle()
    RestoreScreen(
        code = code,
        onBack = { nav.popBackStack() },
        onRetry = link::retry,
        onUseSecretKey = { nav.navigate(RestoreManualRoute) },
    )
}

/**
 * [Restore]'s link request and its wait, kept by the Restore back stack
 * entry: expo-router leaves restore/index mounted under restore/manual, and
 * a covered Compose destination would otherwise drop both. Popping the
 * screen cancels the wait. Each attempt is a new request with its own key,
 * and one attempt at a time: [retry] stops the last one before the next
 * begins, so an old wait can neither sign in nor show its code afterwards.
 */
internal class RestoreLink(private val graph: AppGraph) : ViewModel() {
    private val state = MutableStateFlow<RestoreCode>(RestoreCode.Waiting)
    val code: StateFlow<RestoreCode> = state.asStateFlow()
    private var attempt: Job? = null

    init {
        retry()
    }

    fun retry() {
        val previous = attempt
        attempt = viewModelScope.launch {
            previous?.cancelAndJoin()
            state.value = RestoreCode.Waiting
            val request = AccountLinkRequest(graph.authApi)
            try {
                request.start()
                state.value = RestoreCode.Ready(request.url)
                val linked = request.awaitApproval()
                if (linked != null) graph.auth.signIn(linked.token, linked.secret) else state.value = RestoreCode.Failed
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                state.value = RestoreCode.Failed
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
