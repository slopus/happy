package com.slopus.happy.ui.diff

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.diff.MarkdownDiff
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.chat.MarkdownBlockView
import com.slopus.happy.ui.chat.MarkdownSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.slopus.happy.chat.markdown.SpanStyle as MdStyle

object MarkdownDiffTags {
    const val VIEW = "markdownDiff.view"
    const val ADDED = "markdownDiff.added"
    const val REMOVED = "markdownDiff.removed"
    const val CHANGED = "markdownDiff.changed"
    const val SAME = "markdownDiff.same"
    const val FOLD = "markdownDiff.fold"
}

/**
 * desktop's MarkdownDiff (C-331, markdown-diff.css): a change read as the
 * document it changes, drawn by the chat's own Markdown blocks. A whole
 * added or removed block sits on its diff wash, which bleeds 8 past the
 * text on both sides (radius 4) so the text stays where it would be
 * unchanged; removed text is struck in the removed ink. Inside a changed
 * block, inserted words are underlined on the inline green and deleted
 * words struck on the inline red. Unchanged runs longer than two blocks on
 * either side of a change fold behind "Show N unchanged blocks".
 *
 * Takes the two versions as text: the diff is worked out off the main
 * thread, and nothing shows until it is.
 */
@Composable
fun MarkdownDiffView(old: String, new: String, modifier: Modifier = Modifier) {
    val diff by produceState<MarkdownDiff?>(null, old, new) { value = withContext(Dispatchers.Default) { MarkdownDiff.compute(old, new) } }
    var expanded by rememberSaveable(old, new) { mutableStateOf(emptySet<Int>()) }
    val shown = diff ?: return
    val rows = remember(shown, expanded) { MarkdownDiff.rows(shown, expanded) }
    Column(modifier.testTag(MarkdownDiffTags.VIEW).padding(horizontal = MarkdownDiffSpec.bleed)) {
        for (row in rows) MarkdownDiffRow(row) { expanded = expanded + it }
    }
}

/** [MarkdownDiffView]'s rows as lazy items, for a list that holds other things (Changes). */
fun LazyListScope.markdownDiffItems(diff: MarkdownDiff, expanded: Set<Int>, keyPrefix: String, rowModifier: Modifier, onExpand: (Int) -> Unit) {
    val rows = MarkdownDiff.rows(diff, expanded)
    items(rows.size, key = { index -> "$keyPrefix:md:" + rows[index].let { if (it is MarkdownDiff.Row.Block) "b${it.index}" else "f${(it as MarkdownDiff.Row.Fold).first}" } }, contentType = { "markdownDiff.row" }) { index ->
        Box(rowModifier.padding(horizontal = 16.dp + MarkdownDiffSpec.bleed)) { MarkdownDiffRow(rows[index], onExpand) }
    }
}

internal object MarkdownDiffSpec {
    /** The wash reaches this far past the text on each side. */
    val bleed = 8.dp
    val radius = 4.dp
    val fold = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
}

@Composable
private fun MarkdownDiffRow(row: MarkdownDiff.Row, onExpand: (Int) -> Unit) {
    val palette = diffPalette()
    when (row) {
        is MarkdownDiff.Row.Fold -> Row(
            Modifier
                .bleed(MarkdownDiffSpec.bleed)
                .fillMaxWidth()
                .padding(vertical = 4.dp)
                .clip(RoundedCornerShape(MarkdownDiffSpec.radius))
                .background(palette.hunkBg)
                .testTag(MarkdownDiffTags.FOLD)
                .clickable(role = Role.Button) { onExpand(row.first) }
                .padding(horizontal = MarkdownDiffSpec.bleed, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Ionicon.ChevronDown, 16.dp, palette.hunkText)
            Text(pluralResource(R.plurals.markdown_diff_unchanged, row.count, row.count), style = MarkdownDiffSpec.fold, color = palette.hunkText)
        }
        is MarkdownDiff.Row.Block -> when (val entry = row.entry) {
            is MarkdownDiff.Entry.Same -> Box(Modifier.testTag(MarkdownDiffTags.SAME)) { MarkdownBlockView(entry.block) }
            is MarkdownDiff.Entry.Added -> Washed(palette.rowAdd, MarkdownDiffTags.ADDED) { MarkdownBlockView(entry.block) }
            is MarkdownDiff.Entry.Removed -> Washed(palette.rowDel, MarkdownDiffTags.REMOVED) {
                val struck = entry.block.inlineWords()
                if (struck != null) DiffBlockText(entry.block, struck.map { MarkdownDiff.DiffWord(it, MarkdownDiff.WordChange.Deleted) }, wordWash = false)
                else MarkdownBlockView(entry.block)
            }
            is MarkdownDiff.Entry.Changed -> Box(Modifier.testTag(MarkdownDiffTags.CHANGED)) { DiffBlockText(entry.new, entry.spans, wordWash = true) }
        }
    }
}

@Composable
private fun Washed(color: Color, tag: String, content: @Composable () -> Unit) {
    Box(
        Modifier
            .bleed(MarkdownDiffSpec.bleed)
            .fillMaxWidth()
            .testTag(tag)
            .clip(RoundedCornerShape(MarkdownDiffSpec.radius))
            .background(color)
            .padding(horizontal = MarkdownDiffSpec.bleed),
    ) { content() }
}

/** Laid out [amount] wider on each side than its slot, so a wash reaches past text that stays where it would be. */
private fun Modifier.bleed(amount: Dp) = layout { measurable, constraints ->
    val px = amount.roundToPx()
    val wide = if (constraints.hasBoundedWidth) constraints.copy(minWidth = constraints.minWidth + 2 * px, maxWidth = constraints.maxWidth + 2 * px) else constraints
    val placeable = measurable.measure(wide)
    layout((placeable.width - 2 * px).coerceAtLeast(0), placeable.height) { placeable.place(-px, 0) }
}

private fun MarkdownBlock.inlineWords(): List<MarkdownSpan>? = when (this) {
    is MarkdownBlock.Text -> content
    is MarkdownBlock.Header -> content
    is MarkdownBlock.BulletList -> items.singleOrNull()?.spans
    is MarkdownBlock.NumberedList -> items.singleOrNull()?.spans
    else -> null
}

/** A prose block with each word marked as kept, inserted or deleted, in [block]'s own style and margins. */
@Composable
private fun DiffBlockText(block: MarkdownBlock, words: List<MarkdownDiff.DiffWord>, wordWash: Boolean) {
    val palette = diffPalette()
    val text = remember(words, palette, wordWash) { diffAnnotated(words, palette, wordWash) }
    val ink = palette.text
    when (block) {
        is MarkdownBlock.Header -> {
            val (style, margins) = MarkdownSpec.headers[(block.level - 1).coerceIn(0, 5)]
            Text(text, style = style, color = ink, modifier = Modifier.padding(top = margins.first, bottom = margins.second))
        }
        is MarkdownBlock.BulletList, is MarkdownBlock.NumberedList -> {
            val (marker, depth) = when (block) {
                is MarkdownBlock.BulletList -> block.items.single().let { MarkdownSpec.bullets[it.depth.coerceAtMost(2)] to it.depth }
                is MarkdownBlock.NumberedList -> block.items.single().let { "${it.number}." to it.depth }
                else -> "" to 0
            }
            Row(Modifier.padding(start = MarkdownSpec.listIndent * depth, bottom = MarkdownSpec.listMarginBottom)) {
                Text(marker, style = MarkdownSpec.text, color = ink, modifier = Modifier.padding(end = MarkdownSpec.bulletGap, top = 1.dp))
                Text(text, style = MarkdownSpec.text, color = ink, modifier = Modifier.weight(1f))
            }
        }
        else -> Text(text, style = MarkdownSpec.text, color = ink, modifier = Modifier.padding(top = MarkdownSpec.textMarginTop, bottom = MarkdownSpec.textMarginBottom))
    }
}

internal fun diffAnnotated(words: List<MarkdownDiff.DiffWord>, palette: DiffPalette, wordWash: Boolean): AnnotatedString = buildAnnotatedString {
    for (word in words) {
        val span = word.span
        val base = SpanStyle(
            fontWeight = if (MdStyle.Bold in span.styles || MdStyle.Semibold in span.styles) FontWeight.SemiBold else null,
            fontStyle = if (MdStyle.Italic in span.styles) FontStyle.Italic else null,
            fontFamily = if (MdStyle.Code in span.styles) AppMono else null,
            textDecoration = if (span.url != null) TextDecoration.Underline else null,
        )
        val marked = when (word.change) {
            MarkdownDiff.WordChange.Kept -> base
            MarkdownDiff.WordChange.Inserted -> base.merge(SpanStyle(background = if (wordWash) palette.wordAdd else Color.Unspecified, textDecoration = TextDecoration.Underline))
            MarkdownDiff.WordChange.Deleted -> base.merge(
                SpanStyle(
                    background = if (wordWash) palette.wordDel else Color.Unspecified,
                    color = palette.markerDel,
                    textDecoration = TextDecoration.LineThrough,
                ),
            )
        }
        withStyle(marked) { append(span.text) }
    }
}
