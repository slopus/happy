package com.slopus.happy.ui.pipelines

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.pipelines.PipelineLogEntry
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelineNodeLog
import com.slopus.happy.pipelines.PipelineNodeRun
import com.slopus.happy.pipelines.PipelineNodeState
import com.slopus.happy.pipelines.PipelineRun
import com.slopus.happy.pipelines.PipelineRunView
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemGroupSpec
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object PipelineNodeTags {
    const val LIST = "pipelines.node.list"
    const val RETRY = "pipelines.node.retry"
    const val SUMMARY = "pipelines.node.summary"
    const val DURATION = "pipelines.node.duration"
    const val STATUS = "pipelines.node.status"
    const val FAILURE = "pipelines.node.failure"
    const val FAILURE_MESSAGE = "pipelines.node.failure.message"
    const val LOG_NOTE = "pipelines.node.log.note"
    const val LOG_DROPPED = "pipelines.node.log.dropped"
    const val OUTPUT = "pipelines.node.output"
    const val INPUT = "pipelines.node.input"
    fun entry(seq: Long) = "pipelines.node.log.$seq"
    fun gutter(seq: Long) = "pipelines.node.log.$seq.gutter"
    fun commandHead(seq: Long) = "pipelines.node.log.$seq.head"
    fun commandState(seq: Long) = "pipelines.node.log.$seq.state"
    fun commandOutput(seq: Long) = "pipelines.node.log.$seq.output"
}

/** The log's sizes: a card like [ItemGroup]'s, its rows a CI log's. */
object PipelineLogSpec {
    /** The card's 12 inside the group's 4, as [ItemGroup]'s. */
    val cardInset = ItemGroupSpec.paddingHorizontal + ItemGroupSpec.cardMarginHorizontal
    val cardRadius = ItemGroupSpec.cardRadius
    /** The card's padding above its first row and below its last. */
    val edge = 12.dp
    /** Between rows. */
    val rowGap = 2.dp
    /** The `m:ss` since the node started, before each row. */
    val gutterWidth = 44.dp
    val gutter = happyTextStyle(fontSize = 12, lineHeight = 18, family = FontFamily.Monospace)
    val glyph = 14.dp
    val glyphGap = 6.dp
    /** A command's output, inset under its head on the code ground. */
    val outputPadding = 8.dp
    val outputRadius = 8.dp
    val note = happyTextStyle(fontSize = 13, lineHeight = 18)
    val head = happyTextStyle(fontSize = 13, lineHeight = 18, family = FontFamily.Monospace, weight = FontWeight.Medium)
}

/**
 * One node of a run, with its log (desktop's node pane and
 * `PipelineNodeRunFacts`): its state, kind and how long it took, its newest
 * status line, the child run a pipeline node made, why it failed (the code
 * in words, the code, the message, a traceback in monospace), then its log
 * as a CI log, live. Under the log, what its agent spent, its output and
 * input, every status line it set (newest first) and the computers it held.
 *
 * The log is a card of [PipelineLogSpec] rows, each with its `m:ss` since
 * the node started in a 44 gutter: printed output in 13/18 monospace
 * (stderr red); a command's `$ line`, its exit code (or Running, Aborted)
 * and how long it took, its output folding under it, open while it runs,
 * when it failed or once watched running; a tool call's name, what it was
 * called on, Done or Failed and its error; an agent's words as Markdown; a
 * status line with how far along. The page is a lazy list, so a long log
 * draws only what shows.
 */
@Composable
fun PipelineNodeScreen(
    state: PipelineRunView,
    nodeId: String,
    log: PipelineNodeLog,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    onOpenRun: (runId: String) -> Unit,
    now: Long = rememberNow(state.live),
) {
    val colors = HappyTheme.colors
    val run = state.run
    Screen(header = { StackHeader(nodeId, onBack) }) {
        val top = barInsetTop()
        LazyColumn(
            Modifier.fillMaxSize().background(colors.grouped.background).testTag(PipelineNodeTags.LIST),
            contentPadding = PaddingValues(top = top, bottom = ItemGroupSpec.listPaddingBottom),
        ) {
            when {
                run == null && state.loading -> item { ItemGroup { Item(title = stringResource(R.string.pipelines_run_loading), loading = true, showChevron = false) } }
                run == null && state.missing -> item {
                    ItemGroup(footer = stringResource(R.string.pipelines_run_missing_footer)) { NoteItem(stringResource(R.string.pipelines_run_missing)) }
                }
                run == null -> item {
                    ItemGroup {
                        Item(
                            title = stringResource(R.string.pipelines_run_failed),
                            subtitle = stringResource(R.string.pipelines_tap_to_retry),
                            onClick = onRetry,
                            showChevron = false,
                            modifier = Modifier.testTag(PipelineNodeTags.RETRY),
                        )
                    }
                }
                else -> nodePage(state, run, nodeId, log, now, onOpenRun)
            }
        }
    }
}

private fun LazyListScope.nodePage(state: PipelineRunView, run: PipelineRun, nodeId: String, log: PipelineNodeLog, now: Long, onOpenRun: (String) -> Unit) {
    val node = run.node(nodeId)
    val defined = state.definition?.node(nodeId)
    item("summary") { NodeSummary(state, run, node, defined, now) }
    node?.childRunId?.let { child ->
        item("child") {
            ItemGroup(title = stringResource(R.string.pipelines_child_run)) { RelativeRow(child, state.relatives[child], now, null, onOpenRun) }
        }
    }
    node?.failure?.let { failure ->
        item("failure") {
            val resources = LocalResources.current
            ItemGroup(title = stringResource(R.string.pipelines_failure)) {
                Item(
                    title = failureTitle(resources, failure.code),
                    titleColor = HappyTheme.colors.textDestructive,
                    subtitle = failure.code,
                    subtitleStyle = PipelineRunSpec.mono,
                    showChevron = false,
                    modifier = Modifier.testTag(PipelineNodeTags.FAILURE),
                )
                val message = failure.message.ifBlank { stringResource(R.string.pipelines_failure_no_message) }
                // A traceback: its lines and their alignment are the message.
                if (failure.message.contains('\n')) {
                    MonoBlock(failure.message.trimEnd(), Modifier.testTag(PipelineNodeTags.FAILURE_MESSAGE), top = 0.dp)
                } else {
                    Item(title = message, titleLines = 0, showChevron = false, modifier = Modifier.testTag(PipelineNodeTags.FAILURE_MESSAGE))
                }
            }
        }
    }
    logRows(node, log, run.state.active)
    val usage = node?.usage
    when {
        usage != null -> item("usage") { ItemGroup(title = stringResource(R.string.pipelines_usage)) { UsageItems(usage) } }
        node != null && node.kind == PipelineNodeKind.Agent && node.state != PipelineNodeState.Pending && node.state != PipelineNodeState.Skipped ->
            item("usage") { ItemGroup(title = stringResource(R.string.pipelines_usage)) { NoteItem(stringResource(R.string.pipelines_usage_none)) } }
    }
    node?.output?.let { item("output") { ValueGroup(stringResource(R.string.pipelines_output), it, PipelineNodeTags.OUTPUT) } }
    node?.input?.let { item("input") { ValueGroup(stringResource(R.string.pipelines_input), it, PipelineNodeTags.INPUT) } }
    if (node != null) {
        item("statuses") {
            val resources = LocalResources.current
            ItemGroup(title = stringResource(R.string.pipelines_statuses)) {
                if (node.statuses.isEmpty()) NoteItem(stringResource(R.string.pipelines_statuses_none))
                node.statuses.asReversed().forEach { status ->
                    Item(title = progressText(resources, status.text, status.progress), titleLines = 0, detail = pipelineTime(status.at), showChevron = false)
                }
            }
        }
    }
    val leases = run.leases.filter { nodeId in it.holders || (defined != null && it.name in defined.leases) }
    if (leases.isNotEmpty()) item("computers") { ItemGroup(title = stringResource(R.string.pipelines_computers)) { LeaseItems(leases) } }
}

/** The node's state and kind, how long it took or has so far, and its newest status line. */
@Composable
private fun NodeSummary(state: PipelineRunView, run: PipelineRun, node: PipelineNodeRun?, defined: PipelineNodeDefinition?, now: Long) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    val names = state.relatives.values.associate { it.pipelineId to it.pipelineName } + state.pipelineNames
    val kind = node?.kind ?: defined?.kind
    ItemGroup(footer = if (state.failed) stringResource(R.string.pipelines_out_of_date) else null) {
        Item(
            title = when {
                node != null -> nodeStateWords(node.state)
                run.state.active -> stringResource(R.string.pipelines_node_waiting)
                else -> stringResource(R.string.pipelines_node_not_run)
            },
            titleColor = node?.let { nodeStateColor(it.state) } ?: colors.textSecondary,
            subtitle = kind?.let { nodeKindWords(it, defined) { id -> names[id] ?: id } },
            icon = { NodeStateGlyph(node?.state ?: PipelineNodeState.Pending.takeIf { run.state.active }) },
            rightElement = node?.startedAt?.let { started ->
                {
                    Text(
                        durationText(resources, (node.endedAt ?: now) - started),
                        style = ItemSpec.subtitle,
                        color = colors.textSecondary,
                        modifier = Modifier.testTag(PipelineNodeTags.DURATION),
                    )
                }
            },
            modifier = Modifier.testTag(PipelineNodeTags.SUMMARY),
        )
        node?.status?.let { status ->
            Item(
                title = progressText(resources, status.text, status.progress),
                titleLines = 0,
                icon = { Box(Modifier.width(ItemSpec.iconSize), contentAlignment = Alignment.Center) { Icon(Ionicon.PulseOutline, PipelinesSpec.stateGlyph, colors.textSecondary) } },
                showChevron = false,
                modifier = Modifier.testTag(PipelineNodeTags.STATUS),
            )
        }
    }
}

/** The log's title, as [ItemGroup] draws one. */
@Composable
private fun LogTitle() {
    Box(
        Modifier
            .fillMaxWidth()
            .contentMaxWidth(LocalWindowLayout.current)
            .padding(horizontal = ItemGroupSpec.paddingHorizontal)
            .padding(
                start = ItemGroupSpec.headerPaddingHorizontal,
                end = ItemGroupSpec.headerPaddingHorizontal,
                top = ItemGroupSpec.headerPaddingTop,
                bottom = ItemGroupSpec.headerPaddingBottom,
            ),
    ) {
        Text(stringResource(R.string.pipelines_log).uppercase(), style = ItemGroupSpec.header, color = HappyTheme.colors.grouped.sectionTitle)
    }
}

/** One row's slice of the log's card: the card's top corners on the first, its bottom ones on the last. */
@Composable
private fun LogSlice(first: Boolean, last: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val radius = PipelineLogSpec.cardRadius
    val shape = RoundedCornerShape(topStart = if (first) radius else 0.dp, topEnd = if (first) radius else 0.dp, bottomStart = if (last) radius else 0.dp, bottomEnd = if (last) radius else 0.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .contentMaxWidth(LocalWindowLayout.current)
            .padding(horizontal = PipelineLogSpec.cardInset)
            .clip(shape)
            .background(HappyTheme.colors.surface)
            .then(modifier)
            .padding(
                start = ItemSpec.paddingHorizontal,
                end = ItemSpec.paddingHorizontal,
                top = if (first) PipelineLogSpec.edge else PipelineLogSpec.rowGap,
                bottom = if (last) PipelineLogSpec.edge else PipelineLogSpec.rowGap,
            ),
    ) { content() }
}

/** The log's rows, or what it has nothing of: skipped, not started, reading, nothing yet. */
private fun LazyListScope.logRows(node: PipelineNodeRun?, log: PipelineNodeLog, runActive: Boolean) {
    item("log-title") { LogTitle() }
    val note = when {
        node == null -> if (runActive) R.string.pipelines_log_pending else R.string.pipelines_log_not_run
        node.state == PipelineNodeState.Pending -> R.string.pipelines_log_pending
        node.state == PipelineNodeState.Skipped -> R.string.pipelines_log_skipped
        log.entries.isEmpty() && log.dropped == 0 -> when {
            log.loading -> R.string.pipelines_log_reading
            node.state == PipelineNodeState.Running && runActive -> R.string.pipelines_log_nothing_yet
            else -> R.string.pipelines_log_nothing
        }
        else -> null
    }
    if (note != null) {
        item("log-note") {
            LogSlice(first = true, last = true, Modifier.testTag(PipelineNodeTags.LOG_NOTE)) {
                Text(stringResource(note), style = ItemSpec.subtitle, color = HappyTheme.colors.textSecondary, modifier = Modifier.padding(vertical = 4.dp))
            }
        }
    } else {
        val startedAt = node?.startedAt
        val dropped = log.dropped > 0
        if (dropped) {
            item("log-dropped") {
                LogSlice(first = true, last = log.entries.isEmpty(), Modifier.testTag(PipelineNodeTags.LOG_DROPPED)) {
                    Text(stringResource(R.string.pipelines_log_dropped, log.dropped), style = PipelineLogSpec.note, color = HappyTheme.colors.textSecondary)
                }
            }
        }
        val lastSeq = log.entries.lastOrNull()?.seq
        val firstSeq = log.entries.firstOrNull()?.seq
        items(log.entries, key = { it.seq }, contentType = { it::class }) { entry ->
            LogSlice(first = !dropped && entry.seq == firstSeq, last = entry.seq == lastSeq, Modifier.testTag(PipelineNodeTags.entry(entry.seq))) {
                LogRow(entry, startedAt, log.watched)
            }
        }
    }
    if (log.failed) {
        item("log-failed") {
            Text(
                stringResource(R.string.pipelines_log_out_of_date),
                style = ItemGroupSpec.footer,
                color = HappyTheme.colors.grouped.sectionTitle,
                modifier = Modifier
                    .fillMaxWidth()
                    .contentMaxWidth(LocalWindowLayout.current)
                    .padding(horizontal = ItemGroupSpec.paddingHorizontal + ItemGroupSpec.footerPaddingHorizontal)
                    .padding(top = ItemGroupSpec.footerPaddingTop),
            )
        }
    }
}

/** `m:ss` since the node started, the gutter CI logs keep. */
private fun offsetText(at: Long, startedAt: Long?): String {
    if (startedAt == null) return ""
    val seconds = ((at - startedAt) / 1000).coerceAtLeast(0)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

@Composable
private fun LogRow(entry: PipelineLogEntry, startedAt: Long?, watched: Set<Long>) {
    val colors = HappyTheme.colors
    Row {
        Text(
            offsetText(entry.at, startedAt),
            style = PipelineLogSpec.gutter,
            color = colors.textSecondary,
            maxLines = 1,
            modifier = Modifier.width(PipelineLogSpec.gutterWidth).testTag(PipelineNodeTags.gutter(entry.seq)),
        )
        Box(Modifier.weight(1f)) {
            when (entry) {
                is PipelineLogEntry.Output -> SelectionContainer {
                    Text(entry.text.removeSuffix("\n"), style = PipelineRunSpec.mono, color = if (entry.stderr) colors.textDestructive else colors.text)
                }
                is PipelineLogEntry.Command -> CommandRow(entry, watched)
                is PipelineLogEntry.Tool -> ToolRow(entry)
                is PipelineLogEntry.Message -> {
                    val blocks = remember(entry.text) { parseMarkdown(entry.text) }
                    MarkdownView(blocks)
                }
                is PipelineLogEntry.Status -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Ionicon.PulseOutline, PipelineLogSpec.glyph, colors.textSecondary)
                    Spacer(Modifier.width(PipelineLogSpec.glyphGap))
                    Text(progressText(LocalResources.current, entry.text, entry.progress), style = PipelineLogSpec.note, color = colors.textSecondary)
                }
            }
        }
    }
}

/**
 * A command: chevron, `$ line`, its state and how long it took; the lease it
 * ran on; its output under it. It starts open while it runs, when it failed,
 * or once the reader watched it run; the reader's own fold wins after.
 */
@Composable
private fun CommandRow(command: PipelineLogEntry.Command, watched: Set<Long>) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    val output = command.output.removeSuffix("\n")
    val hasOutput = output.isNotEmpty() || command.outputTruncated
    var folded by remember(command.seq) { mutableStateOf<Boolean?>(null) }
    val open = hasOutput && (folded?.not() ?: (command.state == PipelineLogEntry.CommandState.Running || command.failed || command.seq in watched))
    val stateText = when (command.state) {
        PipelineLogEntry.CommandState.Running -> stringResource(R.string.pipelines_state_running)
        PipelineLogEntry.CommandState.Aborted -> stringResource(R.string.pipelines_state_aborted)
        PipelineLogEntry.CommandState.Exited -> command.exitCode?.let { stringResource(R.string.pipelines_log_exit, it) } ?: stringResource(R.string.pipelines_log_exit_unknown)
    }
    val stateColor = when {
        command.failed -> colors.textDestructive
        command.state == PipelineLogEntry.CommandState.Running -> RowTile.Blue.ink(colors.dark)
        else -> colors.textSecondary
    }
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .testTag(PipelineNodeTags.commandHead(command.seq))
                .then(if (hasOutput) Modifier.clickable(role = Role.Button) { folded = open } else Modifier),
            verticalAlignment = Alignment.Top,
        ) {
            Box(Modifier.width(PipelineLogSpec.glyph + PipelineLogSpec.glyphGap).height(18.dp), contentAlignment = Alignment.CenterStart) {
                if (hasOutput) Icon(if (open) Ionicon.ChevronDown else Ionicon.ChevronForward, PipelineLogSpec.glyph, colors.textSecondary)
            }
            Text("$ ${command.command}", style = PipelineLogSpec.head, color = colors.text, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(PipelineLogSpec.glyphGap))
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.Top) {
                Text(stateText, style = PipelineLogSpec.note, color = stateColor, maxLines = 1, modifier = Modifier.testTag(PipelineNodeTags.commandState(command.seq)))
                command.durationMs?.let { Text(shortDurationText(resources, it), style = PipelineLogSpec.note, color = colors.textSecondary, maxLines = 1) }
            }
        }
        val aside = listOfNotNull(command.cwd, command.lease?.let { stringResource(R.string.pipelines_log_on_lease, it) }).joinToString(" · ")
        if (aside.isNotEmpty()) {
            Text(aside, style = PipelineLogSpec.note, color = colors.textSecondary, modifier = Modifier.padding(start = PipelineLogSpec.glyph + PipelineLogSpec.glyphGap))
        }
        if (open) {
            Column(
                Modifier
                    .padding(top = 4.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(PipelineLogSpec.outputRadius))
                    .background(colors.surfaceHighest)
                    .testTag(PipelineNodeTags.commandOutput(command.seq))
                    .padding(PipelineLogSpec.outputPadding),
            ) {
                if (command.outputTruncated) Text(stringResource(R.string.pipelines_log_truncated), style = PipelineLogSpec.note, color = colors.textSecondary)
                SelectionContainer(Modifier.horizontalScroll(rememberScrollState())) {
                    Text(output, style = PipelineRunSpec.mono, color = colors.text, softWrap = false)
                }
            }
        }
    }
}

/** A tool call: ⚡, its name and what it was called on, Running, Done or Failed, how long it took, and its error. */
@Composable
private fun ToolRow(tool: PipelineLogEntry.Tool) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    Column {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.width(PipelineLogSpec.glyph + PipelineLogSpec.glyphGap).height(18.dp), contentAlignment = Alignment.CenterStart) {
                Icon(Ionicon.FlashOutline, PipelineLogSpec.glyph, colors.textSecondary)
            }
            Text(tool.name, style = PipelineLogSpec.head, color = colors.text, maxLines = 1)
            Spacer(Modifier.width(PipelineLogSpec.glyphGap))
            Text(tool.summary, style = PipelineLogSpec.note, color = colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(PipelineLogSpec.glyphGap))
            Column(horizontalAlignment = Alignment.End) {
                val (text, color) = when (tool.state) {
                    PipelineLogEntry.ToolState.Running -> stringResource(R.string.pipelines_state_running) to RowTile.Blue.ink(colors.dark)
                    PipelineLogEntry.ToolState.Ok -> stringResource(R.string.pipelines_log_done) to colors.textSecondary
                    PipelineLogEntry.ToolState.Error -> stringResource(R.string.pipelines_state_failed) to colors.textDestructive
                }
                Text(text, style = PipelineLogSpec.note, color = color, maxLines = 1)
                tool.durationMs?.let { Text(shortDurationText(resources, it), style = PipelineLogSpec.note, color = colors.textSecondary, maxLines = 1) }
            }
        }
        tool.error?.let { SelectionContainer { Text(it, style = PipelineRunSpec.mono, color = colors.textDestructive) } }
    }
}
