package com.slopus.happy.ui.diff

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.diff.DiffLineType
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.DiffSpan
import com.slopus.happy.diff.SpanEmphasis
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.SplitRow
import com.slopus.happy.ui.theme.PlexSans
import com.slopus.happy.ui.theme.happyTextStyle

private val messageStyle = happyTextStyle(fontSize = 13)

/** The pinned half of a row: line number and change marker. */
@Composable
internal fun DiffRowGutter(row: DiffRow, palette: DiffPalette, metrics: DiffMetrics, width: Dp, showLineNumbers: Boolean) {
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
internal fun DiffRowCode(row: DiffRow, palette: DiffPalette, metrics: DiffMetrics, modifier: Modifier, onExpandContext: (() -> Unit)?) {
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
                    .then(if (canExpand) Modifier.clickable(role = Role.Button) { onExpandContext() } else Modifier),
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
internal fun DiffRowInline(row: DiffRow, palette: DiffPalette, metrics: DiffMetrics, gutterWidth: Dp, showLineNumbers: Boolean, onExpandContext: (() -> Unit)?) {
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
            .then(if (canExpand) Modifier.clickable(role = Role.Button) { onExpandContext() } else Modifier)
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
internal fun DiffSplitRow(row: SplitRow, palette: DiffPalette, metrics: DiffMetrics, gutterWidth: Dp, showLineNumbers: Boolean, onExpandContext: (() -> Unit)?) {
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
