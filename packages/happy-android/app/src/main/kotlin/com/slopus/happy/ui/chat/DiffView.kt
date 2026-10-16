package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.chat.tools.DiffFile
import com.slopus.happy.chat.tools.DiffLineType
import com.slopus.happy.chat.tools.DiffRow
import com.slopus.happy.chat.tools.FileChangeKind
import com.slopus.happy.chat.tools.buildDiffFromContents
import com.slopus.happy.chat.tools.buildDiffFromPatch
import com.slopus.happy.chat.tools.selectVisibleRows
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.ceil

object DiffTags {
    const val CHUNK = "diff.chunk"
    const val FILE = "diff.file"
    const val GUTTER = "diff.gutter"
    const val LINE = "diff.line"
    const val HUNK = "diff.hunk"
    const val MESSAGE = "diff.message"
    const val SHOW_MORE = "diff.showMore"
    const val HEADER = "diff.header"
}

/** DiffMetrics.tsx / DiffFileView.tsx at the phone font size. */
object DiffSpec {
    const val FONT_SIZE = 12
    /** `Math.round(fontSize * 1.5)` */
    val lineHeight = 18.dp
    val code = happyTextStyle(fontSize = 12, lineHeight = 18, family = PlexMono)
    val lineNumber = happyTextStyle(fontSize = 11, lineHeight = 18, family = PlexMono)
    val hunk = happyTextStyle(fontSize = 11, lineHeight = 18, family = PlexMono)
    val message = happyTextStyle(fontSize = 12, lineHeight = 18)
    val codePaddingStart = 6.dp
    val showMorePaddingVertical = 10.dp
    val showMore = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)
    /** The chat collapses a diff after this many rows (DiffChunk). */
    const val COLLAPSE_AFTER = 80
    const val CONTEXT_LINES = 3
    val headerPaddingHorizontal = 12.dp
    val headerPaddingVertical = 9.dp
    val headerGap = 8.dp
    val headerIcon = 16.dp
    val headerDir = happyTextStyle(fontSize = 12, family = PlexMono)
    val headerName = TextStyle(fontFamily = PlexMono, fontWeight = FontWeight.SemiBold, fontSize = 12.5.sp, platformStyle = PlatformTextStyle(includeFontPadding = true))
    val headerBadge = TextStyle(fontFamily = PlexMono, fontWeight = FontWeight.SemiBold, fontSize = 10.5.sp, platformStyle = PlatformTextStyle(includeFontPadding = true))
    val headerStat = happyTextStyle(fontSize = 12, family = PlexMono)
    /** Inputs past this many characters are diffed off the main thread. */
    const val SYNC_BUILD_LIMIT = 16_000
}

/** DiffPalette.ts over theme.ts `diff.*`. */
@Immutable
data class DiffPalette(
    val rowAdd: Color,
    val rowDel: Color,
    val gutterAdd: Color,
    val gutterDel: Color,
    val lineNumber: Color,
    val markerAdd: Color,
    val markerDel: Color,
    val hunkBg: Color,
    val hunkText: Color,
    val sectionText: Color,
    val plain: Color,
) {
    fun rowBg(type: DiffLineType) = when (type) {
        DiffLineType.Add -> rowAdd
        DiffLineType.Del -> rowDel
        DiffLineType.Ctx -> Color.Transparent
    }

    fun gutterBg(type: DiffLineType) = when (type) {
        DiffLineType.Add -> gutterAdd
        DiffLineType.Del -> gutterDel
        DiffLineType.Ctx -> Color.Transparent
    }

    fun marker(type: DiffLineType) = when (type) {
        DiffLineType.Add -> markerAdd
        DiffLineType.Del -> markerDel
        DiffLineType.Ctx -> lineNumber
    }
}

private fun c(hex: Long) = Color(hex or 0xFF000000)

val LightDiffPalette = DiffPalette(
    rowAdd = c(0xE6FFEC), rowDel = c(0xFFEBE9), gutterAdd = c(0xCCFFD8), gutterDel = c(0xFFD7D5),
    lineNumber = c(0x959DA5), markerAdd = c(0x1A7F37), markerDel = c(0xCF222E),
    hunkBg = c(0xF1F8FF), hunkText = c(0x005CC5), sectionText = c(0x6E7781), plain = c(0x1F2328),
)

val DarkDiffPalette = DiffPalette(
    rowAdd = c(0x12261E), rowDel = c(0x25171C), gutterAdd = c(0x1B4721), gutterDel = c(0x78191B),
    lineNumber = c(0x6E7681), markerAdd = c(0x3FB950), markerDel = c(0xF85149),
    hunkBg = c(0x161B22), hunkText = c(0x58A6FF), sectionText = c(0x8B949E), plain = c(0xE6EDF3),
)

@Composable
private fun diffPalette() = if (HappyTheme.colors.dark) DarkDiffPalette else LightDiffPalette

/** What a diff is drawn from: a unified patch, or a before/after pair. */
@Immutable
sealed interface DiffSource {
    data class Patch(val patch: String) : DiffSource
    data class Contents(val path: String, val oldText: String, val newText: String) : DiffSource

    val size: Int get() = when (this) {
        is Patch -> patch.length
        is Contents -> oldText.length + newText.length
    }
}

private fun build(source: DiffSource): List<DiffFile> = when (source) {
    is DiffSource.Patch -> buildDiffFromPatch(source.patch)
    is DiffSource.Contents -> listOf(buildDiffFromContents(source.path, source.oldText, source.newText, DiffSpec.CONTEXT_LINES))
}

/** A small diff is built in place; a large one on a background thread, showing nothing until it is ready. */
@Composable
fun rememberDiffFiles(source: DiffSource): List<DiffFile> {
    if (source.size <= DiffSpec.SYNC_BUILD_LIMIT) return remember(source) { build(source) }
    val files by produceState(emptyList(), source) { value = withContext(Dispatchers.Default) { build(source) } }
    return files
}

/** The mono font's advance width at [DiffSpec.FONT_SIZE] (`MonoProbe`). */
@Composable
private fun rememberCharWidth(): Dp {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    return remember(measurer, density) {
        val sample = "M".repeat(50)
        val width = measurer.measure(sample, DiffSpec.code).size.width
        with(density) { (width / 50f).toDp() }
    }
}

/** layout.ts `gutterWidthFor` */
fun diffGutterWidth(charWidth: Dp, maxLineNo: Int, showLineNumbers: Boolean): Dp {
    val digits = if (showLineNumbers) maxOf(2, maxOf(1, maxLineNo).toString().length) else 0
    return ceil((digits + 2) * charWidth.value).dp + if (showLineNumbers) 12.dp else 4.dp
}

/**
 * The chat-sized diff (DiffChunk.tsx): every file of [source] as a
 * [DiffFileView], 3 lines of context, collapsed after 80 rows, `@@` bars
 * only when a file has more than one hunk. Nothing when there are no files.
 */
@Composable
fun DiffChunk(source: DiffSource, showLineNumbers: Boolean, modifier: Modifier = Modifier) {
    val files = rememberDiffFiles(source)
    if (files.isEmpty()) return
    Column(modifier = modifier.fillMaxWidth().testTag(DiffTags.CHUNK)) {
        for (file in files) {
            DiffFileView(
                file = file,
                showLineNumbers = showLineNumbers,
                collapseAfter = DiffSpec.COLLAPSE_AFTER,
                showHunkHeaders = file.rows.count { it is DiffRow.Hunk } > 1,
            )
        }
    }
}

/**
 * One file's diff, scroll layout (DiffFileView.tsx `ScrollBody`): on the
 * surface colour, a gutter pinned at the left (ceil((digits + 2) x char
 * width) + 12 with line numbers, + 4 without; digits at least 2) with the
 * line number (mono 11, right-aligned, lineNumber colour) and the +/−
 * marker (mono 12, two characters wide, centred, marker colour) on the
 * gutter colour; beside it the code, mono 12/18, 6 in, on the row colour,
 * one line per row, scrolling sideways when wider than the view. A `@@`
 * row is 18 high on hunkBg: "···" in the gutter, the header (or "⋯ N
 * unchanged") in mono 11 hunkText in the code. Past [collapseAfter] rows a
 * "Show N more lines" bar (padding 10, hunkBg, divider on top, 13
 * semibold hunkText, centred) expands the rest.
 */
@Composable
fun DiffFileView(
    file: DiffFile,
    showLineNumbers: Boolean,
    modifier: Modifier = Modifier,
    collapseAfter: Int = 400,
    showHunkHeaders: Boolean = true,
) {
    val palette = diffPalette()
    val colors = HappyTheme.colors
    var expanded by rememberSaveable(file.path) { mutableStateOf(false) }
    val (rows, hidden) = remember(file, showHunkHeaders, expanded, collapseAfter) {
        selectVisibleRows(file.rows, showHunkHeaders, expanded, collapseAfter)
    }
    val charWidth = rememberCharWidth()
    val gutterWidth = diffGutterWidth(charWidth, file.maxLineNo, showLineNumbers)
    Column(modifier = modifier.fillMaxWidth().background(colors.surface).testTag(DiffTags.FILE)) {
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val codeWidth = ceil((file.maxColumns + 2) * charWidth.value).dp + 8.dp
            val viewport = maxWidth - gutterWidth
            val contentWidth = maxOf(codeWidth, viewport)
            Row {
                Column(modifier = Modifier.width(gutterWidth).testTag(DiffTags.GUTTER)) {
                    for (row in rows) DiffGutterRow(row, palette, gutterWidth, charWidth, showLineNumbers)
                }
                Column(
                    modifier = Modifier
                        .width(viewport)
                        .horizontalScroll(rememberScrollState(), enabled = codeWidth > viewport),
                ) {
                    Column(modifier = Modifier.width(contentWidth)) {
                        for (row in rows) DiffCodeRow(row, palette)
                    }
                }
            }
        }
        if (hidden > 0) {
            HorizontalDivider(thickness = 1.dp, color = colors.divider)
            Text(
                text = pluralResource(R.plurals.diff_show_more_lines, hidden, hidden),
                style = DiffSpec.showMore,
                color = palette.hunkText,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(DiffTags.SHOW_MORE)
                    .background(palette.hunkBg)
                    .clickable { expanded = true }
                    .padding(vertical = DiffSpec.showMorePaddingVertical),
            )
        }
    }
}

@Composable
private fun DiffGutterRow(row: DiffRow, palette: DiffPalette, width: Dp, charWidth: Dp, showLineNumbers: Boolean) {
    when (row) {
        is DiffRow.Hunk -> Text(
            "···",
            style = DiffSpec.hunk,
            color = palette.hunkText,
            maxLines = 1,
            modifier = Modifier.width(width).height(DiffSpec.lineHeight).background(palette.hunkBg).padding(start = 6.dp),
        )
        is DiffRow.Message -> Spacer(Modifier.width(width).height(DiffSpec.lineHeight))
        is DiffRow.Line -> Row(
            modifier = Modifier.width(width).height(DiffSpec.lineHeight).background(palette.gutterBg(row.type)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showLineNumbers) {
                Text(
                    text = (if (row.type == DiffLineType.Del) row.oldNo else row.newNo)?.toString().orEmpty(),
                    style = DiffSpec.lineNumber,
                    color = palette.lineNumber,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                text = when (row.type) {
                    DiffLineType.Add -> "+"
                    DiffLineType.Del -> "−"
                    DiffLineType.Ctx -> ""
                },
                style = DiffSpec.code,
                color = palette.marker(row.type),
                textAlign = TextAlign.Center,
                modifier = Modifier.width(ceil(charWidth.value * 2).dp),
            )
        }
    }
}

@Composable
private fun DiffCodeRow(row: DiffRow, palette: DiffPalette) {
    when (row) {
        is DiffRow.Hunk -> Text(
            text = buildAnnotatedString {
                append(if (row.hidden != null) "⋯ " + stringResource(R.string.diff_unchanged_lines, row.hidden) else row.text)
                if (row.section.isNotEmpty()) withStyle(SpanStyle(color = palette.sectionText)) { append("   ${row.section}") }
            },
            style = DiffSpec.hunk,
            color = palette.hunkText,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.fillMaxWidth().height(DiffSpec.lineHeight).background(palette.hunkBg).testTag(DiffTags.HUNK),
        )
        is DiffRow.Message -> Text(
            text = stringResource(if (row.binary) R.string.diff_binary_file else R.string.diff_no_changes),
            style = DiffSpec.message,
            color = HappyTheme.colors.textSecondary,
            maxLines = 1,
            modifier = Modifier.height(DiffSpec.lineHeight).testTag(DiffTags.MESSAGE),
        )
        is DiffRow.Line -> Text(
            text = row.text.ifEmpty { " " },
            style = DiffSpec.code,
            color = palette.plain,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier
                .fillMaxWidth()
                .height(DiffSpec.lineHeight)
                .background(palette.rowBg(row.type))
                .testTag(DiffTags.LINE)
                .padding(start = DiffSpec.codePaddingStart),
        )
    }
}

/**
 * DiffFileHeader.tsx: padding 12/9 on hunkBg, 8 apart: a 16 file icon, the
 * folder (mono 12 textSecondary, shortened from the start) then the name
 * (mono semibold 12.5 text), a NEW / DELETED / RENAMED badge (mono
 * semibold 10.5), +N and −N (mono 12 in the marker colours), and [right].
 */
@Composable
fun DiffFileHeader(
    path: String,
    kind: FileChangeKind,
    additions: Int,
    deletions: Int,
    modifier: Modifier = Modifier,
    right: (@Composable () -> Unit)? = null,
) {
    val palette = diffPalette()
    val colors = HappyTheme.colors
    val name = path.substringAfterLast('/').ifEmpty { path }
    val dir = path.substring(0, path.length - name.length)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(palette.hunkBg)
            .testTag(DiffTags.HEADER)
            .padding(horizontal = DiffSpec.headerPaddingHorizontal, vertical = DiffSpec.headerPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(DiffSpec.headerGap),
    ) {
        Icon(Octicon.File, DiffSpec.headerIcon, colors.textSecondary)
        Row(modifier = Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Text(
                dir,
                style = DiffSpec.headerDir,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.StartEllipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text(name, style = DiffSpec.headerName, color = colors.text, maxLines = 1)
        }
        when (kind) {
            FileChangeKind.Added -> Text("NEW", style = DiffSpec.headerBadge, color = palette.markerAdd)
            FileChangeKind.Deleted -> Text("DELETED", style = DiffSpec.headerBadge, color = palette.markerDel)
            FileChangeKind.Renamed -> Text("RENAMED", style = DiffSpec.headerBadge, color = colors.textSecondary)
            else -> Unit
        }
        if (additions > 0) Text("+$additions", style = DiffSpec.headerStat, color = palette.markerAdd)
        if (deletions > 0) Text("−$deletions", style = DiffSpec.headerStat, color = palette.markerDel)
        right?.invoke()
    }
}
