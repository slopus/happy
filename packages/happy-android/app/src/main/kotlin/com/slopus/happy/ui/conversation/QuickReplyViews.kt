package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.MarkdownSpec
import com.slopus.happy.ui.chat.MessageSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object QuickReplyTags {
    const val STACK = "conversation.quick_replies"
    const val OPTION = "conversation.quick_replies.option"
    const val TICK = "conversation.quick_replies.tick"
    const val SUGGESTED = "conversation.quick_replies.suggested"
}

/** Suggested replies' measures, on the transcript's 16 column. */
object QuickReplySpec {
    /** Between the options of a stack. */
    val gap = 6.dp
    /** The sent option's tick, and its gap from the words. */
    val tick = 16.dp
    val tickGap = 8.dp
    /** Lines an option's words take before they cut. */
    const val LINES = 2
    /** "Suggested reply" under a person's bubble. */
    val note = happyTextStyle(fontSize = 12, lineHeight = 16)
}

/**
 * Replies the agent suggested, under all it wrote in the turn and above how
 * the turn ended. They are the agent's output, so they stand at its words'
 * leading edge. Spec: on the 16 column, 6 above and below as every row, one
 * under another 6 apart, left-aligned; every pill one width, the widest
 * option's own (one intrinsic measure in the same pass as its height, so it
 * never relayouts): 12 in, the words (the person's 16/25 type), 8, then the
 * 16 tick; capped at the column less 16 a side, a person's widest bubble,
 * past which the words wrap to a second line and then cut with an ellipsis.
 * Each pill is as tall as its own words at that width, the tick on their
 * first line. Drawn as that bubble: radius 12, 4 + 8 above and 4 + 10 below.
 * Unsent, a fill halfway from the bubble's to the ground, the words in text
 * colour. The option a person's message sent ([ConversationRow.Replies.chosen])
 * takes the bubble's own fill and hairline and the tick, whose room every
 * pill keeps, so nothing moves; the others keep their fill, their words grey
 * (`input.placeholder`: textSecondary is too near black to tell apart at a
 * glance). Each is a button; only the newest stack takes a tap
 * ([ConversationRow.Replies.live]), and none for a person who can't write
 * here.
 */
@Composable
fun QuickRepliesRow(row: ConversationRow.Replies, bubble: BubblePalette, actions: UiRowActions?, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val send = actions?.reply?.takeIf { row.live && actions.replies() }
    val shape = RoundedCornerShape(MessageSpec.bubbleRadius)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val line = with(LocalDensity.current) { MarkdownSpec.text.lineHeight.toDp() }
    val quiet = lerp(bubble.background, colors.surface, 0.5f)
    val quietBorder = lerp(bubble.border, colors.surface, 0.5f)
    Box(
        modifier
            .testTag(QuickReplyTags.STACK)
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical),
    ) {
        Column(Modifier.width(IntrinsicSize.Max), verticalArrangement = Arrangement.spacedBy(QuickReplySpec.gap)) {
            row.options.forEachIndexed { index, option ->
                val chosen = row.chosen == index
                Row(
                    Modifier
                        .testTag(QuickReplyTags.OPTION)
                        .fillMaxWidth()
                        .clip(shape)
                        .background(if (chosen) bubble.background else quiet)
                        .border(hairline, if (chosen) bubble.border else quietBorder, shape)
                        .clickable(enabled = send != null, role = Role.Button) { send?.invoke(row, index) }
                        .semantics { selected = chosen }
                        .padding(
                            start = MessageSpec.bubblePaddingHorizontal,
                            end = MessageSpec.bubblePaddingHorizontal,
                            top = MessageSpec.bubblePaddingVertical + MarkdownSpec.textMarginTop,
                            bottom = MessageSpec.bubblePaddingVertical + MarkdownSpec.textMarginBottom,
                        ),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        option,
                        style = MarkdownSpec.text,
                        color = if (row.chosen == null || chosen) colors.text else colors.input.placeholder,
                        maxLines = QuickReplySpec.LINES,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(QuickReplySpec.tickGap))
                    Box(Modifier.height(line).width(QuickReplySpec.tick), contentAlignment = Alignment.Center) {
                        if (chosen) Icon(Ionicon.Checkmark, QuickReplySpec.tick, colors.text, Modifier.testTag(QuickReplyTags.TICK))
                    }
                }
            }
        }
    }
}

/**
 * Under a person's bubble sent from a suggested reply: "↩ Suggested reply"
 * (12/16 textSecondary) against the right edge, 16 in, 4 under the bubble's
 * own foot.
 */
@Composable
internal fun SuggestedLine() {
    Text(
        stringResource(R.string.conversation_quick_reply),
        style = QuickReplySpec.note,
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.End,
        maxLines = 1,
        modifier = Modifier
            .testTag(QuickReplyTags.SUGGESTED)
            .fillMaxWidth()
            .padding(horizontal = MessageSpec.userPaddingHorizontal)
            .padding(bottom = 4.dp),
    )
}
