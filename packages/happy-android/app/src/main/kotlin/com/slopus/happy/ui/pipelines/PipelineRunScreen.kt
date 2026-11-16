package com.slopus.happy.ui.pipelines

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import com.slopus.happy.R
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.pipelines.PipelineAbort
import com.slopus.happy.pipelines.PipelineLease
import com.slopus.happy.pipelines.PipelineModelUsage
import com.slopus.happy.pipelines.PipelineNodeState
import com.slopus.happy.pipelines.PipelineRun
import com.slopus.happy.pipelines.PipelineRunRelative
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineRunView
import com.slopus.happy.pipelines.pipelineNodeOrder
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

object PipelineRunTags {
    const val LIST = "pipelines.runPage.list"
    const val RETRY = "pipelines.runPage.retry"
    const val SUMMARY = "pipelines.runPage.summary"
    const val DURATION = "pipelines.runPage.duration"
    const val ABORT = "pipelines.runPage.abort"
    const val NODES = "pipelines.runPage.nodes"
    const val INPUT = "pipelines.runPage.input"
    const val RESULT = "pipelines.runPage.result"
    fun node(id: String) = "pipelines.runPage.node.$id"
    fun nodeState(id: String) = "pipelines.runPage.node.$id.state"
    fun nodeDuration(id: String) = "pipelines.runPage.node.$id.duration"
    fun failure(nodeId: String) = "pipelines.runPage.failure.$nodeId"
    fun relative(runId: String) = "pipelines.runPage.relative.$runId"
}

/** The run and node pages' own sizes, on [Item]'s metrics. */
object PipelineRunSpec {
    /** A skipped node, or one the run never reached, reads at this. */
    const val DIM = 0.45f
    /** JSON, output and commands: 13/18 monospace, as a tool call's blocks. */
    val mono = happyTextStyle(fontSize = 13, lineHeight = 18, family = FontFamily.Monospace)
    /** A value longer than this shows its start; a node's output may be a MiB. */
    const val VALUE_LIMIT = 64 * 1024
}

/** A moment as the pipeline pages give it: the time today, else the day and time. */
@Composable
internal fun pipelineTime(at: Long): String {
    val context = LocalContext.current
    return remember(at) {
        val flags = if (DateUtils.isToday(at)) DateUtils.FORMAT_SHOW_TIME else DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH or DateUtils.FORMAT_SHOW_TIME
        DateUtils.formatDateTime(context, at, flags)
    }
}

/**
 * One run of a pipeline, live (desktop's run page, read only): its state
 * and who started it, Abort while it is queued or running (confirmed
 * first; it reads aborted only once the server says so), why it failed in
 * words, the run that started it, its nodes in graph order, the child
 * runs its nodes made, what its agent nodes spent, the computers it held,
 * its input and its result. A node opens its log ([onOpenNode]); a parent
 * or child run opens its own page ([onOpenRun]).
 *
 * Rows are [Item]s; a node's row (16 in, its state glyph in the 32 slot, 12,
 * its ID 16/24 over what it is doing or what kind of step it is 14/20, its
 * state's word and how long it took on the right) and a relative's are
 * [PipelineRow]s of the same metrics. A skipped node, or one the run never
 * reached, reads at [PipelineRunSpec.DIM].
 */
@Composable
fun PipelineRunScreen(
    state: PipelineRunView,
    agents: AgentNames,
    onRetry: () -> Unit,
    onAbort: () -> Unit,
    onBack: () -> Unit,
    onOpenNode: (nodeId: String) -> Unit,
    onOpenRun: (runId: String) -> Unit,
    now: Long = rememberNow(state.live),
) {
    val colors = HappyTheme.colors
    val run = state.run
    var alert by remember { mutableStateOf<Alert?>(null) }
    val scope = rememberCoroutineScope()
    val abortTitle = stringResource(R.string.pipelines_run_abort_title)
    val abortMessage = stringResource(R.string.pipelines_run_abort_message)
    val abortConfirm = stringResource(R.string.pipelines_run_abort_confirm)
    val abortCancel = stringResource(R.string.pipelines_run_abort_cancel)
    val title = state.pipelineName ?: run?.pipelineId ?: stringResource(R.string.pipelines_run_title)
    Screen(header = { StackHeader(title, onBack) }) {
        ItemList(modifier = Modifier.testTag(PipelineRunTags.LIST)) {
            when {
                run == null && state.loading -> ItemGroup { Item(title = stringResource(R.string.pipelines_run_loading), loading = true, showChevron = false) }
                run == null && state.missing -> ItemGroup(footer = stringResource(R.string.pipelines_run_missing_footer)) {
                    Item(title = stringResource(R.string.pipelines_run_missing), titleColor = colors.textSecondary, showChevron = false)
                }
                run == null -> ItemGroup {
                    Item(
                        title = stringResource(R.string.pipelines_run_failed),
                        subtitle = stringResource(R.string.pipelines_tap_to_retry),
                        onClick = onRetry,
                        showChevron = false,
                        modifier = Modifier.testTag(PipelineRunTags.RETRY),
                    )
                }
                else -> {
                    Summary(state, run, agents, now) {
                        scope.launch { if (confirm({ alert = it }, abortTitle, abortMessage, abortConfirm, abortCancel, destructive = true)) onAbort() }
                    }
                    // Why it failed is what a failed run is opened for: right under its state.
                    Failures(run, onOpenNode)
                    run.entry.parentRunId?.let { parent ->
                        val trigger = run.entry.trigger as? PipelineRunTrigger.Pipeline
                        ItemGroup(title = stringResource(R.string.pipelines_run_parent)) {
                            RelativeRow(
                                parent, state.relatives[parent], now,
                                trigger?.let { stringResource(R.string.pipelines_run_parent_via, it.nodeId) },
                                onOpenRun,
                            )
                        }
                    }
                    Nodes(state, run, now, onOpenNode)
                    ChildRuns(state, run, now, onOpenRun)
                    val usage = remember(run.nodes) { run.nodes.flatMap { it.usage.orEmpty() } }
                    if (usage.isNotEmpty()) ItemGroup(title = stringResource(R.string.pipelines_usage)) { UsageItems(usage) }
                    if (run.leases.isNotEmpty()) ItemGroup(title = stringResource(R.string.pipelines_computers)) { LeaseItems(run.leases) }
                    run.input?.let { ValueGroup(stringResource(R.string.pipelines_input), it, PipelineRunTags.INPUT) }
                    run.outputs?.let { ValueGroup(stringResource(R.string.pipelines_result), it, PipelineRunTags.RESULT) }
                }
            }
        }
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

/** The run's state, who started it and when, its group, and Abort while it may still be aborted. */
@Composable
private fun Summary(state: PipelineRunView, run: PipelineRun, agents: AgentNames, now: Long, onAbort: () -> Unit) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    val entry = run.entry
    val footer = when (val abort = state.abort) {
        is PipelineAbort.Failed -> abort.message?.let { stringResource(R.string.pipelines_run_abort_failed_because, it) } ?: stringResource(R.string.pipelines_run_abort_failed)
        else -> if (state.failed) stringResource(R.string.pipelines_out_of_date) else null
    }
    ItemGroup(footer = footer) {
        Item(
            title = stateWords(entry.state),
            titleColor = stateColor(entry.state),
            subtitle = stringResource(R.string.pipelines_version, entry.version),
            icon = { StateGlyph(entry.state) },
            rightElement = entry.startedAt?.let { started ->
                {
                    Text(
                        durationText(resources, (entry.endedAt ?: now) - started),
                        style = ItemSpec.subtitle,
                        color = colors.textSecondary,
                        modifier = Modifier.testTag(PipelineRunTags.DURATION),
                    )
                }
            },
            modifier = Modifier.testTag(PipelineRunTags.SUMMARY),
        )
        Item(title = stringResource(R.string.pipelines_run_started_by), detail = startedBy(run, state.relatives, agents), showChevron = false)
        Item(title = stringResource(R.string.pipelines_run_queued), detail = pipelineTime(entry.createdAt), showChevron = false)
        entry.startedAt?.let { Item(title = stringResource(R.string.pipelines_run_started), detail = pipelineTime(it), showChevron = false) }
        entry.endedAt?.let { Item(title = stringResource(R.string.pipelines_run_ended), detail = pipelineTime(it), showChevron = false) }
        run.group?.let { Item(title = stringResource(R.string.pipelines_run_group), detail = it, showChevron = false) }
        if (entry.state.active) {
            Item(
                title = stringResource(R.string.pipelines_run_abort),
                destructive = true,
                loading = state.abort == PipelineAbort.Sending,
                onClick = onAbort,
                showChevron = false,
                modifier = Modifier.testTag(PipelineRunTags.ABORT),
            )
        }
    }
}

/** Who started a run: an agent by home's name, or the parent run's pipeline and the node it came from. */
@Composable
private fun startedBy(run: PipelineRun, relatives: Map<String, PipelineRunRelative>, agents: AgentNames): String =
    when (val trigger = run.entry.trigger) {
        is PipelineRunTrigger.Agent -> trigger.agentId?.let(agents::name) ?: stringResource(R.string.pipelines_started_by_an_agent)
        is PipelineRunTrigger.Pipeline -> relatives[trigger.runId]?.let { stringResource(R.string.pipelines_started_from, it.pipelineName, trigger.nodeId) }
            ?: stringResource(R.string.pipelines_started_from_node, trigger.nodeId)
        null -> stringResource(if (run.entry.parentRunId != null) R.string.pipelines_started_by_a_parent else R.string.pipelines_started_by_unknown)
    }

/** Every node in graph order; one the definition has and the run doesn't yet is waiting, or never reached once the run ended. */
@Composable
private fun Nodes(state: PipelineRunView, run: PipelineRun, now: Long, onOpenNode: (String) -> Unit) {
    val resources = LocalResources.current
    val definition = state.definition
    // Before the graph is read, the run's own nodes; after, every node it defines.
    val order = remember(definition, run.nodes) { pipelineNodeOrder(definition, run.nodes) }
    val names = state.relatives.values.associate { it.pipelineId to it.pipelineName } + state.pipelineNames
    ItemGroup(
        title = stringResource(R.string.pipelines_nodes),
        footer = if (state.definitionFailed) stringResource(R.string.pipelines_nodes_unordered) else null,
        modifier = Modifier.testTag(PipelineRunTags.NODES),
    ) {
        order.forEach { id ->
            val node = run.node(id)
            val defined = definition?.node(id)
            val kind = node?.kind ?: defined?.kind
            val stateText = when {
                node != null -> nodeStateWords(node.state)
                run.state.active -> stringResource(R.string.pipelines_node_waiting)
                else -> stringResource(R.string.pipelines_node_not_run)
            }
            val subtitle = when {
                node?.state == PipelineNodeState.Running && node.status != null -> progressText(resources, node.status.text, node.status.progress)
                node?.failure != null -> failureTitle(resources, node.failure.code)
                kind != null -> nodeKindWords(kind, defined) { pipelineId -> names[pipelineId] ?: pipelineId }
                else -> null
            }
            PipelineRow(
                tag = PipelineRunTags.node(id),
                glyph = { NodeStateGlyph(node?.state ?: PipelineNodeState.Pending.takeIf { run.state.active }) },
                title = id,
                subtitle = subtitle,
                stateText = stateText,
                stateColor = node?.let { nodeStateColor(it.state) } ?: HappyTheme.colors.textSecondary,
                stateTag = PipelineRunTags.nodeState(id),
                duration = node?.startedAt?.let { durationText(resources, (node.endedAt ?: now) - it) },
                durationTag = PipelineRunTags.nodeDuration(id),
                dim = node?.state == PipelineNodeState.Skipped || (node == null && !run.state.active),
                onClick = { onOpenNode(id) },
            )
        }
    }
}

/** Why the run failed, node by node: the failure in words, the node and its code, and its message's last line. */
@Composable
private fun Failures(run: PipelineRun, onOpenNode: (String) -> Unit) {
    val failed = run.nodes.filter { it.failure != null }
    if (failed.isEmpty()) return
    val resources = LocalResources.current
    ItemGroup(title = stringResource(R.string.pipelines_failures)) {
        failed.forEach { node ->
            val failure = node.failure!!
            // A traceback ends with the exception; its first line says nothing.
            val said = failure.message.lines().lastOrNull { it.isNotBlank() }?.trim()
            Item(
                title = failureTitle(resources, failure.code),
                titleColor = HappyTheme.colors.textDestructive,
                subtitle = listOfNotNull("${node.nodeId} · ${failure.code}", said).joinToString("\n"),
                subtitleLines = 3,
                onClick = { onOpenNode(node.nodeId) },
                modifier = Modifier.testTag(PipelineRunTags.failure(node.nodeId)),
            )
        }
    }
}

/** The runs this run's pipeline nodes made or joined, each with the nodes waiting on it. */
@Composable
private fun ChildRuns(state: PipelineRunView, run: PipelineRun, now: Long, onOpenRun: (String) -> Unit) {
    val children = run.childIds
    if (children.isEmpty()) return
    ItemGroup(title = stringResource(R.string.pipelines_child_runs)) {
        children.forEach { child ->
            val nodes = run.nodes.filter { it.childRunId == child }.map { it.nodeId }
            val via = when (nodes.size) {
                0 -> stringResource(R.string.pipelines_child_via_run)
                1 -> stringResource(R.string.pipelines_child_via_node, nodes[0])
                else -> stringResource(R.string.pipelines_child_via_nodes, nodes.joinToString(", "))
            }
            RelativeRow(child, state.relatives[child], now, via, onOpenRun)
        }
    }
}

/** A run beside this one: its pipeline, version and how it is tied to this run, its state and how long it took; the run's ID until it has been read. */
@Composable
internal fun RelativeRow(runId: String, relative: PipelineRunRelative?, now: Long, via: String?, onOpenRun: (String) -> Unit) {
    val resources = LocalResources.current
    PipelineRow(
        tag = PipelineRunTags.relative(runId),
        glyph = { if (relative != null) StateGlyph(relative.state) else NodeStateGlyph(null) },
        title = relative?.pipelineName ?: runId,
        subtitle = listOfNotNull(relative?.let { stringResource(R.string.pipelines_version, it.version) }, via).joinToString(" · ").ifEmpty { null },
        stateText = relative?.let { stateWords(it.state) },
        stateColor = relative?.let { stateColor(it.state) } ?: HappyTheme.colors.textSecondary,
        duration = relative?.startedAt?.let { durationText(resources, (relative.endedAt ?: now) - it) },
        onClick = { onOpenRun(runId) },
    )
}

/**
 * A row of the run pages on [Item]'s metrics: 16 in, [glyph] in the 32 slot,
 * 12, [title] (16/24) over [subtitle] (14/20), and on the right [stateText]
 * (14/20, its colour) over [duration], then the chevron.
 */
@Composable
internal fun PipelineRow(
    tag: String,
    glyph: @Composable () -> Unit,
    title: String,
    subtitle: String?,
    stateText: String?,
    stateColor: Color,
    duration: String?,
    onClick: (() -> Unit)?,
    stateTag: String? = null,
    durationTag: String? = null,
    dim: Boolean = false,
) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .fillMaxWidth()
            .testTag(tag)
            .then(
                if (onClick != null) Modifier.clickable(interactionSource = interaction, indication = ripple(color = colors.text), role = Role.Button, onClick = onClick)
                else Modifier.semantics(mergeDescendants = true) {},
            )
            .defaultMinSize(minHeight = ItemSpec.minHeight)
            .padding(horizontal = ItemSpec.paddingHorizontal, vertical = ItemSpec.paddingVertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.weight(1f).alpha(if (dim) PipelineRunSpec.DIM else 1f), verticalAlignment = Alignment.CenterVertically) {
            glyph()
            Spacer(Modifier.width(ItemSpec.iconGap))
            Column(Modifier.weight(1f)) {
                Text(title, style = ItemSpec.title, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.let { Text(it, style = ItemSpec.subtitle, color = colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            if (stateText != null || duration != null) {
                Spacer(Modifier.width(ItemSpec.rightSectionGap))
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.Center) {
                    stateText?.let { Text(it, style = ItemSpec.subtitle, color = stateColor, maxLines = 1, modifier = stateTag?.let { t -> Modifier.testTag(t) } ?: Modifier) }
                    duration?.let { Text(it, style = ItemSpec.subtitle, color = colors.textSecondary, maxLines = 1, modifier = durationTag?.let { t -> Modifier.testTag(t) } ?: Modifier) }
                }
            }
        }
        if (onClick != null) {
            Icon(Ionicon.ChevronForward, ItemSpec.chevronSize, colors.grouped.chevron, Modifier.padding(start = ItemSpec.chevronGap))
        }
    }
}

/** What agent nodes spent (desktop's `PipelineUsage`): cost, tokens, cached and reasoning in total, then the model, or each model's share when there were several. */
@Composable
internal fun UsageItems(usage: List<PipelineModelUsage>) {
    val priced = usage.mapNotNull { it.costUsd }
    val cost = when {
        priced.isEmpty() -> stringResource(R.string.pipelines_usage_not_priced)
        priced.size < usage.size -> stringResource(R.string.pipelines_usage_some_unpriced, costText(priced.sum()))
        else -> costText(priced.sum())
    }
    val cached = usage.sumOf { it.cacheRead + it.cacheWrite }
    val reasoning = usage.sumOf { it.reasoning }
    Item(title = stringResource(R.string.pipelines_usage_cost), detail = cost, showChevron = false)
    Item(
        title = stringResource(R.string.pipelines_usage_tokens),
        detail = stringResource(R.string.pipelines_usage_tokens_value, tokensText(usage.sumOf { it.input }), tokensText(usage.sumOf { it.output })),
        showChevron = false,
    )
    if (cached > 0) Item(title = stringResource(R.string.pipelines_usage_cached), detail = tokensText(cached), showChevron = false)
    if (reasoning > 0) Item(title = stringResource(R.string.pipelines_usage_reasoning), detail = tokensText(reasoning), showChevron = false)
    if (usage.size == 1) {
        Item(title = stringResource(R.string.pipelines_usage_model), subtitle = usage[0].model, showChevron = false)
    } else {
        usage.groupBy { it.model }.forEach { (model, spent) ->
            val modelCost = spent.mapNotNull { it.costUsd }.takeIf { it.isNotEmpty() }?.sum()
            Item(
                title = model,
                subtitle = listOfNotNull(
                    modelCost?.let(::costText),
                    stringResource(R.string.pipelines_usage_tokens_value, tokensText(spent.sumOf { it.input }), tokensText(spent.sumOf { it.output })),
                ).joinToString(" · "),
                showChevron = false,
            )
        }
    }
}

/** The computers held: each lease's name over its computer and who holds it, or when it was released. */
@Composable
internal fun LeaseItems(leases: List<PipelineLease>) {
    leases.forEach { lease ->
        val released = lease.releasedAt
        Item(
            title = lease.name,
            subtitle = when {
                released != null -> stringResource(R.string.pipelines_lease_released, lease.computerId, pipelineTime(released))
                lease.holders.isEmpty() -> stringResource(R.string.pipelines_lease_held_nobody, lease.computerId)
                else -> stringResource(R.string.pipelines_lease_held, lease.computerId, lease.holders.joinToString(", "))
            },
            icon = { Icon(Ionicon.DesktopOutline, PipelinesSpec.stateGlyph, HappyTheme.colors.textSecondary) },
            showChevron = false,
        )
    }
}

/** A JSON value under [title], indented, in monospace that scrolls sideways rather than wrapping, and selectable. */
@Composable
internal fun ValueGroup(title: String, value: JsonElement, tag: String) {
    val text = remember(value) { prettyJson(value).let { if (it.length > PipelineRunSpec.VALUE_LIMIT) it.take(PipelineRunSpec.VALUE_LIMIT) + "\n…" else it } }
    ItemGroup(title = title) { MonoBlock(text, Modifier.testTag(tag)) }
}

/** Monospace text inside a card, 16 in ([top] above, for one under an [Item] that already has its 16 below), scrolling sideways. */
@Composable
internal fun MonoBlock(text: String, modifier: Modifier = Modifier, color: Color = HappyTheme.colors.text, top: Dp = ItemSpec.paddingVertical) {
    SelectionContainer(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(start = ItemSpec.paddingHorizontal, end = ItemSpec.paddingHorizontal, top = top, bottom = ItemSpec.paddingVertical),
    ) {
        Text(text, style = PipelineRunSpec.mono, color = color, softWrap = false)
    }
}

/** A subdued note in a card, for what a section has nothing of yet. */
@Composable
internal fun NoteItem(text: String, modifier: Modifier = Modifier) {
    Item(title = text, titleColor = HappyTheme.colors.textSecondary, titleLines = 0, showChevron = false, modifier = modifier)
}
