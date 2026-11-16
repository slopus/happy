package com.slopus.happy.ui.pipelines

import android.content.res.Resources
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelineNodeState
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.PageProgressIndicator
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.theme.HappyTheme
import java.util.Locale

/** What a node's state is called (desktop's `PIPELINE_NODE_STATE_LABEL`). */
@Composable
internal fun nodeStateWords(state: PipelineNodeState): String = stringResource(
    when (state) {
        PipelineNodeState.Pending -> R.string.pipelines_node_waiting
        PipelineNodeState.Running -> R.string.pipelines_state_running
        PipelineNodeState.Succeeded -> R.string.pipelines_state_succeeded
        PipelineNodeState.Failed -> R.string.pipelines_state_failed
        PipelineNodeState.Skipped -> R.string.pipelines_node_skipped
        PipelineNodeState.Aborted -> R.string.pipelines_state_aborted
    },
)

/** A run's tones on a node: running blue, succeeded green, failed red, the rest quiet. */
@Composable
internal fun nodeStateColor(state: PipelineNodeState): Color {
    val colors = HappyTheme.colors
    return when (state) {
        PipelineNodeState.Running -> RowTile.Blue.ink(colors.dark)
        PipelineNodeState.Succeeded -> colors.success
        PipelineNodeState.Failed -> colors.textDestructive
        PipelineNodeState.Pending, PipelineNodeState.Skipped, PipelineNodeState.Aborted -> colors.textSecondary
    }
}

/** A node's state as a glyph in the 32 icon slot, as [StateGlyph] draws a run's; null for a node the run never reached. */
@Composable
internal fun NodeStateGlyph(state: PipelineNodeState?, modifier: Modifier = Modifier) {
    val color = if (state == null) HappyTheme.colors.textSecondary else nodeStateColor(state)
    Box(modifier.size(ItemSpec.iconSize), contentAlignment = Alignment.Center) {
        when (state) {
            PipelineNodeState.Running -> PageProgressIndicator(Modifier.size(PipelinesSpec.spinner), color = color, strokeWidth = 2.dp)
            PipelineNodeState.Pending, null -> Icon(Ionicon.EllipseOutline, PipelinesSpec.stateGlyph, color)
            PipelineNodeState.Succeeded -> Icon(Ionicon.CheckmarkCircle, PipelinesSpec.stateGlyph, color)
            PipelineNodeState.Failed -> Icon(Ionicon.CloseCircle, PipelinesSpec.stateGlyph, color)
            PipelineNodeState.Skipped -> Icon(Ionicon.RemoveCircleOutline, PipelinesSpec.stateGlyph, color)
            PipelineNodeState.Aborted -> Icon(Ionicon.StopCircle, PipelinesSpec.stateGlyph, color)
        }
    }
}

/** What kind of step a node is: "Code", "Agent · openai/gpt-6.1", "Runs Run tests" (desktop's `pipelineNodeSummary`). */
@Composable
internal fun nodeKindWords(kind: PipelineNodeKind, definition: PipelineNodeDefinition?, pipelineName: (String) -> String): String = when (kind) {
    PipelineNodeKind.Code -> stringResource(R.string.pipelines_kind_code)
    PipelineNodeKind.Agent -> definition?.model?.let { stringResource(R.string.pipelines_kind_agent_model, it) } ?: stringResource(R.string.pipelines_kind_agent)
    PipelineNodeKind.Pipeline -> definition?.pipelineId?.let { stringResource(R.string.pipelines_kind_pipeline, pipelineName(it)) } ?: stringResource(R.string.pipelines_kind_pipeline_any)
}

/**
 * A failure code in words (desktop's `pipelineFailureTitle`). An agent node
 * may fail with a code of its own, which reads as its words: `tests_failed`
 * is "Tests failed".
 */
internal fun failureTitle(resources: Resources, code: String): String {
    val known = when (code) {
        "exception" -> R.string.pipelines_failure_exception
        "type_error" -> R.string.pipelines_failure_type_error
        "invalid_output" -> R.string.pipelines_failure_invalid_output
        "output_too_large" -> R.string.pipelines_failure_output_too_large
        "timeout" -> R.string.pipelines_failure_timeout
        "compute_unavailable" -> R.string.pipelines_failure_compute_unavailable
        "permission_denied" -> R.string.pipelines_failure_permission_denied
        "unsupported" -> R.string.pipelines_failure_unsupported
        "internal_error" -> R.string.pipelines_failure_internal_error
        "no_output" -> R.string.pipelines_failure_no_output
        "agent_error" -> R.string.pipelines_failure_agent_error
        "model_unavailable" -> R.string.pipelines_failure_model_unavailable
        "child_failed" -> R.string.pipelines_failure_child_failed
        "child_aborted" -> R.string.pipelines_failure_child_aborted
        "child_superseded" -> R.string.pipelines_failure_child_superseded
        "child_unavailable" -> R.string.pipelines_failure_child_unavailable
        "cycle" -> R.string.pipelines_failure_cycle
        "too_deep" -> R.string.pipelines_failure_too_deep
        else -> null
    }
    if (known != null) return resources.getString(known)
    val words = code.replace('_', ' ').trim()
    return if (words.isEmpty()) resources.getString(R.string.pipelines_state_failed) else words.replaceFirstChar { it.titlecase(Locale.getDefault()) }
}

/** A token count at a glance: `840`, `12.4k`, `3.1M` (desktop's `pipelineTokensText`). */
internal fun tokensText(count: Long): String = when {
    count < 1_000 -> count.toString()
    count < 1_000_000 -> String.format(Locale.US, if (count < 10_000) "%.1fk" else "%.0fk", count / 1_000.0)
    else -> String.format(Locale.US, "%.1fM", count / 1_000_000.0)
}

/** US dollars to the cent, and a hint below a cent (desktop's `pipelineCostText`). */
internal fun costText(usd: Double): String = when {
    usd == 0.0 -> "$0.00"
    usd < 0.01 -> "< $0.01"
    else -> String.format(Locale.US, "$%.2f", usd)
}

/** How long a command or tool call took: "840ms" under a second, else as [durationText]. */
internal fun shortDurationText(resources: Resources, millis: Long): String =
    if (millis < 1_000) resources.getString(R.string.pipelines_duration_ms, millis.toInt()) else durationText(resources, millis)

/** A status line with how far along it is, when it said: "Building · 42%". */
internal fun progressText(resources: Resources, text: String, progress: Float?): String =
    if (progress == null) text else resources.getString(R.string.pipelines_progress, text, Math.round(progress * 100))
