package com.slopus.happy.ui.usage

import android.text.format.DateFormat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.slopus.happy.ui.components.MenuGroup
import com.slopus.happy.ui.components.MenuOption
import com.slopus.happy.ui.components.SettingsMenu
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.usage.ContextLevel
import com.slopus.happy.usage.UsagePopupRow
import com.slopus.happy.usage.UsageRowState
import com.slopus.happy.usage.formatUsageLimitResetTime
import com.slopus.happy.usage.usageRowState

object UsageRowTags {
    const val ROW = "usage.row"
    const val CONTEXT = "usage.context"
    const val CONTEXT_TEXT = "usage.context.text"
    const val GAUGE = "usage.gauge"
    const val WEEK = "usage.week"
}

/** AgentInput.tsx `AgentInputUsageRow` and `ContextGaugeIcon`. */
object UsageRowSpec {
    /** 10 shell inset + 8 action inset: the gauge lines up with the effort label's right edge. */
    val paddingHorizontal = 18.dp
    val paddingTop = 6.dp
    val minHeight = 18.dp
    val gap = 10.dp
    val contextGap = 5.dp
    val text = happyTextStyle(fontSize = 11)
    val gauge = 14.dp
    val gaugeStroke = 2.5.dp
}

/** The settings the row reads: `alwaysShowContextSize` and `usageLimitShowRemaining`. */
@Immutable
data class UsageDisplay(val alwaysShowContextSize: Boolean = false, val showRemaining: Boolean = false)

/** Provided by the chat route from the account's settings. */
val LocalUsageDisplay = staticCompositionLocalOf { UsageDisplay() }

/** The usage row for a session's context usage and plan limits, with the settings from [LocalUsageDisplay]. */
@Composable
fun ComposerUsageRow(usage: ContextUsage?, limits: UsageLimits?, modifier: Modifier = Modifier) {
    val display = LocalUsageDisplay.current
    val state = remember(usage, limits, display) { usageRowState(usage, limits, display.alwaysShowContextSize, display.showRemaining) }
    ComposerUsageRow(state, modifier)
}

/**
 * AgentInputUsageRow: under the composer card, right-aligned, 18 in and 6
 * below the card, at least 18 high, items 10 apart, all 11pt. First
 * "N% week" in textSecondary (tap for the Session/Week popup with their
 * resets), then "N% context" in the status colour 5 before the 14 gauge
 * ring; tapping it swaps the percent for "used / total context". Nothing
 * at all when neither shows.
 */
@Composable
fun ComposerUsageRow(state: UsageRowState, modifier: Modifier = Modifier) {
    if (state.isEmpty) return
    val colors = HappyTheme.colors
    var precise by rememberSaveable { mutableStateOf(false) }
    Row(
        modifier = modifier
            .testTag(UsageRowTags.ROW)
            .fillMaxWidth()
            .defaultMinSize(minHeight = UsageRowSpec.minHeight)
            .padding(horizontal = UsageRowSpec.paddingHorizontal)
            .padding(top = UsageRowSpec.paddingTop),
        horizontalArrangement = Arrangement.spacedBy(UsageRowSpec.gap, Alignment.End),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        state.weekPercent?.let { percent -> WeekUsage(percent, state.popup) }
        state.context?.let { context ->
            val color = when (context.level) {
                ContextLevel.Critical -> colors.warningCritical
                ContextLevel.Warning -> colors.warning
                ContextLevel.Normal -> colors.textSecondary
            }
            Row(
                modifier = Modifier
                    .testTag(UsageRowTags.CONTEXT)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { precise = !precise },
                horizontalArrangement = Arrangement.spacedBy(UsageRowSpec.contextGap),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (precise) {
                        stringResource(R.string.agent_input_context_detail_context, context.used, context.total)
                    } else {
                        stringResource(R.string.agent_input_context_percent_context, context.percent)
                    },
                    style = UsageRowSpec.text,
                    color = color,
                    modifier = Modifier.testTag(UsageRowTags.CONTEXT_TEXT),
                )
                ContextGauge(context.percent)
            }
        }
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
