package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.MarkdownSpec
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ui.UiComponent
import com.slopus.happy.conversation.ui.UiFileTree
import com.slopus.happy.ui.chat.MessageSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object UiTags {
    const val FILE_TREE = "conversation.ui.file_tree"
    const val FILE_TREE_MORE = "conversation.ui.file_tree.more"
    const val FALLBACK = "conversation.ui.fallback"
    const val REPLIES = "conversation.quick_replies"
    const val REPLY = "conversation.quick_replies.option"
    const val REPLY_TICK = "conversation.quick_replies.tick"
    const val SUGGESTED = "conversation.quick_replies.suggested"
}

/** Chat UI's measures, and quick replies', on the transcript's 16 column. */
object UiSpec {
    val gap = 8.dp
    /** Between quick replies, and their tick's size and gap from the words. */
    val replyGap = 6.dp
    val tick = 16.dp
    val tickGap = 8.dp
    val fieldMinHeight = 40.dp
    val fieldPaddingH = 12.dp
    val fieldPaddingV = 10.dp
    val fieldRadius = 10.dp
    val treeIndent = 16.dp
    val treeGlyph = 14.dp
    val treeGlyphGap = 6.dp
    /** Lines a file tree shows before "Show all". */
    const val TREE_LINES = 12
    /** Every control the person may not use now. */
    const val DIMMED_ALPHA = 0.48f

    val label = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val field = happyTextStyle(fontSize = 15, lineHeight = 20)
    val line = happyTextStyle(fontSize = 14, lineHeight = 20)
    val note = happyTextStyle(fontSize = 12, lineHeight = 16)
    val tree = happyTextStyle(fontSize = 13, lineHeight = 20, family = AppMono)
}

/**
 * One component of chat UI: `file_tree` drawn natively (`images` is a
 * media row), a live type from the server's state ([UiLiveRow]), any other
 * its fallback line. Spec: 16 in from the sides and 6 above and below, as
 * every row. A file tree is a surfaceHigh card (radius 12, padding 12) of
 * 13/20 mono lines, 16 in a level, a folder or document glyph 6 before each
 * name, at most twelve lines until "Show all". A fallback line is 14/20
 * textSecondary, an info mark 10 before it, in the same card.
 */
@Composable
fun UiComponentRow(row: ConversationRow.Ui, actions: ConversationRowActions, modifier: Modifier = Modifier) {
    // Tagged outside the row's own inset, so a tag measures the whole row.
    val inset = { tag: String ->
        modifier
            .testTag(tag)
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
    }
    when (val component = row.component) {
        is UiComponent.FileTree -> FileTreeView(row.key, component, inset(UiTags.FILE_TREE))
        is UiComponent.Images, is UiComponent.Other -> {
            val live = actions.uiLive
            when {
                live != null && UiLive.draws(component.type, live.team) -> UiLiveRow(row, live, actions, inset(UiLiveTags.FIGURE))
                component.fallback.isNotBlank() -> Fallback(component.fallback, inset(UiTags.FALLBACK))
            }
        }
    }
}

@Composable
private fun FileTreeView(key: String, tree: UiComponent.FileTree, modifier: Modifier) {
    val colors = HappyTheme.colors
    val lines = remember(tree.paths) { UiFileTree.lines(tree.paths) }
    var all by rememberSaveable(key) { mutableStateOf(false) }
    val shown = if (all) lines else lines.take(UiSpec.TREE_LINES)
    Column(
        modifier
            .background(colors.surfaceHigh, RoundedCornerShape(ConversationRowSpec.cardRadius))
            .padding(ConversationRowSpec.cardPadding),
    ) {
        for (line in shown) {
            Row(Modifier.padding(start = UiSpec.treeIndent * line.depth), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (line.folder) Ionicon.FolderOutline else Ionicon.DocumentOutline, UiSpec.treeGlyph, colors.textSecondary)
                Spacer(Modifier.width(UiSpec.treeGlyphGap))
                Text(line.name, style = UiSpec.tree, color = colors.text, maxLines = 1)
            }
        }
        if (lines.size > shown.size) {
            Text(
                stringResource(R.string.conversation_ui_tree_show_all, lines.size),
                style = UiSpec.label,
                color = colors.textLink,
                modifier = Modifier
                    .padding(top = 4.dp)
                    .testTag(UiTags.FILE_TREE_MORE)
                    .clickable(role = Role.Button) { all = true }
                    .padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun Fallback(text: String, modifier: Modifier) {
    val colors = HappyTheme.colors
    Row(
        modifier
            .background(colors.surfaceHigh, RoundedCornerShape(ConversationRowSpec.cardRadius))
            .padding(ConversationRowSpec.cardPadding),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.InformationCircleOutline, 18.dp, colors.textSecondary)
        Text(text, style = UiSpec.line, color = colors.textSecondary, modifier = Modifier.weight(1f))
    }
}

/**
 * Replies the agent suggested, under all it wrote in the turn and above how
 * the turn ended. Spec: on the 16 column, 6 above and below as every row,
 * one under another 6 apart; each as wide as a person's widest bubble
 * (the column less 16 a side), so all are one width against the right
 * edge, and drawn as that bubble: radius 12, 12 in, the words' 16/25 type
 * on one line (cut with an ellipsis) with the bubble's own 4 + 8 above and
 * 4 + 10 below, a one-line bubble's height. Unsent, a fill halfway from the
 * bubble's to the ground (`quickReplyBubble`), the words in text colour.
 * The option a person's message sent ([ConversationRow.Replies.chosen])
 * takes the bubble's own fill and hairline and a 16 tick 8 from the words
 * at the right, whose room every pill keeps, so nothing moves; the others
 * keep their fill, their words textSecondary. Each is a button; only the
 * newest stack takes a tap ([ConversationRow.Replies.live]), and none for a
 * person who can't write here.
 */
@Composable
fun QuickRepliesRow(row: ConversationRow.Replies, bubble: BubblePalette, actions: ConversationRowActions, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val send = actions.onQuickReply?.takeIf { row.live && actions.uiReplies() }
    val shape = RoundedCornerShape(MessageSpec.bubbleRadius)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val quiet = lerp(bubble.background, colors.surface, 0.5f)
    val quietBorder = lerp(bubble.border, colors.surface, 0.5f)
    Column(
        modifier
            .testTag(UiTags.REPLIES)
            .fillMaxWidth()
            .padding(horizontal = MessageSpec.userPaddingHorizontal, vertical = ConversationRowSpec.marginVertical),
        verticalArrangement = Arrangement.spacedBy(UiSpec.replyGap),
    ) {
        row.options.forEachIndexed { index, option ->
            val chosen = row.chosen == index
            Row(
                Modifier
                    .testTag(UiTags.REPLY)
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
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    option,
                    style = MarkdownSpec.text,
                    color = if (row.chosen == null || chosen) colors.text else colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(UiSpec.tickGap))
                Box(Modifier.size(UiSpec.tick), contentAlignment = Alignment.Center) {
                    if (chosen) Icon(Ionicon.Checkmark, UiSpec.tick, colors.text, Modifier.testTag(UiTags.REPLY_TICK))
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
        style = UiSpec.note,
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.End,
        maxLines = 1,
        modifier = Modifier
            .testTag(UiTags.SUGGESTED)
            .fillMaxWidth()
            .padding(horizontal = MessageSpec.userPaddingHorizontal)
            .padding(bottom = 4.dp),
    )
}
