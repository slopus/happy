package com.slopus.happy.ui.pipelines

import android.content.res.Resources
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.pipelines.PipelineRunListEntry
import com.slopus.happy.pipelines.PipelineRuns
import com.slopus.happy.pipelines.PipelineRunState
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineSummary
import com.slopus.happy.pipelines.PipelinesList
import com.slopus.happy.ui.chat.compactAgo
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.PageProgressIndicator
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.StartedEffect
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.connection.TileMark
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay

object PipelinesTags {
    const val LIST = "pipelines.list"
    const val RETRY = "pipelines.retry"
    const val OLDER = "pipelines.older"
    fun pipeline(id: String) = "pipelines.pipeline.$id"
    fun run(id: String) = "pipelines.run.$id"
    fun runState(id: String) = "pipelines.run.$id.state"
    fun runDuration(id: String) = "pipelines.run.$id.duration"
    fun child(id: String) = "pipelines.run.$id.child"
}

/** Sizes of the pipeline pages, on [Item]'s metrics. */
object PipelinesSpec {
    /** A run's state glyph, centred in the 32 icon slot. */
    val stateGlyph = 22.dp
    val spinner = 18.dp
    /** A child run's ↳ before its pipeline's name. */
    val childGlyph = 16.dp
    val childGap = 4.dp
    /** A clock ticks each second while a run is live, else each half minute for "5m". */
    const val LIVE_TICK = 1_000L
    const val IDLE_TICK = 30_000L
}

/** What a run's state is called and the colour it reads in. */
@Composable
internal fun stateWords(state: PipelineRunState): String = stringResource(
    when (state) {
        PipelineRunState.Queued -> R.string.pipelines_state_queued
        PipelineRunState.Running -> R.string.pipelines_state_running
        PipelineRunState.Succeeded -> R.string.pipelines_state_succeeded
        PipelineRunState.Failed -> R.string.pipelines_state_failed
        PipelineRunState.Aborted -> R.string.pipelines_state_aborted
        PipelineRunState.Superseded -> R.string.pipelines_state_superseded
    },
)

/** Desktop's tones: running blue, succeeded green, failed red, the rest quiet. */
@Composable
internal fun stateColor(state: PipelineRunState): Color {
    val colors = HappyTheme.colors
    return when (state) {
        PipelineRunState.Running -> RowTile.Blue.ink(colors.dark)
        PipelineRunState.Succeeded -> colors.success
        PipelineRunState.Failed -> colors.textDestructive
        PipelineRunState.Queued, PipelineRunState.Aborted, PipelineRunState.Superseded -> colors.textSecondary
    }
}

/** A run's state as a glyph, centred in [box] (an [Item]'s icon slot): a spinner while it runs. */
@Composable
internal fun StateGlyph(state: PipelineRunState, modifier: Modifier = Modifier, box: Dp = ItemSpec.iconSize) {
    val color = stateColor(state)
    Box(modifier.size(box), contentAlignment = Alignment.Center) {
        when (state) {
            PipelineRunState.Running -> PageProgressIndicator(Modifier.size(PipelinesSpec.spinner), color = color, strokeWidth = 2.dp)
            PipelineRunState.Queued -> Icon(Ionicon.TimeOutline, PipelinesSpec.stateGlyph, color)
            PipelineRunState.Succeeded -> Icon(Ionicon.CheckmarkCircle, PipelinesSpec.stateGlyph, color)
            PipelineRunState.Failed -> Icon(Ionicon.CloseCircle, PipelinesSpec.stateGlyph, color)
            PipelineRunState.Aborted -> Icon(Ionicon.StopCircle, PipelinesSpec.stateGlyph, color)
            PipelineRunState.Superseded -> Icon(Ionicon.RemoveCircleOutline, PipelinesSpec.stateGlyph, color)
        }
    }
}

/** How long something took, or has taken so far: "42s", "3m 12s", "1h 5m" (desktop's `elapsedTimeFormat`). */
internal fun durationText(resources: Resources, millis: Long): String {
    val seconds = (millis / 1000).coerceAtLeast(0)
    val minutes = seconds / 60
    return when {
        seconds < 60 -> resources.getString(R.string.pipelines_duration_seconds, seconds.toInt())
        minutes < 60 -> resources.getString(R.string.pipelines_duration_minutes, minutes.toInt(), (seconds % 60).toInt())
        else -> resources.getString(R.string.pipelines_duration_hours, (minutes / 60).toInt(), (minutes % 60).toInt())
    }
}

/** Now, ticking each second while [live] and each half minute otherwise, while the page shows. */
@Composable
internal fun rememberNow(live: Boolean): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    StartedEffect(live) {
        while (true) {
            now = System.currentTimeMillis()
            delay(if (live) PipelinesSpec.LIVE_TICK else PipelinesSpec.IDLE_TICK)
        }
    }
    return now
}

/** Names the agent that started a run; null where this phone doesn't know it. */
fun interface AgentNames {
    fun name(agentId: String): String?
}

/**
 * The connection's pipelines (home's Pipelines row; desktop's Pipelines
 * page): the pipelines by name on top, then every run of them, newest
 * first, live. Read only; agents create and run pipelines.
 *
 * A pipeline's row is an [Item]: the teal pipeline tile (32), its name
 * (16/24), "v3" and Disabled under it (14/20), and on the right how its
 * last run went and when, or Never run. A run's row is [RunRow]. Older
 * runs page in from the button under them. The rows open their pipeline or
 * run where [onOpenPipeline] and [onOpenRun] are given.
 */
@Composable
fun PipelinesScreen(
    state: PipelinesList,
    agents: AgentNames,
    onRetry: () -> Unit,
    onMore: () -> Unit,
    onBack: () -> Unit,
    onOpenPipeline: ((pipelineId: String) -> Unit)? = null,
    onOpenRun: ((runId: String) -> Unit)? = null,
    now: Long = rememberNow(state.live),
) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.pipelines_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(PipelinesTags.LIST)) {
            when {
                state.loading -> ItemGroup { Item(title = stringResource(R.string.pipelines_loading), loading = true, showChevron = false) }
                state.failed && state.pipelines.isEmpty() -> ItemGroup {
                    Item(
                        title = stringResource(R.string.pipelines_failed),
                        subtitle = stringResource(R.string.pipelines_tap_to_retry),
                        onClick = onRetry,
                        showChevron = false,
                        modifier = Modifier.testTag(PipelinesTags.RETRY),
                    )
                }
                state.pipelines.isEmpty() -> ItemGroup(footer = stringResource(R.string.pipelines_empty_footer)) {
                    Item(title = stringResource(R.string.pipelines_empty), titleColor = colors.textSecondary, showChevron = false)
                }
                else -> {
                    ItemGroup(
                        title = stringResource(R.string.pipelines_title),
                        footer = if (state.failed) stringResource(R.string.pipelines_out_of_date) else null,
                    ) {
                        state.pipelines.forEach { PipelineRow(it, now, onOpenPipeline) }
                    }
                    RunsGroup(state.runs, agents, now, stringResource(R.string.pipelines_runs_empty), onMore, onOpenRun)
                }
            }
        }
    }
}

@Composable
private fun PipelineRow(pipeline: PipelineSummary, now: Long, onOpen: ((String) -> Unit)?) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    val version = stringResource(R.string.pipelines_version, pipeline.headVersion)
    Item(
        title = pipeline.name,
        subtitle = if (pipeline.enabled) version else "$version · ${stringResource(R.string.pipelines_disabled)}",
        icon = { TileMark(Ionicon.GitNetworkOutline, RowTile.Teal, ItemSpec.iconSize) },
        rightElement = {
            val run = pipeline.lastRun
            Column(horizontalAlignment = Alignment.End) {
                if (run == null) {
                    Text(stringResource(R.string.pipelines_never_run), style = ItemSpec.subtitle, color = colors.textSecondary, maxLines = 1)
                } else {
                    Text(stateWords(run.state), style = ItemSpec.subtitle, color = stateColor(run.state), maxLines = 1)
                    Text(compactAgo(resources, run.endedAt ?: run.createdAt, now), style = ItemSpec.subtitle, color = colors.textSecondary, maxLines = 1)
                }
            }
        },
        onClick = onOpen?.let { { it(pipeline.id) } },
        modifier = Modifier.testTag(PipelinesTags.pipeline(pipeline.id)),
    )
}

/** Runs under Runs, newest first, with Older runs under them while there are more; [empty] where there are none. */
@Composable
internal fun RunsGroup(runs: PipelineRuns, agents: AgentNames, now: Long, empty: String, onMore: () -> Unit, onOpenRun: ((String) -> Unit)?) {
    val colors = HappyTheme.colors
    val title = stringResource(R.string.pipelines_runs)
    when {
        !runs.listed -> ItemGroup(title = title) {
            Item(title = stringResource(R.string.pipelines_runs_unlisted), titleColor = colors.textSecondary, titleLines = 0, showChevron = false)
        }
        runs.loading -> ItemGroup(title = title) { Item(title = stringResource(R.string.pipelines_runs_loading), loading = true, showChevron = false) }
        runs.entries.isEmpty() -> ItemGroup(title = title, footer = if (runs.failed) stringResource(R.string.pipelines_out_of_date) else null) {
            Item(title = empty, titleColor = colors.textSecondary, titleLines = 0, showChevron = false)
        }
        else -> {
            val byId = remember(runs.entries) { runs.entries.associateBy { it.id } }
            ItemGroup(title = title, footer = if (runs.failed) stringResource(R.string.pipelines_out_of_date) else null) {
                runs.entries.forEach { run -> RunRow(run, startedBy(run, byId, agents), now, onOpenRun) }
                if (runs.nextCursor != null) {
                    Item(
                        title = stringResource(R.string.pipelines_runs_older),
                        titleColor = colors.textLink,
                        loading = runs.loadingMore,
                        onClick = onMore,
                        showChevron = false,
                        modifier = Modifier.testTag(PipelinesTags.OLDER),
                    )
                }
            }
        }
    }
}

/** Who started a run: an agent by the name home knows it by, or for a child the run and node it came from. */
@Composable
private fun startedBy(run: PipelineRunListEntry, byId: Map<String, PipelineRunListEntry>, agents: AgentNames): String =
    when (val trigger = run.run.trigger) {
        is PipelineRunTrigger.Agent -> trigger.agentId?.let(agents::name) ?: stringResource(R.string.pipelines_started_by_an_agent)
        is PipelineRunTrigger.Pipeline -> byId[trigger.runId]?.let { stringResource(R.string.pipelines_started_from, it.pipelineName, trigger.nodeId) }
            ?: stringResource(R.string.pipelines_started_from_node, trigger.nodeId)
        null -> stringResource(if (run.run.parentRunId != null) R.string.pipelines_started_by_a_parent else R.string.pipelines_started_by_unknown)
    }

/**
 * One run among every pipeline's (desktop's `PipelineRunsAcrossList` row),
 * on [Item]'s metrics: 16 in, its state glyph in the 32 slot (a spinner
 * while it runs), 12, then its pipeline's name (16/24; a child run's ↳
 * before it, an archived pipeline's quiet) over "v3 · who started it · when"
 * (14/20), and on the right its state's word (14/20, its colour) over how
 * long it took or has taken so far, ticking while live.
 */
@Composable
internal fun RunRow(run: PipelineRunListEntry, startedBy: String, now: Long, onOpen: ((String) -> Unit)?) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    val entry = run.run
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .fillMaxWidth()
            .testTag(PipelinesTags.run(run.id))
            .then(
                if (onOpen != null) Modifier.clickable(interactionSource = interaction, indication = ripple(color = colors.text), role = Role.Button) { onOpen(run.id) }
                else Modifier.semantics(mergeDescendants = true) {},
            )
            .defaultMinSize(minHeight = ItemSpec.minHeight)
            .padding(horizontal = ItemSpec.paddingHorizontal, vertical = ItemSpec.paddingVertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StateGlyph(entry.state)
        Spacer(Modifier.width(ItemSpec.iconGap))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (entry.parentRunId != null) {
                    Icon(
                        Ionicon.ReturnDownForwardOutline,
                        PipelinesSpec.childGlyph,
                        colors.textSecondary,
                        Modifier.padding(end = PipelinesSpec.childGap).testTag(PipelinesTags.child(run.id)),
                        contentDescription = stringResource(R.string.pipelines_child_run),
                    )
                }
                Text(
                    run.pipelineName,
                    style = ItemSpec.title,
                    color = if (run.pipelineArchived) colors.textSecondary else colors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            val facts = listOfNotNull(
                stringResource(R.string.pipelines_version, entry.version),
                stringResource(R.string.pipelines_archived).takeIf { run.pipelineArchived },
                startedBy,
                compactAgo(resources, entry.createdAt, now),
            )
            Text(facts.joinToString(" · "), style = ItemSpec.subtitle, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(ItemSpec.rightSectionGap))
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.Center) {
            Text(stateWords(entry.state), style = ItemSpec.subtitle, color = stateColor(entry.state), maxLines = 1, modifier = Modifier.testTag(PipelinesTags.runState(run.id)))
            entry.startedAt?.let { started ->
                Text(
                    durationText(resources, (entry.endedAt ?: now) - started),
                    style = ItemSpec.subtitle,
                    color = colors.textSecondary,
                    maxLines = 1,
                    modifier = Modifier.testTag(PipelinesTags.runDuration(run.id)),
                )
            }
        }
        if (onOpen != null) {
            Icon(Ionicon.ChevronForward, ItemSpec.chevronSize, colors.grouped.chevron, Modifier.padding(start = ItemSpec.chevronGap))
        }
    }
}
