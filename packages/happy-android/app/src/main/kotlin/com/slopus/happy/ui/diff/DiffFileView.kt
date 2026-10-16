package com.slopus.happy.ui.diff

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.diff.DiffFile
import com.slopus.happy.diff.DiffLineType
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.DiffSpan
import com.slopus.happy.diff.SpanEmphasis
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.SplitRow
import com.slopus.happy.diff.buildSplitRows
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.theme.PlexSans
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
 * starts the body ([DiffFileBody.start]).
 */
fun LazyListScope.diffFileItems(
    body: DiffFileBody,
    palette: DiffPalette,
    metrics: DiffMetrics,
    keyPrefix: String,
    showLineNumbers: Boolean = true,
    layout: DiffLayoutMode = DiffLayoutMode.Scroll,
    onExpandContext: (() -> Unit)? = null,
) {
    val file = body.file
    val gutterWidth = metrics.gutterWidth(file.maxLineNo, showLineNumbers)
    val pending = body.pending
    when (layout) {
        DiffLayoutMode.Scroll -> {
            val codeWidth = codeWidth(file, metrics)
            items(body.rows.size, key = { "$keyPrefix:${body.rows[it].key}" }, contentType = { "diff.row" }) { index ->
                val row = body.rows[index]
                Row(modifier = Modifier.fillMaxWidth().background(palette.surface).syntaxGate(pending)) {
                    DiffRowGutter(row, palette, metrics, gutterWidth, showLineNumbers)
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .horizontalScroll(body.scroll, overscrollEffect = null),
                    ) {
                        DiffRowCode(row, palette, metrics, Modifier.width(codeWidth), onExpandContext)
                    }
                }
            }
        }
        DiffLayoutMode.Wrap -> items(body.rows.size, key = { "$keyPrefix:${body.rows[it].key}" }, contentType = { "diff.row" }) { index ->
            Box(Modifier.background(palette.surface).syntaxGate(pending)) {
                DiffRowInline(body.rows[index], palette, metrics, gutterWidth, showLineNumbers, onExpandContext)
            }
        }
        DiffLayoutMode.Split -> {
            val split = buildSplitRows(body.rows)
            items(split.size, key = { "$keyPrefix:${split[it].key}" }, contentType = { "diff.row" }) { index ->
                Box(Modifier.background(palette.surface).syntaxGate(pending)) {
                    DiffSplitRow(split[index], palette, metrics, gutterWidth, showLineNumbers, onExpandContext)
                }
            }
        }
    }
    if (body.hiddenCount > 0) item(key = "$keyPrefix:showMore") { ShowMoreBar(body, palette) }
}

/** Laid out but invisible while the syntax gate holds. */
private fun Modifier.syntaxGate(pending: Boolean) =
    alpha(if (pending) 0f else 1f).testTag(if (pending) DiffTags.SYNTAX_PENDING else DiffTags.SYNTAX_READY)

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
                .clickable(enabled = !body.expanding) { body.expand() }
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
private val messageStyle = happyTextStyle(fontSize = 13)

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

/** The pinned half of a row: line number and change marker. */
@Composable
private fun DiffRowGutter(row: DiffRow, palette: DiffPalette, metrics: DiffMetrics, width: Dp, showLineNumbers: Boolean) {
    when (row) {
        is DiffRow.Hunk -> Box(
            modifier = Modifier.width(width).height(metrics.lineHeight).background(palette.hunkBg),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text("···", style = metrics.small, color = palette.hunkText, maxLines = 1, modifier = Modifier.padding(start = 6.dp))
        }
        is DiffRow.Message -> Spacer(Modifier.width(width).height(metrics.lineHeight))
        is DiffRow.Line -> Row(
            modifier = Modifier.width(width).height(metrics.lineHeight).background(palette.gutterBg(row.type)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            GutterContent(if (row.type == DiffLineType.Del) row.oldNo else row.newNo, marker(row.type), row.type, palette, metrics, showLineNumbers)
        }
    }
}

@Composable
private fun RowScope.GutterContent(number: Int?, marker: String, type: DiffLineType, palette: DiffPalette, metrics: DiffMetrics, showLineNumbers: Boolean) {
    if (showLineNumbers) {
        Text(
            text = number?.toString().orEmpty(),
            style = metrics.small,
            color = palette.lineNumber,
            textAlign = TextAlign.End,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
    }
    Text(
        text = marker,
        style = metrics.code,
        color = palette.marker(type),
        textAlign = TextAlign.Center,
        maxLines = 1,
        modifier = Modifier.width(metrics.markerWidth),
    )
}

private fun marker(type: DiffLineType) = when (type) {
    DiffLineType.Add -> "+"
    DiffLineType.Del -> "−"
    DiffLineType.Ctx -> ""
}

/** The scrolling half of a row: code only. */
@Composable
private fun DiffRowCode(row: DiffRow, palette: DiffPalette, metrics: DiffMetrics, modifier: Modifier, onExpandContext: (() -> Unit)?) {
    when (row) {
        is DiffRow.Hunk -> {
            val canExpand = onExpandContext != null && row.hidden != null && row.hidden > 0
            Text(
                text = hunkText(row, palette, canExpand, withSection = true),
                style = metrics.small,
                color = palette.hunkText,
                maxLines = 1,
                softWrap = false,
                modifier = modifier
                    .height(metrics.lineHeight)
                    .background(palette.hunkBg)
                    .testTag(DiffTags.HUNK)
                    .then(if (canExpand) Modifier.clickable { onExpandContext() } else Modifier),
            )
        }
        is DiffRow.Message -> Text(
            text = messageText(row),
            style = metrics.code.copy(fontFamily = PlexSans),
            color = palette.textSecondary,
            maxLines = 1,
            softWrap = false,
            modifier = modifier.height(metrics.lineHeight).testTag(DiffTags.MESSAGE),
        )
        is DiffRow.Line -> Text(
            text = rememberSpans(row.spans, palette),
            style = metrics.code,
            color = palette.plain,
            maxLines = 1,
            softWrap = false,
            modifier = modifier
                .height(metrics.lineHeight)
                .background(palette.rowBg(row.type))
                .testTag(DiffTags.LINE)
                .padding(start = 6.dp),
        )
    }
}

@Composable
private fun hunkText(row: DiffRow.Hunk, palette: DiffPalette, canExpand: Boolean, withSection: Boolean): AnnotatedString {
    val unchanged = row.hidden?.takeIf { it > 0 }?.let { stringResource(R.string.diff_unchanged_lines, it) }
    return buildAnnotatedString {
        append(if (unchanged != null) "${if (canExpand) "⤢" else "⋯"} $unchanged" else row.text)
        if (withSection && row.section.isNotEmpty()) withStyle(SpanStyle(color = palette.sectionText)) { append("   ${row.section}") }
    }
}

/** Message rows carry a marker rather than copy, so the text follows the app language. */
@Composable
private fun messageText(row: DiffRow.Message) =
    stringResource(if (row.code == DiffRow.Message.Code.Binary) R.string.diff_binary_file else R.string.diff_no_changes)

// ─── Wrap layout ────────────────────────────────────────────────────────────

/** Wrap-mode row: gutter and code in one row, as tall as the wrapped code. */
@Composable
private fun DiffRowInline(row: DiffRow, palette: DiffPalette, metrics: DiffMetrics, gutterWidth: Dp, showLineNumbers: Boolean, onExpandContext: (() -> Unit)?) {
    when (row) {
        is DiffRow.Hunk -> HunkBar(row, palette, metrics, onExpandContext)
        is DiffRow.Message -> MessageBlock(messageText(row), palette)
        is DiffRow.Line -> Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min).background(palette.rowBg(row.type))) {
            Row(modifier = Modifier.width(gutterWidth).fillMaxHeight().background(palette.gutterBg(row.type))) {
                GutterContent(if (row.type == DiffLineType.Del) row.oldNo else row.newNo, marker(row.type), row.type, palette, metrics, showLineNumbers)
            }
            WrappedCode(row, palette, metrics, Modifier.weight(1f))
        }
    }
}

@Composable
private fun WrappedCode(row: DiffRow.Line, palette: DiffPalette, metrics: DiffMetrics, modifier: Modifier) {
    Text(
        text = rememberSpans(row.spans, palette),
        style = metrics.code,
        color = palette.plain,
        modifier = modifier.testTag(DiffTags.LINE).padding(start = 6.dp, end = 8.dp),
    )
}

@Composable
private fun HunkBar(row: DiffRow.Hunk, palette: DiffPalette, metrics: DiffMetrics, onExpandContext: (() -> Unit)?) {
    val canExpand = onExpandContext != null && row.hidden != null && row.hidden > 0
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(metrics.lineHeight)
            .background(palette.hunkBg)
            .testTag(DiffTags.HUNK)
            .then(if (canExpand) Modifier.clickable { onExpandContext() } else Modifier)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(hunkText(row, palette, canExpand, withSection = false), style = metrics.small, color = palette.hunkText, maxLines = 1)
        if (row.section.isNotEmpty()) {
            Text(row.section, style = metrics.small, color = palette.sectionText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun MessageBlock(text: String, palette: DiffPalette) {
    Box(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp).testTag(DiffTags.MESSAGE), contentAlignment = Alignment.Center) {
        Text(text, style = messageStyle, color = palette.textSecondary)
    }
}

// ─── Split layout ───────────────────────────────────────────────────────────

@Composable
private fun DiffSplitRow(row: SplitRow, palette: DiffPalette, metrics: DiffMetrics, gutterWidth: Dp, showLineNumbers: Boolean, onExpandContext: (() -> Unit)?) {
    when (row) {
        is SplitRow.Full -> when (val inner = row.row) {
            is DiffRow.Hunk -> HunkBar(inner, palette, metrics, onExpandContext)
            is DiffRow.Message -> MessageBlock(messageText(inner), palette)
            is DiffRow.Line -> Unit
        }
        is SplitRow.Pair -> Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min).testTag(DiffTags.SPLIT_ROW)) {
            DiffSplitCell(row.left, old = true, palette, metrics, gutterWidth, showLineNumbers, Modifier.weight(1f))
            Spacer(Modifier.width(1.dp).fillMaxHeight().background(palette.divider))
            DiffSplitCell(row.right, old = false, palette, metrics, gutterWidth, showLineNumbers, Modifier.weight(1f))
        }
    }
}

/** One side of a split row; a side with no line is a hunkBg filler, so it reads "nothing here", not "blank line". */
@Composable
private fun DiffSplitCell(line: DiffRow.Line?, old: Boolean, palette: DiffPalette, metrics: DiffMetrics, gutterWidth: Dp, showLineNumbers: Boolean, modifier: Modifier) {
    if (line == null) {
        Box(modifier.fillMaxHeight().heightIn(min = metrics.lineHeight).background(palette.hunkBg))
        return
    }
    // A context line is drawn on both sides; a change only ever belongs to one.
    val type = line.type
    val marker = if (type == DiffLineType.Ctx) "" else if (old) "−" else "+"
    Row(modifier = modifier.fillMaxHeight().background(palette.rowBg(type))) {
        Row(modifier = Modifier.width(gutterWidth).fillMaxHeight().background(palette.gutterBg(type))) {
            GutterContent(if (old) line.oldNo else line.newNo, marker, type, palette, metrics, showLineNumbers)
        }
        WrappedCode(line, palette, metrics, Modifier.weight(1f))
    }
}

// ─── Spans ──────────────────────────────────────────────────────────────────

/** Spans as one styled string: syntax colour from the palette, word emphasis as a background. */
fun diffSpansText(spans: List<DiffSpan>, palette: DiffPalette): AnnotatedString {
    if (spans.isEmpty()) return AnnotatedString(" ")
    return buildAnnotatedString {
        for (span in spans) {
            val color = if (span.kind == SpanKind.Plain) Color.Unspecified else palette.syntax.getValue(span.kind)
            val background = when (span.emphasis) {
                SpanEmphasis.Inserted -> palette.wordAdd
                SpanEmphasis.Deleted -> palette.wordDel
                SpanEmphasis.None -> Color.Unspecified
            }
            if (color == Color.Unspecified && background == Color.Unspecified) append(span.text)
            else withStyle(SpanStyle(color = color, background = background)) { append(span.text) }
        }
    }
}

@Composable
private fun rememberSpans(spans: List<DiffSpan>, palette: DiffPalette) = remember(spans, palette) { diffSpansText(spans, palette) }
