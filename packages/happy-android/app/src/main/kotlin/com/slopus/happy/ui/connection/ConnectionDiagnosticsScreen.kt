package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.connection.TransportDiagnostics
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Values already bound to one account; no token, private address, URL query or arbitrary error text. */
data class ConnectionPageState(
    val status: String,
    val type: String,
    val networkAvailable: Boolean,
    val computer: String? = null,
    val server: String? = null,
    val daemonVersion: String? = null,
    val transports: List<TransportDiagnostics>? = null,
)

internal fun diagnosticServer(url: String?): String? = url?.toHttpUrlOrNull()?.let {
    val host = if (':' in it.host) "[${it.host}]" else it.host
    val defaultPort = if (it.scheme == "https") 443 else 80
    host + if (it.port == defaultPort) "" else ":${it.port}"
}

/** Deliberately accepts only the safe page values, rather than credentials or raw transport objects. */
fun connectionDiagnosticsText(state: ConnectionPageState, appVersion: String): String = buildString {
    fun line(key: String, value: Any?) {
        if (value != null) append(key).append(": ").append(value.toString().map { if (it.isISOControl()) ' ' else it }.joinToString("")).append('\n')
    }
    line("Happy Android", appVersion)
    line("Status", state.status)
    line("Type", state.type)
    line("Network available", state.networkAvailable)
    line("Computer", state.computer)
    line("Server", state.server)
    line("Happy Agent version", state.daemonVersion)
    state.transports?.let { transports ->
        line("Open app flows", transports.sumOf { it.openFlows })
        val tunnels = transports.flatMap { it.tunnels }
        if (transports.any { it.kind == TransportDiagnostics.Kind.Tailcat }) line("Tailcat tunnels", tunnels.size)
        tunnels.forEachIndexed { index, tunnel ->
            line("Tunnel ${index + 1} category", tunnel.category)
            line("Tunnel ${index + 1} path", tunnel.path)
            line("Tunnel ${index + 1} configured relay", tunnel.configuredRelay)
            line("Tunnel ${index + 1} open app flows", tunnel.openFlows)
        }
    }
}

object ConnectionPageTags {
    const val ROW = "dataStorage.connection"
    const val COPY = "connection.copy"
    const val FLOWS = "connection.flows"
}

@Composable
fun ConnectionDiagnosticsScreen(state: ConnectionPageState, appVersion: String, onCopy: suspend (String) -> Boolean, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf<Boolean?>(null) }
    AgentPage(stringResource(R.string.connection_title), onBack) {
        ItemGroup {
            Item(stringResource(R.string.connection_status), detail = state.status)
            Item(stringResource(R.string.connection_type), detail = state.type)
            state.computer?.let { Item(stringResource(R.string.account_kind_agent), subtitle = it, subtitleLines = 0) }
            state.server?.let { Item(stringResource(R.string.connection_server), subtitle = it, subtitleLines = 0) }
            state.daemonVersion?.let { Item(stringResource(R.string.common_version), detail = it) }
            Item(stringResource(R.string.connection_network), detail = stringResource(if (state.networkAvailable) R.string.common_yes else R.string.common_no), titleLines = 0)
        }
        state.transports?.let { transports ->
            val tunnels = transports.flatMap { it.tunnels }
            ItemGroup {
                Item(stringResource(R.string.connection_open_flows), Modifier.testTag(ConnectionPageTags.FLOWS), detail = transports.sumOf { it.openFlows }.toString(), titleLines = 0)
                if (transports.any { it.kind == TransportDiagnostics.Kind.Tailcat }) {
                    Item(stringResource(R.string.connection_tunnels), detail = tunnels.size.toString())
                }
            }
            tunnels.forEachIndexed { index, tunnel ->
                ItemGroup(title = stringResource(R.string.connection_tunnel, index + 1)) {
                    Item(stringResource(R.string.connection_path), detail = stringResource(if (tunnel.path == TransportDiagnostics.Path.Direct) R.string.connection_direct else R.string.connection_relayed))
                    tunnel.configuredRelay?.let { Item(stringResource(R.string.connection_relay), subtitle = it, subtitleLines = 0, titleLines = 0) }
                    Item(stringResource(R.string.connection_open_flows), detail = tunnel.openFlows.toString(), titleLines = 0)
                }
            }
        }
        ItemGroup(footer = if (copied == false) stringResource(R.string.connection_copy_failed) else null) {
            Item(
                stringResource(R.string.connection_copy),
                Modifier.testTag(ConnectionPageTags.COPY),
                detail = if (copied == true) stringResource(R.string.common_copied) else null,
                showChevron = false,
                titleLines = 0,
                onClick = { scope.launch { copied = onCopy(connectionDiagnosticsText(state, appVersion)) } },
            )
        }
    }
}