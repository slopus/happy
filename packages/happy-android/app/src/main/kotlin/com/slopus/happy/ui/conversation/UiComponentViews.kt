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
    const val SUGGESTED = "conversation.quick_replies.suggested"
}

/** Chat UI's measures, and quick replies', on the transcript's 16 column. */
object UiSpec {
    val gap = 8.dp
    val pillHeight = 36.dp
    val pillPaddingH = 14.dp
    val pillGlyph = 16.dp
    val pillGlyphGap = 6.dp
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

    val pill = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.Medium)
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
private fun Pill(label: String, primary: Boolean, enabled: Boolean, alpha: Float, checked: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(UiSpec.pillHeight / 2)
    val fill = if (primary) colors.button.primaryBackground else colors.surfaceHigh
    val ink = if (primary) colors.button.primaryTint else colors.text
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Row(
        modifier
            .alpha(alpha)
            .heightIn(min = UiSpec.pillHeight)
            .background(fill, shape)
            .then(if (primary) Modifier else Modifier.border(hairline, colors.divider, shape))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = UiSpec.pillPaddingH),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (checked) {
            Icon(Ionicon.Checkmark, UiSpec.pillGlyph, ink)
            Spacer(Modifier.width(UiSpec.pillGlyphGap))
        }
        Text(label, style = UiSpec.pill, color = ink, textAlign = TextAlign.Center)
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
 * Replies the agent suggested, under its latest message: 36 high pills, 8
 * apart and wrapping, on the 16 column, in surfaceHigh with a hairline
 * (14/20 medium, text). A tap sends the option at once. Where nothing can
 * be sent here, none shows.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuickRepliesRow(row: ConversationRow.Replies, actions: ConversationRowActions, modifier: Modifier = Modifier) {
    val send = actions.onQuickReply ?: return
    if (!actions.uiReplies()) return
    FlowRow(
        modifier
            .testTag(UiTags.REPLIES)
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical),
        horizontalArrangement = Arrangement.spacedBy(UiSpec.gap),
        verticalArrangement = Arrangement.spacedBy(UiSpec.gap),
    ) {
        row.options.forEachIndexed { index, option ->
            Pill(option, primary = false, enabled = true, alpha = 1f, checked = false, modifier = Modifier.testTag(UiTags.REPLY)) { send(row, index) }
        }
    }
}

/**
 * Over a person's bubble sent from a suggested reply: "↩ Suggested by
 * {agent}" (12/16 textSecondary) against the right edge, 16 in, 6 above
 * the bubble's own top.
 */
@Composable
internal fun SuggestedLine(by: String?) {
    Text(
        by?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.conversation_quick_reply_by, it) } ?: stringResource(R.string.conversation_quick_reply),
        style = UiSpec.note,
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.End,
        maxLines = 1,
        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        modifier = Modifier
            .testTag(UiTags.SUGGESTED)
            .fillMaxWidth()
            .padding(start = MessageSpec.userPaddingHorizontal, end = MessageSpec.userPaddingHorizontal, top = 6.dp),
    )
}
