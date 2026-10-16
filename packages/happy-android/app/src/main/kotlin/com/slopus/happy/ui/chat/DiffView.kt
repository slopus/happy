package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.RowScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.slopus.happy.diff.DiffLineType
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.ui.diff.DiffFileSummary
import com.slopus.happy.ui.diff.DiffTags as SharedDiffTags
import com.slopus.happy.ui.diff.DiffChunk as SharedDiffChunk
import com.slopus.happy.ui.diff.DiffFileHeader as SharedDiffFileHeader
import com.slopus.happy.diff.DiffSource as SharedDiffSource

// The chat's seam onto the shared diff renderer (ui/diff): every tool view
// draws its diffs through [DiffChunk] and [DiffFileHeader] here.

object DiffTags {
    const val CHUNK = SharedDiffTags.CHUNK
    const val FILE = SharedDiffTags.FILE
    const val GUTTER = SharedDiffTags.GUTTER
    const val LINE = SharedDiffTags.LINE
    const val HUNK = SharedDiffTags.HUNK
    const val MESSAGE = SharedDiffTags.MESSAGE
    const val SHOW_MORE = SharedDiffTags.SHOW_MORE
    const val HEADER = SharedDiffTags.HEADER
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

private fun DiffSource.shared(): SharedDiffSource = when (this) {
    is DiffSource.Patch -> SharedDiffSource.Patch(patch)
    is DiffSource.Contents -> SharedDiffSource.Contents(path, oldText, newText)
}

/**
 * The chat-sized diff (DiffChunk.tsx), drawn by the shared renderer: every
 * file of [source], 3 lines of context, collapsed after 80 rows, `@@` bars
 * only when a file has more than one hunk, syntax colour and word emphasis.
 * Nothing when there are no files.
 */
@Composable
fun DiffChunk(source: DiffSource, showLineNumbers: Boolean, modifier: Modifier = Modifier) {
    SharedDiffChunk(source.shared(), modifier, showLineNumbers = showLineNumbers)
}

/** DiffFileHeader.tsx, drawn by the shared renderer: icon, folder and name, change badge, +N −N, then [right]. */
@Composable
fun DiffFileHeader(
    path: String,
    kind: FileChangeKind,
    additions: Int,
    deletions: Int,
    modifier: Modifier = Modifier,
    right: (@Composable RowScope.() -> Unit)? = null,
) {
    SharedDiffFileHeader(DiffFileSummary(path, kind, additions, deletions), modifier, right = right)
}
