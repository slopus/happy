package com.slopus.happy.ui.diff

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.diff.DiffFile
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.buildSplitRows
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.theme.happyTextStyle
import kotlin.math.ceil

/** DiffFileView.tsx's three layouts over the same rows. */
enum class DiffLayoutMode {
    /** Line numbers and markers pinned at the left; the code scrolls sideways under them. */
    Scroll,
    /** No sideways scroll: the gutter is inline and long lines wrap. */
    Wrap,
    /** Old and new side by side, wrapping; for wide screens. */
    Split,
}

/**
 * One file's diff (DiffFileView.tsx), on the surface colour.
 *
 * Scroll layout: a gutter pinned at the left, `ceil((digits + 2) x char
 * width) + 12` wide with line numbers (+ 4 without; at least 2 digits),
 * holding the line number (mono fontSize - 1, right-aligned, lineNumber)
 * and the +/− marker (mono, two characters wide, centred, marker colour) on
 * the gutter colour. Beside it the code, mono fontSize / round(fontSize x
 * 1.5), 6 in, on the row colour, one line per row, sliding sideways under
 * the gutter when wider than the view (content `ceil((maxColumns + 2) x
 * char width) + 8`). Spans carry syntax colour and word emphasis (wordAdd
 * / wordDel behind the changed words). A `@@` row is one line high on
 * hunkBg: "···" in the gutter, the header (or "⋯ N unchanged", "⤢" when
 * [onExpandContext] can widen it) and its section in mono fontSize - 1.
 *
 * Wrap layout: gutter and code side by side in each row, the code wrapping
 * with 6 before and 8 after. `@@` rows become bars padded 8; messages are
 * 13 sans, padded 12, centred. Split layout: the two sides in one row,
 * either side filled with hunkBg when it has no line, a 1 divider between.
 *
 * Past [collapseAfter] rows a "Show N more lines" bar (padding 10, hunkBg,
 * divider above, 13 semibold hunkText, a spinner 8 before it while the
 * rest's colour is fetched) shows the rest. Until the shown rows are
 * coloured (at most a second) they are laid out but invisible.
 */
@Composable
fun DiffFileView(
    file: DiffFile,
    modifier: Modifier = Modifier,
    fontSize: Float = DiffMetrics.DEFAULT_FONT_SIZE,
    showLineNumbers: Boolean = true,
    layout: DiffLayoutMode = DiffLayoutMode.Scroll,
    showHunkHeaders: Boolean = true,
    collapseAfter: Int = 400,
    paddingVertical: Dp = 0.dp,
    onExpandContext: (() -> Unit)? = null,
) {
    val body = rememberDiffFileBody(file, showHunkHeaders, collapseAfter)
    DiffFileView(body, modifier, fontSize, showLineNumbers, layout, paddingVertical, onExpandContext)
}

/** [DiffFileView] over a [DiffFileBody] the caller holds. */
@Composable
fun DiffFileView(
    body: DiffFileBody,
    modifier: Modifier = Modifier,
    fontSize: Float = DiffMetrics.DEFAULT_FONT_SIZE,
    showLineNumbers: Boolean = true,
    layout: DiffLayoutMode = DiffLayoutMode.Scroll,
    paddingVertical: Dp = 0.dp,
    onExpandContext: (() -> Unit)? = null,
) {
    val palette = diffPalette()
    val metrics = rememberDiffMetrics(fontSize)
    val file = body.file
    val rows = body.rows
    val gutterWidth = metrics.gutterWidth(file.maxLineNo, showLineNumbers)
    Column(modifier = modifier.fillMaxWidth().background(palette.surface).testTag(DiffTags.FILE)) {
        Box(modifier = Modifier.syntaxGate(body.pending)) {
            when (layout) {
                DiffLayoutMode.Scroll -> ScrollBody(rows, file, body.scroll, palette, metrics, gutterWidth, showLineNumbers, paddingVertical, onExpandContext)
                DiffLayoutMode.Wrap -> Column(Modifier.padding(vertical = paddingVertical)) {
                    for (row in rows) DiffRowInline(row, palette, metrics, gutterWidth, showLineNumbers, onExpandContext)
                }
                DiffLayoutMode.Split -> {
                    val split = remember(rows) { buildSplitRows(rows) }
                    Column(Modifier.padding(vertical = paddingVertical)) {
                        for (row in split) DiffSplitRow(row, palette, metrics, gutterWidth, showLineNumbers, onExpandContext)
                    }
                }
            }
        }
        if (body.hiddenCount > 0) ShowMoreBar(body, palette)
    }
}

/**
 * The same file as lazy items, one per row, for screens that scroll a whole
 * file or changeset: only rows near the viewport are composed. Every row
 * scrolls sideways with [DiffFileBody.scroll], so the code still slides as
 * one under the pinned gutter. [palette] and [metrics] come from the
 * caller's composition ([diffPalette], [rememberDiffMetrics]); the caller
 * starts the body ([DiffFileBody.start]). [rowModifier] goes on every row
 * (DiffFilesList holds them to the content width with it).
 */
fun LazyListScope.diffFileItems(
    body: DiffFileBody,
    palette: DiffPalette,
    metrics: DiffMetrics,
    keyPrefix: String,
    showLineNumbers: Boolean = true,
    layout: DiffLayoutMode = DiffLayoutMode.Scroll,
    onExpandContext: (() -> Unit)? = null,
    rowModifier: Modifier = Modifier,
) {
    val file = body.file
    val gutterWidth = metrics.gutterWidth(file.maxLineNo, showLineNumbers)
    val pending = body.pending
    when (layout) {
        DiffLayoutMode.Scroll -> {
            val codeWidth = codeWidth(file, metrics)
            items(body.rows.size, key = { "$keyPrefix:${body.rows[it].key}" }, contentType = { "diff.row" }) { index ->
                val row = body.rows[index]
                Row(modifier = rowModifier.fillMaxWidth().background(palette.surface).syntaxGate(pending)) {
                    DiffRowGutter(row, palette, metrics, gutterWidth, showLineNumbers)
                    // The viewport reaches the row as its minimum (the weight, kept by horizontalScroll),
                    // so a file of short lines still paints its bands to the edge, as ScrollBody does.
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .horizontalScroll(body.scroll, overscrollEffect = null),
                        propagateMinConstraints = true,
                    ) {
                        DiffRowCode(row, palette, metrics, Modifier.widthIn(min = codeWidth), onExpandContext)
                    }
                }
            }
        }
        DiffLayoutMode.Wrap -> items(body.rows.size, key = { "$keyPrefix:${body.rows[it].key}" }, contentType = { "diff.row" }) { index ->
            Box(rowModifier.background(palette.surface).syntaxGate(pending)) {
                DiffRowInline(body.rows[index], palette, metrics, gutterWidth, showLineNumbers, onExpandContext)
            }
        }
        DiffLayoutMode.Split -> {
            val split = buildSplitRows(body.rows)
            items(split.size, key = { "$keyPrefix:${split[it].key}" }, contentType = { "diff.row" }) { index ->
                Box(rowModifier.background(palette.surface).syntaxGate(pending)) {
                    DiffSplitRow(split[index], palette, metrics, gutterWidth, showLineNumbers, onExpandContext)
                }
            }
        }
    }
    if (body.hiddenCount > 0) item(key = "$keyPrefix:showMore") { Box(rowModifier) { ShowMoreBar(body, palette) } }
}

/** Laid out but invisible, and unread by TalkBack, while the syntax gate holds. */
private fun Modifier.syntaxGate(pending: Boolean) =
    alpha(if (pending) 0f else 1f)
        .then(if (pending) Modifier.semantics { hideFromAccessibility() } else Modifier)
        .testTag(if (pending) DiffTags.SYNTAX_PENDING else DiffTags.SYNTAX_READY)

/** A couple of columns of slack keeps the last glyph off the right edge. */
private fun codeWidth(file: DiffFile, metrics: DiffMetrics): Dp = ceil((file.maxColumns + 2) * metrics.charWidth.value).dp + 8.dp

@Composable
private fun ShowMoreBar(body: DiffFileBody, palette: DiffPalette) {
    Column(modifier = Modifier.fillMaxWidth()) {
        HorizontalDivider(thickness = 1.dp, color = palette.divider)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.hunkBg)
                .testTag(DiffTags.SHOW_MORE)
                .clickable(enabled = !body.expanding, role = Role.Button) { body.expand() }
                .padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (body.expanding) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = palette.hunkText, strokeWidth = 2.dp)
            Text(
                text = pluralResource(R.plurals.diff_show_more_lines, body.hiddenCount, body.hiddenCount),
                style = showMoreStyle,
                color = palette.hunkText,
            )
        }
    }
}

private val showMoreStyle = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)

// ─── Scroll layout ──────────────────────────────────────────────────────────

@Composable
private fun ScrollBody(
    rows: List<DiffRow>,
    file: DiffFile,
    scroll: ScrollState,
    palette: DiffPalette,
    metrics: DiffMetrics,
    gutterWidth: Dp,
    showLineNumbers: Boolean,
    paddingVertical: Dp,
    onExpandContext: (() -> Unit)?,
) {
    BoxWithConstraints(modifier = Modifier.fillMaxWidth().padding(vertical = paddingVertical)) {
        val codeWidth = codeWidth(file, metrics)
        val viewport = (maxWidth - gutterWidth).coerceAtLeast(0.dp)
        val scrollable = codeWidth > viewport
        Row {
            Column(modifier = Modifier.width(gutterWidth).background(palette.surface).testTag(DiffTags.GUTTER)) {
                for (row in rows) DiffRowGutter(row, palette, metrics, gutterWidth, showLineNumbers)
            }
            Column(modifier = Modifier.width(viewport).horizontalScroll(scroll, enabled = scrollable)) {
                val width = maxOf(codeWidth, viewport)
                for (row in rows) DiffRowCode(row, palette, metrics, Modifier.width(width), onExpandContext)
            }
        }
    }
}
