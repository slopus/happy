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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
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
import com.slopus.happy.agent.ComputeApproval
import com.slopus.happy.agent.ComputeDraft
import com.slopus.happy.agent.ComputeInstall
import com.slopus.happy.agent.ComputeMachine
import com.slopus.happy.agent.ComputeMode
import com.slopus.happy.agent.ComputeModeKind
import com.slopus.happy.agent.ComputeOwner
import com.slopus.happy.agent.ComputeSource
import com.slopus.happy.agent.ComputeStatus
import com.slopus.happy.agent.ComputeSystem
import com.slopus.happy.agent.MachineAdd
import com.slopus.happy.agent.MachineEdit
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

object ComputeTags {
    const val ROW = "compute.row"
    const val LIST = "compute.list"
    const val ADD = "compute.add"
    const val CREATE = "compute.create"
    const val NAME = "compute.name"
    const val DESCRIPTION = "compute.description"
    const val SAVE = "compute.save"
    const val FAILURE = "compute.failure"
    fun machine(id: String) = "compute.machine.$id"
    fun edit(id: String) = "compute.edit.$id"
    fun release(id: String) = "compute.release.$id"
    fun request(key: String) = "compute.request.$key"
    fun approve(key: String) = "compute.approve.$key"
    fun deny(key: String) = "compute.deny.$key"
    fun mode(mode: ComputeModeKind) = "compute.mode.${mode.wire}"
    fun command(system: String) = "compute.command.$system"
}

internal fun NavGraphBuilder.cloudComputeRoutes(graph: AppGraph, nav: NavHostController) {
    page<CloudComputeRoute> { entry ->
        CloudComputePage(graph, entry.toRoute<CloudComputeRoute>().connectionId) { nav.popBackStack() }
    }
}

/** Answers and releases sent and not settled yet. */
data class ComputePending(val answers: Map<String, Boolean> = emptyMap(), val releases: Set<String> = emptySet())

/** Why the last answer or release didn't go through: the server's words, or null when it gave none. */
data class ComputeFailure(val reason: String?)

class ComputeActions(
    val onRetry: () -> Unit = {},
    val onAdd: () -> Unit = {},
    val onEdit: (ComputeMachine) -> Unit = {},
    val onRelease: (ComputeMachine) -> Unit = {},
    val onAnswer: (ComputeApproval, Boolean) -> Unit = { _, _ -> },
)

private fun said(e: Exception): String? = (e as? AgentApiException)?.message?.takeIf { it.isNotBlank() }

@Composable
private fun CloudComputePage(graph: AppGraph, connectionId: String, onBack: () -> Unit) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val permissions = session?.permissions?.collectAsStateWithLifecycle()?.value ?: ServerPermissions.Unknown
    val access = ComputeAccess.of(session?.client?.cloud == true, permissions)
    if (session == null || access == ComputeAccess.None) {
        ComputeScreen(ComputeSource.State.Loading, ComputeAccess.None, ComputePending(), null, ComputeActions(), onBack)
        return
    }
    val readerId = graph.agentConnections.accounts.collectAsStateWithLifecycle().value.firstOrNull { it.id == connectionId }?.userId
    val source = remember(session, readerId) { ComputeSource(session.client, readerId) { ids -> session.team.names(ids) } }
    val state by source.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(source, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { source.observe(session.events) }
    }
    val scope = rememberCoroutineScope()
    var add by remember(source) { mutableStateOf<MachineAdd?>(null) }
    var edit by remember(source) { mutableStateOf<MachineEdit?>(null) }
    var pending by remember(source) { mutableStateOf(ComputePending()) }
    var failure by remember(source) { mutableStateOf<ComputeFailure?>(null) }
    var releasing by remember(source) { mutableStateOf<ComputeMachine?>(null) }
    val machines = (state as? ComputeSource.State.Loaded)?.snapshot?.machines.orEmpty()
    val noCommand = stringResource(R.string.compute_no_command)
    ComputeScreen(
        state, access, pending, failure,
        ComputeActions(
            onRetry = { scope.launch { source.refresh() } },
            onAdd = { add = MachineAdd.open(access) },
            onEdit = { edit = MachineEdit.open(it) },
            onRelease = { releasing = it },
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
    releasing?.let { machine ->
        val release = stringResource(R.string.compute_release)
        HappyAlert(Alert(
            title = stringResource(R.string.compute_release_confirm, machine.name),
            message = stringResource(R.string.compute_release_message),
            buttons = listOf(
                AlertButton(stringResource(R.string.common_cancel)),
                AlertButton(release, destructive = true) {
                    releasing = null
                    if (machine.id !in pending.releases) {
                        pending = pending.copy(releases = pending.releases + machine.id)
                        failure = null
                        scope.launch {
                            try {
                                source.releaseLock(machine)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                failure = ComputeFailure(said(e))
                            } finally {
                                pending = pending.copy(releases = pending.releases - machine.id)
                            }
                        }
                    }
                },
            ),
        ), onDismiss = { releasing = null })
    }
    add?.let { current ->
        // The install carries a single-use secret: kept off screenshots and the recents thumbnail.
        PageDialog(
            onDismissRequest = { if (current.closable) add = null },
            properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, securePolicy = SecureFlagPolicy.SecureOn),
        ) {
            MachineAddScreen(
                add = current,
                access = access,
                onChange = { change -> add = add?.edit(access, change) },
                onCreate = {
                    val creating = add?.create()
                    if (creating != null) {
                        add = creating
                        scope.launch {
                            add = try {
                                source.create(creating.draft)?.let { MachineAdd.Shown(it) } ?: MachineAdd.Failed(creating.draft, noCommand)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                MachineAdd.Failed(creating.draft, said(e))
                            }
                        }
                    }
                },
                onClose = { if (add?.closable != false) add = null },
            )
        }
    }
    edit?.let { current ->
        PageDialog(
            onDismissRequest = { if (current.phase != MachineEdit.Phase.Saving) edit = null },
            properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) {
            MachineEditScreen(
                edit = current,
                onChange = { change -> edit = edit?.let { if (it.phase == MachineEdit.Phase.Saving) it else change(it).copy(phase = MachineEdit.Phase.Editing) } },
                onSave = save@{
                    val draft = edit ?: return@save
                    val machine = machines.firstOrNull { it.id == draft.machineId } ?: return@save
                    if (!draft.savable) return@save
                    val patch = draft.patch(machine)
                    if (patch == null) {
                        edit = null
                        return@save
                    }
                    edit = draft.copy(phase = MachineEdit.Phase.Saving)
                    scope.launch {
                        edit = try {
                            source.edit(draft.machineId, patch)
                            null
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            draft.copy(phase = MachineEdit.Phase.Failed(said(e)))
                        }
                    }
                },
                onClose = { if (edit?.phase != MachineEdit.Phase.Saving) edit = null },
            )
        }
    }
}

/**
 * Settings › Compute on a Happy Cloud server (desktop's
 * HappyAgentComputeSettings): the requests to join the reader's private
 * machines, then every machine agents can join, one flat list, online first.
 * A row is the name and its status, the mode and whose it is, where it runs,
 * what agents read about it, who holds it, then Edit and Release where the
 * reader may. A manager adds a machine in any mode; a member a private one.
 */
@Composable
internal fun ComputeScreen(
    state: ComputeSource.State,
    access: ComputeAccess,
    pending: ComputePending,
    failure: ComputeFailure?,
    actions: ComputeActions,
    onBack: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.compute_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(ComputeTags.LIST)) {
            if (access == ComputeAccess.None) {
                ItemGroup { Item(stringResource(R.string.compute_permission), titleLines = 0, showChevron = false) }
                return@ItemList
            }
            when (state) {
                ComputeSource.State.Loading -> ItemGroup { Item(stringResource(R.string.compute_title), loading = true, showChevron = false) }
                ComputeSource.State.Failed -> ItemGroup {
                    Item(stringResource(R.string.cloud_failed), subtitle = stringResource(R.string.team_server_try_again), onClick = actions.onRetry, showChevron = false)
                }
                is ComputeSource.State.Loaded -> {
                    val (machines, approvals) = state.snapshot
                    failure?.let {
                        ItemGroup(footer = it.reason ?: stringResource(R.string.cloud_failed), modifier = Modifier.testTag(ComputeTags.FAILURE)) {
                            Item(stringResource(R.string.compute_action_failed), titleColor = HappyTheme.colors.textDestructive, showChevron = false)
                        }
                    }
                    if (approvals.isNotEmpty()) {
                        ItemGroup(title = stringResource(R.string.compute_requests_title), footer = stringResource(R.string.compute_requests_footer)) {
                            for (approval in approvals) key(approval.key) { ApprovalRow(approval, pending.answers[approval.key], actions.onAnswer) }
                        }
                    }
                    if (machines.isEmpty() && approvals.isEmpty()) {
                        ItemGroup(footer = stringResource(if (access == ComputeAccess.Manage) R.string.compute_empty_manage else R.string.compute_empty_use)) {
                            Item(stringResource(R.string.compute_empty_title), showChevron = false)
                            AddRow(actions.onAdd)
                        }
                    } else {
                        ItemGroup(
                            title = stringResource(R.string.compute_machines_title),
                            footer = stringResource(if (access == ComputeAccess.Manage) R.string.compute_machines_footer_manage else R.string.compute_machines_footer_use),
                        ) {
                            if (machines.isEmpty()) Item(stringResource(R.string.compute_no_machines), titleColor = HappyTheme.colors.textSecondary, showChevron = false)
                            for (machine in machines) key(machine.id) {
                                MachineRow(machine, access, machine.id in pending.releases, actions)
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

@Composable
private fun MachineRow(machine: ComputeMachine, access: ComputeAccess, releasing: Boolean, actions: ComputeActions) {
    val colors = HappyTheme.colors
    val resources = LocalContext.current.resources
    val detail = listOfNotNull(
        machine.hostname?.takeIf { it != machine.name },
        listOfNotNull(machine.os?.let { OS_NAMES[it] ?: it }, machine.arch).joinToString(" ").ifEmpty { null },
        machine.since?.takeIf { machine.status != ComputeStatus.Online }?.let { formatLastSeen(resources, it, System.currentTimeMillis()) },
    ).joinToString(" · ")
    Column(Modifier.fillMaxWidth().testTag(ComputeTags.machine(machine.id)).padding(horizontal = ItemSpec.paddingHorizontal, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(machine.name, style = ItemSpec.title, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(ItemSpec.rightSectionGap))
            MachineStatus(machine)
        }
        FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Badge(modeLabel(machine.mode.kind), colors.textSecondary)
            ownerLabel(machine.mode)?.let { (label, yours) -> Badge(label, if (yours) colors.textLink else colors.textSecondary) }
        }
        if (detail.isNotEmpty()) Text(detail, style = subtitle, color = colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
        machine.description?.let { Text(it, style = subtitle, color = colors.text, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp)) }
        machine.holder?.let { holder ->
            Text(
                holder.title?.let { stringResource(R.string.compute_held_by, it) } ?: stringResource(R.string.compute_held_by_agent),
                style = subtitle, color = colors.textSecondary, modifier = Modifier.padding(top = 4.dp),
            )
        }
        machine.sandboxError?.let { Text(stringResource(R.string.compute_sandbox_failed, it), style = subtitle, color = colors.textDestructive, modifier = Modifier.padding(top = 4.dp)) }
        val editable = machine.editable(access)
        val releasable = machine.releasable(access)
        if (editable || releasable) {
            // Pulled out by the buttons' own inset, so their words start on the text's keyline.
            Row(Modifier.padding(top = 4.dp).offset(x = (-8).dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (editable) RowAction(stringResource(R.string.compute_edit), colors.textLink, Modifier.testTag(ComputeTags.edit(machine.id))) { actions.onEdit(machine) }
                if (releasable) RowAction(stringResource(R.string.compute_release), colors.textDestructive, Modifier.testTag(ComputeTags.release(machine.id)), loading = releasing) { actions.onRelease(machine) }
            }
        }
    }
}

private val OS_NAMES = mapOf("macos" to "macOS", "linux" to "Linux", "windows" to "Windows")

@Composable
private fun MachineStatus(machine: ComputeMachine) {
    val colors = HappyTheme.colors
    val (label, color) = when {
        machine.busy -> stringResource(R.string.compute_status_busy) to colors.boxWarning.border
        else -> when (machine.status) {
            ComputeStatus.Online -> stringResource(R.string.compute_status_online) to colors.status.connected
            ComputeStatus.Offline -> stringResource(R.string.compute_status_offline) to colors.status.disconnected
            ComputeStatus.Draining -> stringResource(R.string.compute_status_draining) to colors.status.connecting
            ComputeStatus.Enrolling -> stringResource(R.string.compute_status_joining) to colors.status.connecting
        }
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
internal fun modeLabel(mode: ComputeModeKind): String = stringResource(when (mode) {
    ComputeModeKind.Sandbox -> R.string.compute_mode_sandbox
    ComputeModeKind.Shared -> R.string.compute_mode_shared
    ComputeModeKind.Exclusive -> R.string.compute_mode_exclusive
    ComputeModeKind.Private -> R.string.compute_mode_private
})

@Composable
private fun modeAbout(mode: ComputeModeKind): String = stringResource(when (mode) {
    ComputeModeKind.Sandbox -> R.string.compute_mode_sandbox_about
    ComputeModeKind.Shared -> R.string.compute_mode_shared_about
    ComputeModeKind.Exclusive -> R.string.compute_mode_exclusive_about
    ComputeModeKind.Private -> R.string.compute_mode_private_about
})

/** Whose a private machine is, and whether it is the reader's; null for the other modes and an unknown owner. */
@Composable
private fun ownerLabel(mode: ComputeMode): Pair<String, Boolean>? = when (val owner = (mode as? ComputeMode.Private)?.owner) {
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
            approval.machineName?.let { stringResource(R.string.compute_request_line, it, ago) } ?: stringResource(R.string.compute_request_line_unnamed, ago),
            style = subtitle, color = colors.textSecondary,
        )
        Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RowAction(stringResource(R.string.compute_deny), colors.textSecondary, Modifier.testTag(ComputeTags.deny(approval.key)), loading = answering == false, enabled = answering == null) { onAnswer(approval, false) }
            RowAction(stringResource(R.string.compute_approve), colors.textLink, Modifier.testTag(ComputeTags.approve(approval.key)), loading = answering == true, enabled = answering == null) { onAnswer(approval, true) }
        }
    }
}

/** A settings row that is a text field, as Profile's name is; [placeholder] while empty. */
@Composable
private fun ComputeField(value: String, onChange: (String) -> Unit, placeholder: String, enabled: Boolean, tag: String, lines: Int = 1) {
    val colors = HappyTheme.colors
    BasicTextField(
        value = value,
        onValueChange = onChange,
        enabled = enabled,
        singleLine = lines == 1,
        minLines = lines,
        textStyle = ItemSpec.title.copy(color = colors.text),
        cursorBrush = SolidColor(colors.textLink),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Sentences,
            imeAction = if (lines == 1) ImeAction.Next else ImeAction.Default,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = ItemSpec.minHeight)
            .testTag(tag)
            .padding(horizontal = ItemSpec.paddingHorizontal, vertical = ItemSpec.paddingVertical),
        decorationBox = { field ->
            Box {
                if (value.isEmpty()) Text(placeholder, style = ItemSpec.title, color = colors.textSecondary)
                field()
            }
        },
    )
}

/**
 * Adding a machine (desktop's HappyAgentComputeMachineAddDialog): the four
 * modes, each in a sentence, a member's three other modes dimmed; the
 * optional name and description; then the one-time install, its commands
 * for the systems that mode runs on, each with Copy.
 */
@Composable
internal fun MachineAddScreen(
    add: MachineAdd,
    access: ComputeAccess,
    onChange: ((ComputeDraft) -> ComputeDraft) -> Unit,
    onCreate: () -> Unit,
    onClose: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.compute_add_title), onClose) }) {
        ItemList {
            when (add) {
                is MachineAdd.Shown -> InstallGroups(add.install, onClose)
                else -> {
                    val draft = requireNotNull(add.form)
                    val busy = add is MachineAdd.Creating
                    if (add is MachineAdd.Failed) {
                        ItemGroup(footer = add.reason ?: stringResource(R.string.cloud_failed), modifier = Modifier.testTag(ComputeTags.FAILURE)) {
                            Item(stringResource(R.string.compute_create_failed), titleColor = HappyTheme.colors.textDestructive, showChevron = false)
                        }
                    }
                    ItemGroup(
                        title = stringResource(R.string.compute_mode_title),
                        footer = if (access == ComputeAccess.Manage) null else stringResource(R.string.compute_mode_member_footer),
                    ) {
                        for (mode in ComputeModeKind.entries) {
                            val allowed = access == ComputeAccess.Manage || mode == ComputeModeKind.Private
                            Item(
                                modeLabel(mode),
                                subtitle = modeAbout(mode),
                                subtitleLines = 3,
                                enabled = allowed && !busy,
                                onClick = { onChange { it.copy(mode = mode) } },
                                rightElement = { if (draft.mode == mode) Icon(Ionicon.Checkmark, 22.dp, HappyTheme.colors.textLink) else Spacer(Modifier.size(22.dp)) },
                                modifier = Modifier.testTag(ComputeTags.mode(mode)),
                            )
                        }
                    }
                    ItemGroup(title = stringResource(R.string.compute_name), footer = stringResource(R.string.compute_name_hint)) {
                        ComputeField(draft.name, { name -> onChange { it.copy(name = name) } }, stringResource(R.string.compute_name_placeholder), !busy, ComputeTags.NAME)
                    }
                    ItemGroup(title = stringResource(R.string.compute_description), footer = stringResource(R.string.compute_description_hint)) {
                        ComputeField(draft.description, { text -> onChange { it.copy(description = text) } }, stringResource(R.string.compute_description_placeholder), !busy, ComputeTags.DESCRIPTION, lines = 3)
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
    ItemGroup(footer = stringResource(installNote(install.mode)) + " " + stringResource(R.string.compute_command_note)) {
        Item(stringResource(if (expired) R.string.compute_expired else R.string.compute_expires, expires), titleLines = 0, showChevron = false)
    }
    if (!expired) {
        val commands = install.commands
        if (commands == null) {
            CommandGroup(stringResource(R.string.compute_server), "server", install.clusterUrl)
            CommandGroup(stringResource(R.string.compute_join_token), "token", install.token)
        } else {
            val systems = install.mode.systems
            CommandGroup(
                stringResource(if (ComputeSystem.MacOS in systems) R.string.compute_command_unix else R.string.compute_command_linux),
                "unix", commands.unix,
            )
            if (ComputeSystem.Windows in systems) CommandGroup(stringResource(R.string.compute_command_windows), "windows", commands.windows)
        }
    }
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        RoundButton(stringResource(R.string.compute_done), onClick = onDone)
    }
}

private fun installNote(mode: ComputeModeKind): Int = when (mode) {
    ComputeModeKind.Sandbox -> R.string.compute_install_sandbox
    ComputeModeKind.Shared -> R.string.compute_install_shared
    ComputeModeKind.Exclusive -> R.string.compute_install_exclusive
    ComputeModeKind.Private -> R.string.compute_install_private
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

/** Renaming a machine and changing what agents read about it (desktop's HappyAgentComputeMachineEditDialog). */
@Composable
internal fun MachineEditScreen(
    edit: MachineEdit,
    onChange: ((MachineEdit) -> MachineEdit) -> Unit,
    onSave: () -> Unit,
    onClose: () -> Unit,
) {
    val saving = edit.phase == MachineEdit.Phase.Saving
    Screen(header = { StackHeader(stringResource(R.string.compute_edit_title), onClose) }) {
        ItemList {
            (edit.phase as? MachineEdit.Phase.Failed)?.let { failed ->
                ItemGroup(footer = failed.reason ?: stringResource(R.string.cloud_failed), modifier = Modifier.testTag(ComputeTags.FAILURE)) {
                    Item(stringResource(R.string.compute_not_saved), titleColor = HappyTheme.colors.textDestructive, showChevron = false)
                }
            }
            ItemGroup(title = stringResource(R.string.compute_name)) {
                ComputeField(edit.name, { name -> onChange { it.copy(name = name) } }, stringResource(R.string.compute_name_placeholder), !saving, ComputeTags.NAME)
            }
            ItemGroup(title = stringResource(R.string.compute_description), footer = stringResource(R.string.compute_edit_description_hint)) {
                ComputeField(edit.description, { text -> onChange { it.copy(description = text) } }, stringResource(R.string.compute_description_placeholder), !saving, ComputeTags.DESCRIPTION, lines = 4)
            }
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                RoundButton(stringResource(R.string.common_save), onClick = onSave, enabled = edit.savable, loading = saving, modifier = Modifier.testTag(ComputeTags.SAVE))
            }
        }
    }
}
