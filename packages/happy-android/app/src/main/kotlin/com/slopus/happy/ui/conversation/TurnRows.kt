package com.slopus.happy.ui.conversation

import android.content.ClipData
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.home.gitAddedColor
import com.slopus.happy.ui.home.gitRemovedColor
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

object TurnRowTags {
    const val TOOL = "conversation.tool"
    const val TOOL_VERB = "conversation.tool.verb"
    const val TOOL_SUBJECT = "conversation.tool.subject"
    const val TOOL_GLYPH = "conversation.tool.glyph"
    const val TOOL_ADDED = "conversation.tool.added"
    const val TOOL_DELETED = "conversation.tool.deleted"
    const val TURN_END = "conversation.turnEnd"
    const val TURN_END_LABEL = "conversation.turnEnd.label"
    const val TURN_END_COPY = "conversation.turnEnd.copy"
    const val TRACE = "conversation.trace"
    const val TRACE_TITLE = "conversation.trace.title"
}

/**
 * A turn's own rows as desktop draws them (iOS TurnLayouts.swift).
 *
 * A tool call's line (`AgentToolActivity`): 6 above and below a 20 line,
 * 16 in; a 14 lane for its 12 glyph (a spinner while it runs, Octicons'
 * alert once it failed), then 6 apart the 14/20 medium verb at its width
 * and the subject in what is left, 14/20, or 13/20 mono for a command,
 * terminal input or file. A file edit's subject takes only its width, its
 * 12/20 mono counts 6 after it and 6 apart. textSecondary, or
 * [failedInk] when the call failed. A long press copies the subject.
 *
 * What a call showed (media, an artifact) goes [resultGap] under its line.
 *
 * How the turn ended (`TurnSummary`): a 24 line of 16 type, centred in a
 * row 32 tall (36 with 4 above it after a step); the copy button leads it,
 * a 20 square 2 out from the column so its 16 glyph sits on it, 8 before
 * the words, and turns into a check for 2 s once copied.
 *
 * The fold control (`agent-trace-row`): 11/16 mono "View traces" /
 * "Hide traces", a 2 dot and the tool count 6 apart, 8 under what is
 * above it; a finger 10 past the line still opens it.
 */
object TurnRowSpec {
    val margin = 16.dp
    val paddingV = 6.dp
    val lineHeight = 20.dp
    val lane = 14.dp
    val glyph = 12.dp
    val gap = 6.dp
    val resultGap = 8.dp
    val verb = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.Medium)
    val subject = happyTextStyle(fontSize = 14, lineHeight = 20)
    val subjectMono = happyTextStyle(fontSize = 13, lineHeight = 20, family = FontFamily.Monospace)
    val count = happyTextStyle(fontSize = 12, lineHeight = 20, family = FontFamily.Monospace)

    val endHeight = 32.dp
    val endAfterStep = 4.dp
    val endLine = 24.dp
    val endButton = 20.dp
    val endButtonOutset = 2.dp
    val endGlyph = 16.dp
    val endGap = 8.dp
    val endLabel = happyTextStyle(fontSize = 16, lineHeight = 24)
    const val COPIED_MILLIS = 2_000L

    val traceTop = 8.dp
    val traceLine = 16.dp
    val traceDot = 2.dp
    val traceReach = 10.dp
    val traceMeta = happyTextStyle(fontSize = 11, lineHeight = 16, family = FontFamily.Monospace)

    /** `--activity-failed-line`: 40% `--status-error` into `--text`. */
    fun failedInk(colors: HappyColors) = if (colors.dark) Color(0xFFFFB5B0) else Color(0xFF661812)

    /** `--input-placeholder`, the trace's dot. */
    fun dot(colors: HappyColors) = colors.input.placeholder
}

/**
 * A tool call's one line: its mark, or a spinner while it runs, its verb
 * and its subject (a builtin summary starts directly after the glyph lane). [bottom] is what it keeps under itself: its own 6, or
 * less where what it showed follows. A tap opens the call ([onOpen], its
 * own screen), running or done; a long press copies the subject.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ToolLine(tool: ToolUse, modifier: Modifier = Modifier, bottom: Dp = TurnRowSpec.paddingV, onOpen: (() -> Unit)? = null) {
    val colors = HappyTheme.colors
    val res = LocalContext.current.resources
    val words = remember(tool, res) { ToolWords.of(tool, res) }
    val ink = if (tool.failed) TurnRowSpec.failedInk(colors) else colors.textSecondary
    val spoken = if (tool.running) {
        stringResource(R.string.turn_is_running, ToolWords.humanize(tool.name, res)) + ", " + words.subject
    } else if (words.verb.isEmpty()) {
        if (tool.failed) stringResource(R.string.turn_failed_call) + ", " + words.subject else words.subject
    } else {
        "${words.verb} ${words.subject}"
    }
    val clipboard = LocalClipboard.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val copies = words.subject.isNotEmpty()
    val openLabel = stringResource(R.string.tool_open)
    Row(
        modifier
            .fillMaxWidth()
            .then(
                // A long press copies what scrolled out of the line.
                if (copies || onOpen != null) {
                    Modifier.combinedClickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = if (onOpen != null) ripple() else null,
                        role = if (onOpen != null) Role.Button else null,
                        onClickLabel = openLabel.takeIf { onOpen != null },
                        onClick = { onOpen?.invoke() },
                        onLongClick = if (copies) {
                            {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(words.subject, words.subject))) }
                            }
                        } else {
                            null
                        },
                    )
                } else {
                    Modifier
                },
            )
            .padding(start = TurnRowSpec.margin, end = TurnRowSpec.margin, top = TurnRowSpec.paddingV, bottom = bottom)
            .height(TurnRowSpec.lineHeight)
            .semantics(mergeDescendants = true) { contentDescription = spoken }
            .testTag(TurnRowTags.TOOL),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(TurnRowSpec.lane).testTag(TurnRowTags.TOOL_GLYPH), contentAlignment = Alignment.Center) {
            if (tool.running) {
                // Desktop's 12 circle spinner in the glyph's lane.
                CircularProgressIndicator(Modifier.size(TurnRowSpec.glyph), color = colors.textSecondary, strokeWidth = 1.5.dp)
            } else {
                when (val glyph = words.glyph) {
                    is ToolGlyph.Ion -> Icon(glyph.icon, TurnRowSpec.glyph, ink)
                    is ToolGlyph.Oct -> Icon(glyph.icon, TurnRowSpec.glyph, ink)
                }
            }
        }
        Spacer(Modifier.width(TurnRowSpec.gap))
        if (words.verb.isNotEmpty()) {
            Text(words.verb, style = TurnRowSpec.verb, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(TurnRowTags.TOOL_VERB))
            Spacer(Modifier.width(TurnRowSpec.gap))
        }
        val counted = words.added != null || words.deleted != null
        Text(
            words.subject,
            style = if (words.mono) TurnRowSpec.subjectMono else TurnRowSpec.subject,
            color = ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = !counted).testTag(TurnRowTags.TOOL_SUBJECT),
        )
        words.added?.let {
            Spacer(Modifier.width(TurnRowSpec.gap))
            Text("+${ToolWords.compact(it)}", style = TurnRowSpec.count, color = gitAddedColor(colors), maxLines = 1, modifier = Modifier.testTag(TurnRowTags.TOOL_ADDED))
        }
        words.deleted?.let {
            Spacer(Modifier.width(TurnRowSpec.gap))
            Text("\u2212${ToolWords.compact(it)}", style = TurnRowSpec.count, color = gitRemovedColor(colors), maxLines = 1, modifier = Modifier.testTag(TurnRowTags.TOOL_DELETED))
        }
    }
}

/** How a finished turn ended: "Completed in 12s", led by a copy of its final answer when it completed. */
@Composable
fun TurnEndRow(row: ConversationRow.TurnEnd, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val res = LocalContext.current.resources
    val label = remember(row, res) { turnLabel(row, res) }
    val copyText = row.copyText?.takeIf { row.complete }
    var copied by remember(row.key) { mutableStateOf(false) }
    if (copied) LaunchedEffect(Unit) {
        delay(TurnRowSpec.COPIED_MILLIS)
        copied = false
    }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val copyLabel = stringResource(if (copied) R.string.turn_final_copied else R.string.turn_copy_final)
    Row(
        modifier
            .fillMaxWidth()
            .padding(top = if (row.afterStep) TurnRowSpec.endAfterStep else 0.dp)
            .height(TurnRowSpec.endHeight)
            .padding(start = TurnRowSpec.margin - if (copyText != null) TurnRowSpec.endButtonOutset else 0.dp, end = TurnRowSpec.margin)
            .testTag(TurnRowTags.TURN_END),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (copyText != null) {
            Box(
                Modifier
                    .size(TurnRowSpec.endButton)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        role = Role.Button,
                        onClickLabel = copyLabel,
                    ) {
                        scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(copyText, copyText))) }
                        copied = true
                    }
                    .clearAndSetSemantics {
                        contentDescription = copyLabel
                        role = Role.Button
                        testTag = TurnRowTags.TURN_END_COPY
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (copied) Ionicon.CheckmarkOutline else Ionicon.CopyOutline, TurnRowSpec.endGlyph, if (copied) colors.success else colors.textSecondary)
            }
            Spacer(Modifier.width(TurnRowSpec.endGap))
        }
        Text(label, style = TurnRowSpec.endLabel, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(TurnRowTags.TURN_END_LABEL))
    }
}

/** A finished turn's fold control: "View traces · 3 tools", or "Hide traces" once open. */
@Composable
fun TraceRow(row: ConversationRow.Trace, onToggle: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val title = stringResource(if (row.open) R.string.turn_hide_traces else R.string.turn_view_traces)
    val stats = if (row.tools > 0) pluralStringResource(R.plurals.turn_tools, row.tools, row.tools) else null
    Box(modifier.fillMaxWidth().testTag(TurnRowTags.TRACE).padding(top = TurnRowSpec.traceTop)) {
        Row(
            Modifier
                .padding(start = TurnRowSpec.margin, end = TurnRowSpec.margin)
                // A finger [TurnRowSpec.traceReach] past the line still opens it; the row is only the line's height.
                .layout { measurable, constraints ->
                    val reach = TurnRowSpec.traceReach.roundToPx()
                    val placeable = measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
                    layout(placeable.width, (placeable.height - 2 * reach).coerceAtLeast(0)) { placeable.place(0, -reach) }
                }
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    role = Role.Button,
                ) { onToggle(row.turn) }
                .semantics { contentDescription = listOfNotNull(title, stats).joinToString(", ") }
                .padding(vertical = TurnRowSpec.traceReach)
                .height(TurnRowSpec.traceLine),
            horizontalArrangement = Arrangement.spacedBy(TurnRowSpec.gap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = TurnRowSpec.traceMeta, color = colors.textSecondary, maxLines = 1, modifier = Modifier.testTag(TurnRowTags.TRACE_TITLE))
            if (stats != null) {
                Box(Modifier.size(TurnRowSpec.traceDot).background(TurnRowSpec.dot(colors), CircleShape))
                Text(stats, style = TurnRowSpec.traceMeta, color = colors.textSecondary, maxLines = 1)
            }
        }
    }
}
