package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ui.UiComponent
import com.slopus.happy.conversation.ui.UiFileTree
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object UiTags {
    const val FILE_TREE = "conversation.ui.file_tree"
    const val FILE_TREE_LINE = "conversation.ui.file_tree.line"
    const val FILE_TREE_MORE = "conversation.ui.file_tree.more"
    const val FALLBACK = "conversation.ui.fallback"
}

/** Chat UI's measures, on the transcript's 16 column. */
object UiSpec {
    val treeIndent = 16.dp
    val treeGlyph = 14.dp
    val treeGlyphGap = 6.dp
    /** Lines a file tree shows before "Show all". */
    const val TREE_LINES = 12
    val moreGap = 4.dp
    val fallbackMark = 18.dp
    val fallbackMarkGap = 10.dp

    val tree = happyTextStyle(fontSize = 13, lineHeight = 20, family = AppMono)
    val more = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val fallback = happyTextStyle(fontSize = 14, lineHeight = 20)
}

/**
 * One component of chat UI. Spec: 16 in from the sides and 6 above and
 * below, as every row; a surfaceHigh card, radius 12, padding 12. A
 * `file_tree` is 13/20 mono lines, one a folder or file, 16 in a level, a
 * 14 folder or document glyph 6 before each name, a name too long for its
 * line cut with an ellipsis; at most twelve lines, then "Show all (N)"
 * (13/18 semibold, link colour, 4 under the lines, 4 above and below its
 * words), which shows them all for good. Any other component is its
 * fallback line: 14/20 textSecondary, an 18 info mark 10 before it.
 */
@Composable
fun UiComponentRow(row: ConversationRow.Ui, modifier: Modifier = Modifier) {
    // Tagged outside the row's own inset, so a tag measures the whole row.
    val inset = { tag: String ->
        modifier
            .testTag(tag)
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
    }
    when (val component = row.component) {
        is UiComponent.FileTree -> FileTree(row.key, component, inset(UiTags.FILE_TREE))
        else -> Fallback(component.fallback, inset(UiTags.FALLBACK))
    }
}

@Composable
private fun FileTree(key: String, tree: UiComponent.FileTree, modifier: Modifier) {
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
            Row(
                Modifier.testTag(UiTags.FILE_TREE_LINE).padding(start = UiSpec.treeIndent * line.depth),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (line.folder) Ionicon.FolderOutline else Ionicon.DocumentOutline, UiSpec.treeGlyph, colors.textSecondary)
                Spacer(Modifier.width(UiSpec.treeGlyphGap))
                Text(line.name, style = UiSpec.tree, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (lines.size > shown.size) {
            Text(
                stringResource(R.string.conversation_ui_tree_show_all, lines.size),
                style = UiSpec.more,
                color = colors.textLink,
                modifier = Modifier
                    .padding(top = UiSpec.moreGap)
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
        horizontalArrangement = Arrangement.spacedBy(UiSpec.fallbackMarkGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.InformationCircleOutline, UiSpec.fallbackMark, colors.textSecondary)
        Text(text, style = UiSpec.fallback, color = colors.textSecondary, modifier = Modifier.weight(1f))
    }
}
