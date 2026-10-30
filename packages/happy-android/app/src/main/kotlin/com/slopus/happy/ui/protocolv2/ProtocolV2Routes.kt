package com.slopus.happy.ui.protocolv2

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.protocolv2.ProtocolV2PairingFlow
import kotlinx.serialization.Serializable

/**
 * Pairing a computer over Happy Protocol V2. Carries no code: the code is a
 * secret and a route is saved with the back stack, so the pairing itself
 * waits in [AppGraph.protocolV2Pairing].
 */
@Serializable data object ProtocolV2PairingRoute

/** The Protocol V2 screens, signed in or out. HappyApp's NavHost calls this once. */
fun NavGraphBuilder.protocolV2Routes(graph: AppGraph, nav: NavHostController) {
    composable<ProtocolV2PairingRoute> { Pairing(graph, nav) }
}

/** Starts pairing [code] and shows it, over whatever screen is up. */
fun NavHostController.pairProtocolV2(graph: AppGraph, code: String) {
    graph.startProtocolV2Pairing(code)
    navigate(ProtocolV2PairingRoute) { launchSingleTop = true }
}

@Composable
private fun Pairing(graph: AppGraph, nav: NavHostController) {
    val holder = viewModel { PairingHolder(graph) }
    // A second code opened while this screen is up replaces the pairing in place.
    val flow by graph.protocolV2Pairing.collectAsStateWithLifecycle()
    LaunchedEffect(flow) { flow?.let { holder.flow = it } }
    val state = key(flow) { flow?.state?.collectAsStateWithLifecycle()?.value }
    ProtocolV2PairingScreen(
        state = state,
        onConfirm = { flow?.confirm() },
        onReject = { flow?.reject() },
        onBack = { nav.popBackStack() },
        onDone = { nav.popBackStack() },
    )
}

/**
 * The pairing this screen shows, kept by its back stack entry: popping the
 * screen, by Back, Done or the system, rejects a pairing that hadn't
 * finished. Recomposition and configuration changes don't.
 */
private class PairingHolder(private val graph: AppGraph) : ViewModel() {
    var flow: ProtocolV2PairingFlow? = graph.protocolV2Pairing.value

    override fun onCleared() {
        flow?.let(graph::endProtocolV2Pairing)
    }
}
