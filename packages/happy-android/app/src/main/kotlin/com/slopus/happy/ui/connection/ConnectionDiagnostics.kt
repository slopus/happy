package com.slopus.happy.ui.connection

import android.content.ClipData
import android.net.ConnectivityManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.connection.TransportDiagnostics
import com.slopus.happy.connection.networkPath
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.page
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable

@Serializable data class ConnectionDiagnosticsRoute(val accountId: String)

internal fun NavGraphBuilder.connectionDiagnosticsRoutes(graph: AppGraph, nav: NavHostController) {
    page<ConnectionDiagnosticsRoute> { entry -> ConnectionDiagnostics(graph, entry.toRoute<ConnectionDiagnosticsRoute>().accountId) { nav.popBackStack() } }
}

@Composable
private fun ConnectionDiagnostics(graph: AppGraph, accountId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val initialNetwork = remember(context) { context.getSystemService(ConnectivityManager::class.java)?.activeNetwork != null }
    val network by remember(context) { context.networkPath() }.collectAsStateWithLifecycle(initialValue = initialNetwork)
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val agent = agents.firstOrNull { it.id == accountId }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val transports by produceState<List<TransportDiagnostics>>(emptyList(), graph, accountId, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                value = graph.agentConnections.diagnostics(accountId)
                delay(1_000)
            }
        }
    }
    val state = if (agent != null) {
        val session = remember(graph, accountId) { graph.agentSessions.session(accountId) }
        val status = session?.status?.collectAsStateWithLifecycle()?.value ?: AgentLinkStatus.Connecting
        val kind = transports.map { it.kind }.distinct().singleOrNull()
        ConnectionPageState(
            status = statusText(status),
            type = when (kind) {
                TransportDiagnostics.Kind.Tailcat -> "Tailcat"
                TransportDiagnostics.Kind.Https -> "HTTPS"
                null -> stringResource(R.string.account_kind_agent)
            },
            networkAvailable = network,
            computer = agent.name,
            server = transports.firstNotNullOfOrNull { it.server } ?: diagnosticServer(agent.server),
            daemonVersion = agent.daemonVersion,
            transports = transports,
        )
    } else {
        val registry by graph.accountStore.registry.collectAsStateWithLifecycle()
        val open by graph.openAccount.collectAsStateWithLifecycle()
        val current by graph.account.collectAsStateWithLifecycle()
        val sync = current.takeIf { open.id == accountId }
        val status = sync?.connectionStatus?.collectAsStateWithLifecycle()?.value ?: ConnectionStatus.DISCONNECTED
        ConnectionPageState(
            status = statusText(when (status) {
                ConnectionStatus.CONNECTED -> AgentLinkStatus.Connected
                // The socket retries for as long as the account is signed in ([com.slopus.happy.connection.accountLinkState]).
                ConnectionStatus.CONNECTING, ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR -> AgentLinkStatus.Connecting
            }),
            type = "Socket.IO",
            networkAvailable = network,
            server = diagnosticServer(registry.entry(accountId)?.serverUrl),
        )
    }
    val clipboard = LocalClipboard.current
    val copyTitle = stringResource(R.string.connection_title)
    ConnectionDiagnosticsScreen(state, "${BuildConfig.VERSION_NAME} (${BuildConfig.BUILD_TYPE})", onCopy = { text ->
        try {
            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(copyTitle, text)))
            true
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { false }
    }, onBack = onBack)
}