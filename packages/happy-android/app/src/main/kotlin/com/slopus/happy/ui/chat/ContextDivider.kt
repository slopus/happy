package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ContextBoundary
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** [ContextDivider]'s numbers (Android's own; happy-app has no counterpart). */
object ContextDividerSpec {
    val marginHorizontal = 16.dp
    val paddingVertical = 8.dp
    /** The clear space between a line and the label. */
    val gap = 8.dp
    val label = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.Medium)
}

/** The divider's time: the device's own short time, as the usage-limit event's. */
fun formatBoundaryTime(createdAt: Long, locale: Locale = Locale.getDefault()): String =
    DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(Date(createdAt))

/**
 * Where a relay session's context ended: the CLI's completion event for
 * `/clear` or `/compact` ([ContextBoundary]) drawn as a line across the
 * chat on each side of "Context cleared · 14:32". Everything above the
 * divider is the context that was dropped.
 *
 * Spec (Android's own; happy-app and iOS draw the CLI's words as a centred
 * event line): the row is the chat column's full width, 16 in from both
 * sides and 8 above and below; a one-pixel line in the theme's divider colour
 * fills each side, 8 clear of the 13/18 medium label in the event grey
 * (agentEventText), everything vertically centred. TalkBack reads the row as
 * one line ("Context cleared at 14:32"); the lines are decoration.
 */
@Composable
fun ContextDivider(boundary: ContextBoundary, createdAt: Long, modifier: Modifier = Modifier) {
    // The app's language, not the device's, as LocalizedContent sets it.
    val locale = LocalConfiguration.current.locales[0]
    val time = remember(createdAt, locale) { formatBoundaryTime(createdAt, locale) }
    val label = when (boundary) {
        ContextBoundary.Cleared -> stringResource(R.string.message_context_cleared, time)
        ContextBoundary.Compacted -> stringResource(R.string.message_context_compacted, time)
    }
    val spoken = when (boundary) {
        ContextBoundary.Cleared -> stringResource(R.string.message_context_cleared_spoken, time)
        ContextBoundary.Compacted -> stringResource(R.string.message_context_compacted_spoken, time)
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = ContextDividerSpec.marginHorizontal)
            .testTag(MessageTags.CONTEXT_DIVIDER)
            .semantics(mergeDescendants = true) { contentDescription = spoken }
            .padding(vertical = ContextDividerSpec.paddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ContextDividerSpec.gap),
    ) {
        ContextDividerLine(Modifier.weight(1f).testTag(MessageTags.CONTEXT_DIVIDER_LINE_START))
        Text(
            text = label,
            modifier = Modifier.testTag(MessageTags.CONTEXT_DIVIDER_LABEL),
            style = ContextDividerSpec.label,
            color = ChatTheme.colors.agentEventText,
            textAlign = TextAlign.Center,
        )
        ContextDividerLine(Modifier.weight(1f).testTag(MessageTags.CONTEXT_DIVIDER_LINE_END))
    }
}

@Composable
private fun ContextDividerLine(modifier: Modifier) {
    Box(modifier.height(hairline()).background(HappyTheme.colors.divider))
}
