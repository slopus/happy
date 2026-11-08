package com.slopus.happy.ui.connection

import android.content.ClipData
import android.os.PersistableBundle
import android.text.format.Formatter
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.ComputeJoinCommand
import com.slopus.happy.agent.ComputeNode
import com.slopus.happy.agent.ComputePool
import com.slopus.happy.agent.ComputePools
import com.slopus.happy.agent.ComputePoolsSource
import com.slopus.happy.agent.Permission
import com.slopus.happy.agent.SandboxCapacity
import com.slopus.happy.agent.ServerPermissions
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.PageDialog
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.page
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.text.DateFormat
import java.util.Date

@Serializable data class CloudComputePoolsRoute(val connectionId: String)

object ComputePoolsTags {
    const val ROW = "computePools.row"
    const val LIST = "computePools.list"
    const val COMMAND = "computePools.command"
    fun node(id: String) = "computePools.node.$id"
    fun add(id: String) = "computePools.add.$id"
    fun drain(id: String) = "computePools.drain.$id"
    fun revoked(id: String) = "computePools.revoked.$id"
}

internal fun canManagePools(cloud: Boolean, permissions: ServerPermissions): Boolean =
    cloud && Permission.POOLS_MANAGE in permissions.granted

internal fun NavGraphBuilder.cloudComputePoolRoutes(graph: AppGraph, nav: NavHostController) {
    page<CloudComputePoolsRoute> { entry ->
        val route = entry.toRoute<CloudComputePoolsRoute>()
        CloudComputePoolsPage(graph, route.connectionId) { nav.popBackStack() }
    }
}

@Composable
private fun CloudComputePoolsPage(graph: AppGraph, connectionId: String, onBack: () -> Unit) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val permissions = session?.permissions?.collectAsStateWithLifecycle()?.value ?: ServerPermissions.Unknown
    if (!canManagePools(session?.client?.cloud == true, permissions)) {
        ComputePoolsScreen(ComputePoolsSource.State.Forbidden, false, {}, {}, {}, onBack)
        return
    }
    val activeSession = requireNotNull(session)
    val source = remember(activeSession, permissions) { ComputePoolsSource(activeSession.client) }
    val state by source.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(source, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { source.observe(activeSession.events) }
    }
    if (state == ComputePoolsSource.State.Forbidden) {
        ComputePoolsScreen(state, false, {}, {}, {}, onBack)
        return
    }
    val scope = rememberCoroutineScope()
    var busy by remember(source) { mutableStateOf(false) }
    var failed by remember(source) { mutableStateOf(false) }
    var confirming by remember(source) { mutableStateOf<ComputeNode?>(null) }
    var command by remember(source) { mutableStateOf<ComputeJoinCommand?>(null) }
    ComputePoolsScreen(
        state, busy,
        onRetry = { scope.launch { source.refresh() } },
        onAdd = { pool ->
            if (!busy) {
                busy = true
                scope.launch {
                    try {
                        command = source.joinCommand(pool)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        failed = true
                    } finally {
                        busy = false
                    }
                }
            }
        },
        onDrain = { confirming = it },
        onBack = onBack,
    )
    confirming?.let { node ->
        val action = stringResource(if (node.status == "draining") R.string.compute_undrain else R.string.compute_drain)
        HappyAlert(Alert(title = action, message = stringResource(if (node.status == "draining") R.string.compute_undrain_confirm else R.string.compute_drain_confirm, node.name), buttons = listOf(
            AlertButton(stringResource(R.string.common_cancel)),
            AlertButton(action) {
                confirming = null
                if (!busy) {
                    busy = true
                    scope.launch {
                        try { failed = !source.drain(node) } finally { busy = false }
                    }
                }
            },
        )), onDismiss = { confirming = null })
    }
    if (failed) HappyAlert(Alert(title = stringResource(R.string.cloud_failed), buttons = listOf(AlertButton(stringResource(R.string.common_ok)))), onDismiss = { failed = false })
    command?.let { join ->
        PageDialog(onDismissRequest = { command = null }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, securePolicy = SecureFlagPolicy.SecureOn)) {
            ComputeJoinScreen(join, onBack = { command = null })
        }
    }
}

/** Standard settings rows in the responsive ItemList column. Nodes expand in place; no attachment controls. */
@Composable
internal fun ComputePoolsScreen(
    state: ComputePoolsSource.State,
    busy: Boolean,
    onRetry: () -> Unit,
    onAdd: (ComputePool) -> Unit,
    onDrain: (ComputeNode) -> Unit,
    onBack: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.compute_pools_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(ComputePoolsTags.LIST)) {
            when (state) {
                ComputePoolsSource.State.Loading -> ItemGroup { Item(stringResource(R.string.compute_pools_title), loading = true, showChevron = false) }
                ComputePoolsSource.State.Forbidden -> ItemGroup { Item(stringResource(R.string.compute_permission), showChevron = false) }
                ComputePoolsSource.State.Failed -> ItemGroup {
                    Item(stringResource(R.string.cloud_failed), subtitle = stringResource(R.string.team_server_try_again), onClick = onRetry, showChevron = false)
                }
                is ComputePoolsSource.State.Loaded -> {
                    if (state.snapshot.pools.isEmpty()) ItemGroup { Item(stringResource(R.string.compute_empty), showChevron = false) }
                    for (pool in state.snapshot.pools) {
                        var showRevoked by remember(pool.id) { mutableStateOf(false) }
                        val nodes = state.snapshot.nodes.filter { it.pool == pool.id }
                        val revoked = nodes.filter { it.status == "revoked" }
                        val summary = ComputePools.statuses.filter { (pool.counts[it] ?: 0) > 0 }.map { status ->
                            "${pool.counts[status]} ${statusLabel(status)}"
                        }.joinToString(" · ")
                        ItemGroup(title = pool.name, footer = summary.ifEmpty { stringResource(R.string.compute_no_nodes) }) {
                            Item(capacityLabel(pool.capacity), showChevron = false)
                            for (node in nodes.filter { it.status in setOf("online", "offline", "draining") }) key(node.id) {
                                ComputeNodeRows(node, busy, onDrain)
                            }
                            Item(stringResource(R.string.compute_add), onClick = { onAdd(pool) }, enabled = !busy, showChevron = false, modifier = Modifier.testTag(ComputePoolsTags.add(pool.id)))
                            if (revoked.isNotEmpty()) {
                                Item(stringResource(R.string.compute_revoked_count, revoked.size), onClick = { showRevoked = !showRevoked },
                                    rightElement = { Icon(if (showRevoked) Ionicon.ChevronUp else Ionicon.ChevronDown, 20.dp, HappyTheme.colors.textSecondary) },
                                    modifier = Modifier.testTag(ComputePoolsTags.revoked(pool.id)))
                                if (showRevoked) for (node in revoked) key(node.id) { ComputeNodeRows(node, busy, onDrain) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Settings rows with 48 dp minimum targets; nullable host totals never produce placeholder rows. */
@Composable
private fun ComputeNodeRows(node: ComputeNode, busy: Boolean, onDrain: (ComputeNode) -> Unit) {
    var expanded by remember(node.id) { mutableStateOf(false) }
    Item(
        node.name, subtitle = statusLabel(node.status), onClick = { expanded = !expanded },
        rightElement = { Icon(if (expanded) Ionicon.ChevronUp else Ionicon.ChevronDown, 20.dp, HappyTheme.colors.textSecondary) },
        modifier = Modifier.testTag(ComputePoolsTags.node(node.id)),
    )
    if (expanded) {
        Item(capacityLabel(node.capacity), showChevron = false)
        val context = LocalContext.current
        node.host?.cpuCores?.let { Item(stringResource(R.string.compute_cpu_count), titleLines = 0, detail = java.text.NumberFormat.getIntegerInstance().format(it), showChevron = false) }
        node.host?.totalMemoryBytes?.let { Item(stringResource(R.string.compute_total_memory), titleLines = 0, detail = Formatter.formatShortFileSize(context, it), showChevron = false) }
        node.host?.totalDiskBytes?.let { Item(stringResource(R.string.compute_total_disk), titleLines = 0, detail = Formatter.formatShortFileSize(context, it), showChevron = false) }
        Item(stringResource(R.string.compute_last_seen), subtitle = node.lastSeenAt?.let(::timestamp) ?: stringResource(R.string.status_unknown), showChevron = false)
        Item(stringResource(R.string.common_version), subtitle = node.version ?: stringResource(R.string.status_unknown), showChevron = false)
        Item(
            stringResource(R.string.settings_agents),
            subtitle = node.agents.joinToString("\n\n") { agent ->
                agent.title?.takeIf { it.isNotBlank() }?.let { "$it\n${agent.agentId}" } ?: agent.agentId
            }.ifEmpty { stringResource(R.string.compute_no_agents) },
            subtitleLines = Int.MAX_VALUE, showChevron = false,
        )
        if (node.canDrain) Item(
            stringResource(if (node.status == "draining") R.string.compute_undrain else R.string.compute_drain),
            onClick = { onDrain(node) }, enabled = !busy, showChevron = false, modifier = Modifier.testTag(ComputePoolsTags.drain(node.id)),
        )
    }
}

@Composable
private fun capacityLabel(capacity: SandboxCapacity): String = if (capacity.total == null) stringResource(R.string.compute_capacity_unknown, capacity.used)
else stringResource(R.string.compute_capacity, capacity.used, capacity.total)

@Composable
private fun statusLabel(status: String): String = stringResource(when (status) {
    "online" -> R.string.status_online
    "offline" -> R.string.status_offline
    "draining" -> R.string.compute_draining
    "enrolling" -> R.string.compute_enrolling
    "revoked" -> R.string.compute_revoked
    else -> R.string.status_unknown
})

private fun timestamp(millis: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(millis))

/** A secure, memory-only page using the normal header and settings column. Commands are copied verbatim. */
@Composable
internal fun ComputeJoinScreen(command: ComputeJoinCommand, onBack: () -> Unit) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var expired by remember(command) { mutableStateOf(System.currentTimeMillis() >= command.expiresAt) }
    LaunchedEffect(command) {
        delay((command.expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
        expired = true
    }
    Screen(header = { StackHeader(stringResource(R.string.compute_add), onBack) }) {
        ItemList {
            ItemGroup(footer = stringResource(R.string.compute_command_note)) {
                Item(stringResource(if (expired) R.string.compute_expired else R.string.compute_expires, timestamp(command.expiresAt)), showChevron = false)
            }
            if (!expired) {
                if (command.unix == null && command.windows == null) ItemGroup { Item(stringResource(R.string.compute_installer_missing), showChevron = false) }
                for ((label, text) in listOf("Linux / macOS" to command.unix, "Windows" to command.windows)) {
                    if (text == null) continue
                    ItemGroup(title = label) {
                        Column(Modifier.fillMaxWidth().padding(16.dp)) {
                            Text(text, style = happyTextStyle(fontSize = 13, lineHeight = 18).copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag(ComputePoolsTags.COMMAND))
                        }
                        Item(stringResource(R.string.common_copy), showChevron = false, onClick = {
                            scope.launch {
                                val clip = ClipData.newPlainText(label, text)
                                clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
                                clipboard.setClipEntry(ClipEntry(clip))
                            }
                        })
                    }
                }
            }
        }
    }
}