package com.slopus.happy.ui.connection

import android.content.ClipData
import android.os.PersistableBundle
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.ComputeAccess
import com.slopus.happy.agent.ComputeAgent
import com.slopus.happy.agent.ComputeApproval
import com.slopus.happy.agent.ComputeConcurrency
import com.slopus.happy.agent.ComputeDraft
import com.slopus.happy.agent.ComputeInstall
import com.slopus.happy.agent.Computer
import com.slopus.happy.agent.ComputeOwner
import com.slopus.happy.agent.ComputeRole
import com.slopus.happy.agent.ComputeSource
import com.slopus.happy.agent.ComputeStatus
import com.slopus.happy.agent.ComputeSystem
import com.slopus.happy.agent.ComputerAdd
import com.slopus.happy.agent.ServerPermissions
import com.slopus.happy.ui.chat.formatLastSeen
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.PageDialog
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.page
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.text.DateFormat
import java.util.Date

@Serializable data class CloudComputeRoute(val connectionId: String)

@Serializable data class CloudComputerRoute(val connectionId: String, val computerId: String)

object ComputeTags {
    const val ROW = "compute.row"
    const val LIST = "compute.list"
    const val ADD = "compute.add"
    const val CREATE = "compute.create"
    const val FAILURE = "compute.failure"
    const val BOUNDARY = "compute.boundary"
    const val AGENTS = "compute.agents"
    const val CONCURRENCY = "compute.concurrency"
    const val FEWER = "compute.concurrency.fewer"
    const val MORE = "compute.concurrency.more"
    const val SAVE = "compute.concurrency.save"
    fun computer(id: String) = "compute.computer.$id"
    fun agent(id: String) = "compute.agent.$id"
    fun remove(agentId: String) = "compute.remove.$agentId"
    fun request(key: String) = "compute.request.$key"
    fun approve(key: String) = "compute.approve.$key"
    fun deny(key: String) = "compute.deny.$key"
    fun access(access: ComputeAccess) = "compute.access.${access.wire}"
    fun command(system: String) = "compute.command.$system"
}

internal fun NavGraphBuilder.cloudComputeRoutes(graph: AppGraph, nav: NavHostController) {
    page<CloudComputeRoute> { entry ->
        val connectionId = entry.toRoute<CloudComputeRoute>().connectionId
        CloudComputePage(graph, connectionId, onOpen = { nav.navigate(CloudComputerRoute(connectionId, it.id)) }) { nav.popBackStack() }
    }
    page<CloudComputerRoute> { entry ->
        val route = entry.toRoute<CloudComputerRoute>()
        CloudComputerPage(graph, route.connectionId, route.computerId) { nav.popBackStack() }
    }
}

/** Answers sent and not settled yet. */
data class ComputePending(val answers: Map<String, Boolean> = emptyMap())

/** Why the last change didn't go through: the server's words, or null when it gave none. */
data class ComputeFailure(val reason: String?)

class ComputeActions(
    val onRetry: () -> Unit = {},
    val onAdd: () -> Unit = {},
    val onOpen: (Computer) -> Unit = {},
    val onAnswer: (ComputeApproval, Boolean) -> Unit = { _, _ -> },
)

private fun said(e: Exception): String? = (e as? AgentApiException)?.message?.takeIf { it.isNotBlank() }

/** The connection's compute while the page is resumed: what the reader may do and, where they may use it, the source read for them. */
@Composable
private fun rememberCompute(graph: AppGraph, connectionId: String): Pair<ComputeRole, ComputeSource?> {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val permissions = session?.permissions?.collectAsStateWithLifecycle()?.value ?: ServerPermissions.Unknown
    val role = ComputeRole.of(session?.client?.cloud == true, permissions)
    if (session == null || role == ComputeRole.None) return ComputeRole.None to null
    val readerId = graph.agentConnections.accounts.collectAsStateWithLifecycle().value.firstOrNull { it.id == connectionId }?.userId
    val source = remember(session, readerId) { ComputeSource(session.client, readerId) { ids -> session.team.names(ids) } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(source, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { source.observe(session.events) }
    }
    return role to source
}

@Composable
private fun CloudComputePage(graph: AppGraph, connectionId: String, onOpen: (Computer) -> Unit, onBack: () -> Unit) {
    val (role, source) = rememberCompute(graph, connectionId)
    if (source == null) {
        ComputeScreen(ComputeSource.State.Loading, ComputeRole.None, ComputePending(), null, ComputeActions(), onBack)
        return
    }
    val state by source.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var add by remember(source) { mutableStateOf<ComputerAdd?>(null) }
    var pending by remember(source) { mutableStateOf(ComputePending()) }
    var failure by remember(source) { mutableStateOf<ComputeFailure?>(null) }
    val noCommand = stringResource(R.string.compute_no_command)
    ComputeScreen(
        state, role, pending, failure,
        ComputeActions(
            onRetry = { scope.launch { source.refresh() } },
            onAdd = { add = ComputerAdd.open(role) },
            onOpen = onOpen,
            onAnswer = { approval, approve ->
                if (approval.key !in pending.answers) {
                    pending = pending.copy(answers = pending.answers + (approval.key to approve))
                    failure = null
                    scope.launch {
                        try {
                            source.answer(approval, approve)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            failure = ComputeFailure(said(e))
                        } finally {
                            pending = pending.copy(answers = pending.answers - approval.key)
                        }
                    }
                }
            },
        ),
        onBack,
    )
    add?.let { current ->
        // The install carries a single-use secret: kept off screenshots and the recents thumbnail.
        PageDialog(
            onDismissRequest = { if (current.closable) add = null },
            properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, securePolicy = SecureFlagPolicy.SecureOn),
        ) {
            ComputerAddScreen(
                add = current,
                role = role,
                onChange = { change -> add = add?.edit(role, change) },
                onCreate = {
                    val creating = add?.create()
                    if (creating != null) {
                        add = creating
                        scope.launch {
                            add = try {
                                source.create(creating.draft)?.let { ComputerAdd.Shown(it) } ?: ComputerAdd.Failed(creating.draft, noCommand)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                ComputerAdd.Failed(creating.draft, said(e))
                            }
                        }
                    }
                },
                onClose = { if (add?.closable != false) add = null },
            )
        }
    }
}

/**
 * Settings › Compute on a Happy Cloud server (desktop's
 * HappyAgentComputeSettings): the requests to join the reader's private
 * computers, then every computer agents can join, one flat list, online first.
 * A row is the name and its status, shared or private and whose, how many of
 * its places agents hold, where it runs, what agents read about it, and a
 * warning where restricted commands can't run; it opens the computer. A
 * manager adds a shared or private computer; a member a private one.
 */
@Composable
internal fun ComputeScreen(
    state: ComputeSource.State,
    role: ComputeRole,
    pending: ComputePending,
    failure: ComputeFailure?,
    actions: ComputeActions,
    onBack: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.compute_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(ComputeTags.LIST)) {
            if (role == ComputeRole.None) {
                ItemGroup { Item(stringResource(R.string.compute_permission), titleLines = 0, showChevron = false) }
                return@ItemList
            }
            when (state) {
                ComputeSource.State.Loading -> ItemGroup { Item(stringResource(R.string.compute_title), loading = true, showChevron = false) }
                ComputeSource.State.Failed -> FailedGroup(actions.onRetry)
                is ComputeSource.State.Loaded -> {
                    val (computers, approvals) = state.snapshot
                    failure?.let { FailureGroup(it) }
                    if (approvals.isNotEmpty()) {
                        ItemGroup(title = stringResource(R.string.compute_requests_title), footer = stringResource(R.string.compute_requests_footer)) {
                            for (approval in approvals) key(approval.key) { ApprovalRow(approval, pending.answers[approval.key], actions.onAnswer) }
                        }
                    }
                    if (computers.isEmpty() && approvals.isEmpty()) {
                        ItemGroup(footer = stringResource(if (role == ComputeRole.Manage) R.string.compute_empty_manage else R.string.compute_empty_use)) {
                            Item(stringResource(R.string.compute_empty_title), showChevron = false)
                            AddRow(actions.onAdd)
                        }
                    } else {
                        ItemGroup(
                            title = stringResource(R.string.compute_computers_title),
                            footer = stringResource(if (role == ComputeRole.Manage) R.string.compute_computers_footer_manage else R.string.compute_computers_footer_use),
                        ) {
                            if (computers.isEmpty()) Item(stringResource(R.string.compute_no_computers), titleColor = HappyTheme.colors.textSecondary, showChevron = false)
                            for (computer in computers) key(computer.id) {
                                ComputerSummary(computer, Modifier.testTag(ComputeTags.computer(computer.id))) { actions.onOpen(computer) }
                            }
                            AddRow(actions.onAdd)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FailedGroup(onRetry: () -> Unit) {
    ItemGroup {
        Item(stringResource(R.string.cloud_failed), subtitle = stringResource(R.string.team_server_try_again), onClick = onRetry, showChevron = false)
    }
}

@Composable
private fun FailureGroup(failure: ComputeFailure) {
    ItemGroup(footer = failure.reason ?: stringResource(R.string.cloud_failed), modifier = Modifier.testTag(ComputeTags.FAILURE)) {
        Item(stringResource(R.string.compute_action_failed), titleColor = HappyTheme.colors.textDestructive, showChevron = false)
    }
}

@Composable
private fun AddRow(onAdd: () -> Unit) {
    Item(
        stringResource(R.string.compute_add),
        titleColor = HappyTheme.colors.textLink,
        onClick = onAdd,
        showChevron = false,
        modifier = Modifier.testTag(ComputeTags.ADD),
    )
}

private val subtitle = ItemSpec.subtitle

/** A computer in a card: the list's row, which opens it ([onClick]), and the head of its own page. */
@Composable
private fun ComputerSummary(computer: Computer, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val colors = HappyTheme.colors
    val resources = LocalContext.current.resources
    val detail = listOfNotNull(
        computer.hostname?.takeIf { it != computer.name },
        listOfNotNull(computer.os?.let { OS_NAMES[it] ?: it }, computer.arch).joinToString(" ").ifEmpty { null },
        computer.since?.takeIf { computer.status != ComputeStatus.Online }?.let { formatLastSeen(resources, it, System.currentTimeMillis()) },
    ).joinToString(" · ")
    val clickable = if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier
    Column(modifier.fillMaxWidth().then(clickable).padding(horizontal = ItemSpec.paddingHorizontal, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(computer.name, style = ItemSpec.title, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(ItemSpec.rightSectionGap))
            StatusLabel(computer)
            if (onClick != null) Icon(Ionicon.ChevronForward, ItemSpec.chevronSize, colors.grouped.chevron, Modifier.padding(start = ItemSpec.chevronGap))
        }
        FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Badge(accessLabel(computer.access), colors.textSecondary)
            ownerLabel(computer.owner)?.let { (label, yours) -> Badge(label, if (yours) colors.textLink else colors.textSecondary) }
            Badge(agentsCount(computer), if (computer.full) colors.boxWarning.border else colors.textSecondary)
        }
        if (detail.isNotEmpty()) Text(detail, style = subtitle, color = colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
        computer.description?.let { Text(it, style = subtitle, color = colors.text, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp)) }
        if (!computer.boundary.available && onClick != null) {
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Ionicon.WarningOutline, 16.dp, colors.boxWarning.border)
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.compute_boundary_title), style = subtitle, color = colors.textSecondary)
            }
        }
    }
}

private val OS_NAMES = mapOf("macos" to "macOS", "linux" to "Linux", "windows" to "Windows")

@Composable
private fun agentsCount(computer: Computer): String =
    pluralStringResource(R.plurals.compute_agents_count, computer.concurrency, computer.agents.size, computer.concurrency)

@Composable
private fun StatusLabel(computer: Computer) {
    val colors = HappyTheme.colors
    val (label, color) = when (computer.status) {
        ComputeStatus.Online ->
            if (computer.full) stringResource(R.string.compute_status_full) to colors.boxWarning.border
            else stringResource(R.string.compute_status_online) to colors.status.connected
        ComputeStatus.Offline -> stringResource(R.string.compute_status_offline) to colors.status.disconnected
        ComputeStatus.Draining -> stringResource(R.string.compute_status_draining) to colors.status.connecting
        ComputeStatus.Enrolling -> stringResource(R.string.compute_status_joining) to colors.status.connecting
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(color, size = 8.dp)
        Spacer(Modifier.width(6.dp))
        Text(label, style = subtitle, color = colors.textSecondary)
    }
}

@Composable
private fun Badge(text: String, color: Color) {
    Text(
        text,
        style = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.Medium),
        color = color,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(HappyTheme.colors.surfaceHigh).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
internal fun accessLabel(access: ComputeAccess): String = stringResource(when (access) {
    ComputeAccess.Shared -> R.string.compute_access_shared
    ComputeAccess.Private -> R.string.compute_access_private
})

@Composable
private fun accessAbout(access: ComputeAccess): String = stringResource(when (access) {
    ComputeAccess.Shared -> R.string.compute_access_shared_about
    ComputeAccess.Private -> R.string.compute_access_private_about
})

/** Whose a private computer is, and whether it is the reader's; null for a shared one and an unknown owner. */
@Composable
private fun ownerLabel(owner: ComputeOwner?): Pair<String, Boolean>? = when (owner) {
    null -> null
    ComputeOwner.Reader -> stringResource(R.string.compute_yours) to true
    is ComputeOwner.Member -> (owner.name?.let { stringResource(R.string.compute_owner_named, it) } ?: stringResource(R.string.compute_owner_member)) to false
}

/** A text button in a row: at least 48 high, a spinner in its place while [loading]. */
@Composable
private fun RowAction(title: String, color: Color, modifier: Modifier = Modifier, loading: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier
            .heightIn(min = 48.dp)
            .defaultMinSize(minWidth = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(title, style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.Medium), color = if (loading) Color.Transparent else color.copy(alpha = if (enabled) 1f else 0.5f))
        if (loading) CircularProgressIndicator(Modifier.size(18.dp), color = color, strokeWidth = 2.dp)
    }
}

@Composable
private fun ApprovalRow(approval: ComputeApproval, answering: Boolean?, onAnswer: (ComputeApproval, Boolean) -> Unit) {
    val colors = HappyTheme.colors
    val ago = formatLastSeen(LocalContext.current.resources, approval.createdAt, System.currentTimeMillis())
    Column(Modifier.fillMaxWidth().testTag(ComputeTags.request(approval.key)).padding(start = ItemSpec.paddingHorizontal, end = ItemSpec.paddingHorizontal, top = 12.dp, bottom = 4.dp)) {
        Text(approval.agentTitle ?: stringResource(R.string.compute_request_agent), style = ItemSpec.title, color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(
            approval.computerName?.let { stringResource(R.string.compute_request_line, it, ago) } ?: stringResource(R.string.compute_request_line_unnamed, ago),
            style = subtitle, color = colors.textSecondary,
        )
        Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RowAction(stringResource(R.string.compute_deny), colors.textSecondary, Modifier.testTag(ComputeTags.deny(approval.key)), loading = answering == false, enabled = answering == null) { onAnswer(approval, false) }
            RowAction(stringResource(R.string.compute_approve), colors.textLink, Modifier.testTag(ComputeTags.approve(approval.key)), loading = answering == true, enabled = answering == null) { onAnswer(approval, true) }
        }
    }
}

/** Removals and a concurrency change sent and not settled yet. */
data class ComputerPending(val removals: Set<String> = emptySet(), val saving: Boolean = false)

class ComputerActions(
    val onRetry: () -> Unit = {},
    val onRemove: (ComputeAgent) -> Unit = {},
    val onSave: (Int) -> Unit = {},
)

@Composable
private fun CloudComputerPage(graph: AppGraph, connectionId: String, computerId: String, onBack: () -> Unit) {
    val (role, source) = rememberCompute(graph, connectionId)
    if (source == null) {
        ComputerScreen(ComputeSource.State.Loading, computerId, ComputeRole.None, ComputerPending(), null, ComputerActions(), onBack)
        return
    }
    val state by source.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var pending by remember(source) { mutableStateOf(ComputerPending()) }
    var failure by remember(source) { mutableStateOf<ComputeFailure?>(null) }
    var removing by remember(source) { mutableStateOf<ComputeAgent?>(null) }
    val computer = ((state as? ComputeSource.State.Loaded)?.snapshot?.computers)?.firstOrNull { it.id == computerId }
    ComputerScreen(
        state, computerId, role, pending, failure,
        ComputerActions(
            onRetry = { scope.launch { source.refresh() } },
            onRemove = { removing = it },
            onSave = { concurrency ->
                if (computer != null && !pending.saving) {
                    pending = pending.copy(saving = true)
                    failure = null
                    scope.launch {
                        try {
                            source.setConcurrency(computer, concurrency)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            failure = ComputeFailure(said(e))
                        } finally {
                            pending = pending.copy(saving = false)
                        }
                    }
                }
            },
        ),
        onBack,
    )
    removing?.let { agent ->
        HappyAlert(Alert(
            title = stringResource(R.string.compute_remove_confirm, agent.title ?: stringResource(R.string.compute_request_agent)),
            message = stringResource(R.string.compute_remove_message),
            buttons = listOf(
                AlertButton(stringResource(R.string.common_cancel)),
                AlertButton(stringResource(R.string.compute_remove), destructive = true) {
                    removing = null
                    if (computer != null && agent.id !in pending.removals) {
                        pending = pending.copy(removals = pending.removals + agent.id)
                        failure = null
                        scope.launch {
                            try {
                                source.removeAgent(computer, agent)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                failure = ComputeFailure(said(e))
                            } finally {
                                pending = pending.copy(removals = pending.removals - agent.id)
                            }
                        }
                    }
                },
            ),
        ), onDismiss = { removing = null })
    }
}

/**
 * One computer, opened from Settings › Compute: its card as the list shows
 * it; where restricted commands can't run, why, and that only full-access
 * commands run there; the agents on it, each with Remove for a manager or
 * the private owner; then how many agents it takes at once, which they may
 * change (1 to its limit, Save once changed).
 */
@Composable
internal fun ComputerScreen(
    state: ComputeSource.State,
    computerId: String,
    role: ComputeRole,
    pending: ComputerPending,
    failure: ComputeFailure?,
    actions: ComputerActions,
    onBack: () -> Unit,
) {
    val computer = (state as? ComputeSource.State.Loaded)?.snapshot?.computers?.firstOrNull { it.id == computerId }
    Screen(header = { StackHeader(computer?.name ?: stringResource(R.string.compute_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(ComputeTags.LIST)) {
            if (role == ComputeRole.None) {
                ItemGroup { Item(stringResource(R.string.compute_permission), titleLines = 0, showChevron = false) }
                return@ItemList
            }
            when {
                state == ComputeSource.State.Loading -> ItemGroup { Item(stringResource(R.string.compute_title), loading = true, showChevron = false) }
                state == ComputeSource.State.Failed -> FailedGroup(actions.onRetry)
                computer == null -> ItemGroup { Item(stringResource(R.string.compute_gone), titleLines = 0, showChevron = false) }
                else -> ComputerGroups(computer, role, pending, failure, actions)
            }
        }
    }
}

@Composable
private fun ComputerGroups(computer: Computer, role: ComputeRole, pending: ComputerPending, failure: ComputeFailure?, actions: ComputerActions) {
    val colors = HappyTheme.colors
    val manageable = computer.manageable(role)
    failure?.let { FailureGroup(it) }
    ItemGroup { ComputerSummary(computer, Modifier.testTag(ComputeTags.computer(computer.id))) }
    if (!computer.boundary.available) {
        val footer = listOfNotNull(computer.boundary.reason, stringResource(R.string.compute_boundary_footer)).joinToString(" ")
        ItemGroup(footer = footer, modifier = Modifier.testTag(ComputeTags.BOUNDARY)) {
            Item(
                stringResource(R.string.compute_boundary_title),
                titleLines = 0,
                icon = { Icon(Ionicon.WarningOutline, 24.dp, colors.boxWarning.border) },
                showChevron = false,
            )
        }
    }
    ItemGroup(title = agentsCount(computer), modifier = Modifier.testTag(ComputeTags.AGENTS)) {
        if (computer.agents.isEmpty()) Item(stringResource(R.string.compute_no_agents), titleColor = colors.textSecondary, showChevron = false)
        for (agent in computer.agents) key(agent.id) {
            Item(
                agent.title ?: stringResource(R.string.compute_request_agent),
                showChevron = false,
                modifier = Modifier.testTag(ComputeTags.agent(agent.id)),
                rightElement = if (manageable) ({
                    RowAction(
                        stringResource(R.string.compute_remove), colors.textDestructive,
                        Modifier.testTag(ComputeTags.remove(agent.id)), loading = agent.id in pending.removals,
                    ) { actions.onRemove(agent) }
                }) else null,
            )
        }
    }
    var concurrency by remember(computer.concurrency) { mutableIntStateOf(computer.concurrency) }
    val limit = computer.concurrencyLimit
    ItemGroup(footer = stringResource(R.string.compute_concurrency_footer, limit)) {
        if (manageable) {
            ConcurrencyRow(concurrency, limit, enabled = !pending.saving) { concurrency = it }
            if (concurrency != computer.concurrency) {
                Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    RoundButton(stringResource(R.string.common_save), onClick = { actions.onSave(concurrency) }, loading = pending.saving, modifier = Modifier.testTag(ComputeTags.SAVE))
                }
            }
        } else {
            Item(stringResource(R.string.compute_concurrency_title), detail = computer.concurrency.toString(), showChevron = false, modifier = Modifier.testTag(ComputeTags.CONCURRENCY))
        }
    }
}

/** "Agents at once" with − value +, each a 48 target, held to 1…[limit]. */
@Composable
private fun ConcurrencyRow(value: Int, limit: Int, enabled: Boolean, onChange: (Int) -> Unit) {
    val colors = HappyTheme.colors
    Item(
        stringResource(R.string.compute_concurrency_title),
        showChevron = false,
        modifier = Modifier.testTag(ComputeTags.CONCURRENCY),
        rightElement = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StepButton(Ionicon.Remove, stringResource(R.string.compute_concurrency_fewer), enabled && value > ComputeConcurrency.MIN, Modifier.testTag(ComputeTags.FEWER)) { onChange(value - 1) }
                Text(
                    value.toString(),
                    style = ItemSpec.detail,
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.widthIn(min = 32.dp),
                )
                StepButton(Ionicon.Add, stringResource(R.string.compute_concurrency_more), enabled && value < limit, Modifier.testTag(ComputeTags.MORE)) { onChange(value + 1) }
            }
        },
    )
}

@Composable
private fun StepButton(icon: Ionicon, label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val color = HappyTheme.colors.textLink
    Box(
        modifier
            .size(48.dp)
            .clip(RoundedCornerShape(24.dp))
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, 22.dp, color.copy(alpha = if (enabled) 1f else 0.4f))
    }
}

/**
 * Adding a computer (desktop's HappyAgentComputeMachineAddDialog): shared
 * (the team) or private (the reader alone), each in a sentence, shared
 * dimmed for a member; how many agents at once, the access's default until
 * changed; then the one-time install, its commands for the systems with a
 * published build, each with Copy, and what isn't available yet.
 */
@Composable
internal fun ComputerAddScreen(
    add: ComputerAdd,
    role: ComputeRole,
    onChange: ((ComputeDraft) -> ComputeDraft) -> Unit,
    onCreate: () -> Unit,
    onClose: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.compute_add_title), onClose) }) {
        ItemList {
            when (add) {
                is ComputerAdd.Shown -> InstallGroups(add.install, onClose)
                else -> {
                    val draft = requireNotNull(add.form)
                    val busy = add is ComputerAdd.Creating
                    if (add is ComputerAdd.Failed) {
                        ItemGroup(footer = add.reason ?: stringResource(R.string.cloud_failed), modifier = Modifier.testTag(ComputeTags.FAILURE)) {
                            Item(stringResource(R.string.compute_create_failed), titleColor = HappyTheme.colors.textDestructive, showChevron = false)
                        }
                    }
                    ItemGroup(
                        title = stringResource(R.string.compute_access_title),
                        footer = if (role == ComputeRole.Manage) null else stringResource(R.string.compute_access_member_footer),
                    ) {
                        for (access in ComputeAccess.entries) {
                            val allowed = role == ComputeRole.Manage || access == ComputeAccess.Private
                            Item(
                                accessLabel(access),
                                subtitle = accessAbout(access),
                                subtitleLines = 3,
                                enabled = allowed && !busy,
                                onClick = { onChange { it.copy(access = access) } },
                                rightElement = { if (draft.access == access) Icon(Ionicon.Checkmark, 22.dp, HappyTheme.colors.textLink) else Spacer(Modifier.size(22.dp)) },
                                modifier = Modifier.testTag(ComputeTags.access(access)),
                            )
                        }
                    }
                    ItemGroup(footer = stringResource(R.string.compute_concurrency_footer, ComputeConcurrency.MAX)) {
                        ConcurrencyRow(draft.agents, ComputeConcurrency.MAX, enabled = !busy) { value -> onChange { it.copy(concurrency = value) } }
                    }
                    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        RoundButton(stringResource(R.string.compute_create), onClick = onCreate, loading = busy, modifier = Modifier.testTag(ComputeTags.CREATE))
                    }
                }
            }
        }
    }
}

@Composable
private fun InstallGroups(install: ComputeInstall, onDone: () -> Unit) {
    var expired by remember(install) { mutableStateOf(System.currentTimeMillis() >= install.expiresAt) }
    LaunchedEffect(install) {
        delay((install.expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
        expired = true
    }
    val expires = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(install.expiresAt))
    val note = listOfNotNull(stringResource(installNote(install.access)), stringResource(R.string.compute_command_note), install.notice).joinToString(" ")
    ItemGroup(footer = note) {
        Item(stringResource(if (expired) R.string.compute_expired else R.string.compute_expires, expires), titleLines = 0, showChevron = false)
    }
    if (!expired) {
        val commands = install.commands
        val systems = install.systems
        val unix = ComputeSystem.Linux in systems || ComputeSystem.MacOS in systems
        if (commands == null || (!unix && ComputeSystem.Windows !in systems)) {
            CommandGroup(stringResource(R.string.compute_server), "server", install.clusterUrl)
            CommandGroup(stringResource(R.string.compute_join_token), "token", install.token)
        } else {
            if (unix) CommandGroup(stringResource(unixLabel(systems)), "unix", commands.unix)
            if (ComputeSystem.Windows in systems) CommandGroup(stringResource(R.string.compute_command_windows), "windows", commands.windows)
        }
    }
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        RoundButton(stringResource(R.string.compute_done), onClick = onDone)
    }
}

private fun unixLabel(systems: Set<ComputeSystem>): Int = when {
    ComputeSystem.Linux !in systems -> R.string.compute_command_macos
    ComputeSystem.MacOS in systems -> R.string.compute_command_unix
    else -> R.string.compute_command_linux
}

private fun installNote(access: ComputeAccess): Int = when (access) {
    ComputeAccess.Shared -> R.string.compute_install_shared
    ComputeAccess.Private -> R.string.compute_install_private
}

/** One command, verbatim, and its Copy, which marks the clip sensitive and says Copied for a moment. */
@Composable
private fun CommandGroup(label: String, system: String, text: String) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember(text) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }
    ItemGroup(title = label) {
        Text(
            text,
            style = happyTextStyle(fontSize = 13, lineHeight = 18).copy(fontFamily = FontFamily.Monospace),
            color = HappyTheme.colors.text,
            modifier = Modifier.fillMaxWidth().padding(16.dp).testTag(ComputeTags.command(system)),
        )
        Item(
            stringResource(if (copied) R.string.common_copied else R.string.common_copy),
            titleColor = HappyTheme.colors.textLink,
            icon = { Icon(if (copied) Ionicon.Checkmark else Ionicon.CopyOutline, 22.dp, HappyTheme.colors.textLink) },
            showChevron = false,
            onClick = {
                scope.launch {
                    val clip = ClipData.newPlainText(label, text)
                    clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
                    clipboard.setClipEntry(ClipEntry(clip))
                    copied = true
                }
            },
        )
    }
}
