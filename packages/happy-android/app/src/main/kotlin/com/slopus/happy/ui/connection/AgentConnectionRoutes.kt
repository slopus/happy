package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.connection.PairingFlow
import com.slopus.happy.connection.PairingState
import kotlinx.serialization.Serializable

/**
 * Pairing an agent over Happy Protocol V2. Carries no code: the code is a
 * secret and a route is saved with the back stack, so the pairing itself
 * waits in [AppGraph.agentPairing].
 */
@Serializable data object PairingRoute

/** The Protocol V2 screens, signed in or out. HappyApp's NavHost calls this once. */
fun NavGraphBuilder.agentConnectionRoutes(graph: AppGraph, nav: NavHostController) {
    composable<PairingRoute> { Pairing(graph, nav) }
}

/** Starts pairing [code] and shows it, over whatever screen is up. */
fun NavHostController.connectAgent(graph: AppGraph, code: String) {
    graph.startAgentPairing(code)
    navigate(PairingRoute) { launchSingleTop = true }
}

@Composable
private fun Pairing(graph: AppGraph, nav: NavHostController) {
    val holder = viewModel { PairingHolder(graph) }
    // A second code opened while this screen is up replaces the pairing in place.
    val flow by graph.agentPairing.collectAsStateWithLifecycle()
    LaunchedEffect(flow) { flow?.let { holder.flow = it } }
    val state = key(flow) { flow?.state?.collectAsStateWithLifecycle()?.value }
    PairingScreen(
        state = state,
        onConfirm = { flow?.confirm() },
        onReject = { flow?.reject() },
        onBack = { nav.popBackStack() },
        onDone = {
            // A new connection opens, as on iOS; a failed pairing just leaves.
            (state as? PairingState.Paired)?.let { graph.open(it.account.id) } ?: nav.popBackStack()
        },
    )
}

/**
 * The pairing this screen shows, kept by its back stack entry: popping the
 * screen, by Back, Done or the system, rejects a pairing that hadn't
 * finished. Recomposition and configuration changes don't.
 */
private class PairingHolder(private val graph: AppGraph) : ViewModel() {
    var flow: PairingFlow? = graph.agentPairing.value

    override fun onCleared() {
        flow?.let(graph::endAgentPairing)
    }
}
