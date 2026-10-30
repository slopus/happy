package com.slopus.happy.ui.start

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.ui.RestoreRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.connect.ConnectFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The first screen with its flows: Connect scans and "Enter link manually"
 * asks for the link; both go through the app's Add flow ([add]). The ⋮
 * menu also restores an account, creates an empty one (a failure is
 * "Error / Authentication failed"; happy-app only logs it) and picks the
 * server.
 */
@Composable
fun Start(graph: AppGraph, nav: NavHostController, add: ConnectFlow) {
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

    StartScreen(
        connecting = add.isLoading || creating,
        customServerLabel = customServerLabel,
        onConnect = add::scan,
        onEnterLink = { add.enteringLink = true },
        onRestore = { nav.navigate(RestoreRoute) },
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
        onServer = { nav.navigate(ServerRoute) },
    )
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}
