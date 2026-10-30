package com.slopus.happy.ui.start

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.ui.RestoreRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.connect.ConnectFlow

/**
 * The first screen with its flows: Connect scans and "Enter link manually"
 * asks for the link; both go through the app's Add flow ([add]). The ⋮
 * menu also restores a legacy account and picks the legacy server.
 */
@Composable
fun Start(graph: AppGraph, nav: NavHostController, add: ConnectFlow) {
    val serverUrl by graph.serverConfig.url.collectAsStateWithLifecycle()
    val customServerLabel = remember(serverUrl) { graph.serverConfig.customHostLabel }

    StartScreen(
        connecting = add.isLoading,
        customServerLabel = customServerLabel,
        onConnect = add::scan,
        onEnterLink = { add.enteringLink = true },
        onRestore = { nav.navigate(RestoreRoute) },
        onServer = { nav.navigate(ServerRoute) },
    )
}
