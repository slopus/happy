package com.slopus.happy.ui.usage

import android.text.format.DateFormat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ContextUsage
import com.slopus.happy.chat.UsageLimits
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuDivider
import com.slopus.happy.ui.components.MenuGroup
import com.slopus.happy.ui.components.MenuOption
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.components.SettingsMenu
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.usage.ContextLevel
import com.slopus.happy.usage.ContextStatus
import com.slopus.happy.usage.UsagePopupRow
import com.slopus.happy.usage.UsageRowState
import com.slopus.happy.usage.formatTokenCount
import com.slopus.happy.usage.formatUsageLimitResetTime
import com.slopus.happy.usage.usageRowState

object UsageRowTags {
    const val ROW = "usage.row"
    const val CONTEXT = "usage.context"
    const val CONTEXT_TEXT = "usage.context.text"
    const val CONTEXT_DETAIL = "usage.context.detail"
    const val CONTEXT_PERCENT_LEFT = "usage.context.detail.left"
    const val CONTEXT_TOKENS = "usage.context.detail.tokens"
    const val GAUGE = "usage.gauge"
    const val WEEK = "usage.week"

    fun contextDetail(key: String) = "usage.context.detail.$key"
}

/** AgentInput.tsx `AgentInputUsageRow` and `ContextGaugeIcon`. */
object UsageRowSpec {
    val gap = 10.dp
    val contextGap = 5.dp
    val text = happyTextStyle(fontSize = 11)
    val gauge = 14.dp
    val gaugeStroke = 2.5.dp
    val detailTitle = happyTextStyle(fontSize = 20, lineHeight = 26)
    val detailRow = happyTextStyle(fontSize = 14, lineHeight = 20)
}

/** The settings the row reads: `alwaysShowContextSize` and `usageLimitShowRemaining`. */
@Immutable
data class UsageDisplay(val alwaysShowContextSize: Boolean = true, val showRemaining: Boolean = false)

/** Provided by the chat route from the account's settings. */
val LocalUsageDisplay = staticCompositionLocalOf { UsageDisplay() }

/** The usage row for a session's context usage and plan limits, with the settings from [LocalUsageDisplay]. */
@Composable
fun ComposerUsageRow(usage: ContextUsage?, limits: UsageLimits?, modifier: Modifier = Modifier) {
    val display = LocalUsageDisplay.current
    val state = remember(usage, limits, display) { usageRowState(usage, limits, display.alwaysShowContextSize, display.showRemaining) }
    ComposerUsageRow(state, usage, modifier)
}

/**
 * AgentInputUsageRow's right-hand cluster: items 10 apart, all 11pt. First
 * "N% week" in textSecondary (tap for the Session/Week popup with their
 * resets), then "N% context" in the status colour 5 before the 14 gauge
 * ring; with no window yet it reads "N tokens" instead of a percentage.
 * Tapping the context opens its detail popup: percent left, used / window,
 * the token breakdown and the model when the producer names it. Nothing
 * at all when neither shows. Its place (right end of the row above the
 * composer) is [com.slopus.happy.ui.chat.ComposerInfoRow]'s.
 */
@Composable
fun ComposerUsageRow(state: UsageRowState, usage: ContextUsage?, modifier: Modifier = Modifier) {
    if (state.isEmpty) return
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(UsageRowSpec.gap, Alignment.End),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        state.weekPercent?.let { percent -> WeekUsage(percent, state.popup) }
        state.context?.let { context -> ContextUsageIndicator(context, usage) }
    }
}

/** The context gauge and its tap-open details; the ring is empty while the window is unknown. */
@Composable
private fun ContextUsageIndicator(status: ContextStatus, usage: ContextUsage?) {
    val colors = HappyTheme.colors
    val color = when (status.level) {
        ContextLevel.Critical -> colors.warningCritical
        ContextLevel.Warning -> colors.warning
        ContextLevel.Normal -> colors.textSecondary
    }
    var details by remember { mutableStateOf(false) }
    Box {
        Row(
            modifier = Modifier
                .testTag(UsageRowTags.CONTEXT)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { details = true },
            horizontalArrangement = Arrangement.spacedBy(UsageRowSpec.contextGap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                status.percent?.let { stringResource(R.string.agent_input_context_percent_context, it) }
                    ?: stringResource(R.string.usage_context_tokens_only, status.used),
                style = UsageRowSpec.text,
                color = color,
                modifier = Modifier.testTag(UsageRowTags.CONTEXT_TEXT),
            )
            ContextGauge(status.percent ?: 0)
        }
        usage?.let {
            HappyDropdownMenu(expanded = details, onDismissRequest = { details = false }) {
                ContextUsageDetail(status, it)
            }
        }
    }
}

/** The context popup: percent left, "used / window", the token breakdown, and the model when known. */
@Composable
private fun ContextUsageDetail(status: ContextStatus, usage: ContextUsage) {
    val colors = HappyTheme.colors
    Column(
        modifier = Modifier
            .testTag(UsageRowTags.CONTEXT_DETAIL)
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(stringResource(R.string.usage_context_title), style = MenuSpec.sectionTitle, color = colors.textSecondary)
        status.percent?.let { percent ->
            Text(
                stringResource(R.string.usage_left, 100 - percent),
                style = UsageRowSpec.detailTitle,
                color = colors.text,
                modifier = Modifier.testTag(UsageRowTags.CONTEXT_PERCENT_LEFT),
            )
        }
        Text(
            status.total?.let { stringResource(R.string.agent_input_context_detail_context, status.used, it) }
                ?: stringResource(R.string.usage_context_tokens_only, status.used),
            style = MenuSpec.supporting,
            color = colors.textSecondary,
            modifier = Modifier.testTag(UsageRowTags.CONTEXT_TOKENS),
        )
        if (status.total == null) {
            Text(stringResource(R.string.usage_context_window_unknown), style = MenuSpec.supporting, color = colors.textSecondary)
        }
        HappyMenuDivider()
        ContextDetailRow(stringResource(R.string.usage_context_input), formatTokenCount(usage.inputTokens.toDouble()), "input")
        ContextDetailRow(stringResource(R.string.usage_context_cache_read), formatTokenCount(usage.cacheRead.toDouble()), "cacheRead")
        ContextDetailRow(stringResource(R.string.usage_context_cache_write), formatTokenCount(usage.cacheCreation.toDouble()), "cacheCreation")
        ContextDetailRow(stringResource(R.string.usage_context_output), formatTokenCount(usage.outputTokens.toDouble()), "output")
        usage.model?.let { ContextDetailRow(stringResource(R.string.usage_context_model), it, "model") }
    }
}

@Composable
private fun ContextDetailRow(label: String, value: String, key: String) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .testTag(UsageRowTags.contextDetail(key))
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = UsageRowSpec.detailRow, color = colors.textSecondary)
        Text(value, style = UsageRowSpec.detailRow, color = colors.text)
    }
}

@Composable
private fun WeekUsage(percent: Int, popup: List<UsagePopupRow>) {
    val text = @Composable {
        Text(
            stringResource(R.string.agent_input_context_percent_week, percent),
            style = UsageRowSpec.text,
            color = HappyTheme.colors.textSecondary,
            modifier = Modifier.testTag(UsageRowTags.WEEK),
        )
    }
    if (popup.isEmpty()) {
        text()
        return
    }
    var expanded by remember { mutableStateOf(false) }
    val options = popup.map { row -> MenuOption(row.key, usagePopupLabel(row)) }
    SettingsMenu(
        groups = listOf(MenuGroup("usage", "", options, selectedKey = null, onSelect = {})),
        expanded = expanded,
        onDismiss = { expanded = false },
        modifier = Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { expanded = true },
        trigger = text,
    )
}

/** "Session · 32%", and on a second line "Resets 6:00 PM" when the window says when. */
@Composable
private fun usagePopupLabel(row: UsagePopupRow): String {
    val name = stringResource(if (row.key == "session") R.string.agent_input_usage_popup_session else R.string.agent_input_usage_popup_week)
    val reset = row.resetsAt?.let { stringResource(R.string.agent_input_usage_popup_resets, resetTime(it)) }
    return "$name · ${row.percent}%" + (reset?.let { "\n$it" } ?: "")
}

@Composable
private fun resetTime(ms: Double): String {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val time = DateFormat.getBestDateTimePattern(locale, if (DateFormat.is24HourFormat(context)) "HHmm" else "hhmma")
    val date = DateFormat.getBestDateTimePattern(locale, "MMMd")
    return formatUsageLimitResetTime(ms, System.currentTimeMillis(), time, date, locale)
}

/**
 * ContextGaugeIcon: a 14 ring, stroke 2.5, on a divider-coloured track;
 * the used share is drawn from the top clockwise with round caps, black
 * (white in dark) at 35% opacity rising to 100% as it fills.
 */
@Composable
fun ContextGauge(percent: Int, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val progress = percent.coerceIn(0, 100) / 100f
    val ink = (if (colors.dark) Color.White else Color.Black).copy(alpha = 0.35f + 0.65f * progress)
    Canvas(modifier.testTag(UsageRowTags.GAUGE).size(UsageRowSpec.gauge)) {
        val stroke = UsageRowSpec.gaugeStroke.toPx()
        val inset = stroke / 2
        val arcSize = Size(size.width - stroke, size.height - stroke)
        drawArc(colors.divider, 0f, 360f, useCenter = false, topLeft = Offset(inset, inset), size = arcSize, style = Stroke(stroke))
        if (progress > 0f) {
            drawArc(ink, -90f, 360f * progress, useCenter = false, topLeft = Offset(inset, inset), size = arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
        }
    }
}
