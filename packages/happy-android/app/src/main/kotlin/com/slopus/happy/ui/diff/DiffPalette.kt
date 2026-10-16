package com.slopus.happy.ui.diff

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.diff.DiffLayout
import com.slopus.happy.diff.DiffLineType
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.RnLineHeightStyle
import kotlin.math.ceil
import kotlin.math.roundToInt

object DiffTags {
    const val CHUNK = "diff.chunk"
    const val FILE = "diff.file"
    const val GUTTER = "diff.gutter"
    const val LINE = "diff.line"
    const val HUNK = "diff.hunk"
    const val MESSAGE = "diff.message"
    const val SHOW_MORE = "diff.showMore"
    const val HEADER = "diff.header"
    const val SPLIT_ROW = "diff.splitRow"
    const val IMAGE = "diff.image"
    const val CHEVRON = "diff.chevron"
    const val SIZE_HINT = "diff.sizeHint"
    const val SPINNER = "diff.spinner"
    const val SYNTAX_PENDING = "diff.syntaxPending"
    const val SYNTAX_READY = "diff.syntaxReady"
}

/** DiffPalette.ts over theme.ts `diff.*`: the renderer's flat colour set. */
@Immutable
data class DiffPalette(
    val surface: Color,
    val rowAdd: Color,
    val rowDel: Color,
    val gutterAdd: Color,
    val gutterDel: Color,
    val gutterBorder: Color,
    val lineNumber: Color,
    val markerAdd: Color,
    val markerDel: Color,
    val wordAdd: Color,
    val wordDel: Color,
    val hunkBg: Color,
    val hunkText: Color,
    val sectionText: Color,
    val syntax: Map<SpanKind, Color>,
    val divider: Color,
    val text: Color,
    val textSecondary: Color,
) {
    val plain: Color get() = syntax.getValue(SpanKind.Plain)

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

/** theme.ts light `diff` (tuned against GitHub's light diff). */
private val lightSyntax = mapOf(
    SpanKind.Plain to c(0x1F2328), SpanKind.Keyword to c(0xCF222E), SpanKind.Str to c(0x0A3069),
    SpanKind.Comment to c(0x6E7781), SpanKind.Number to c(0x0550AE), SpanKind.Function to c(0x8250DF),
    SpanKind.Operator to c(0x0550AE), SpanKind.Punctuation to c(0x1F2328), SpanKind.Type to c(0x953800),
    SpanKind.Variable to c(0x953800), SpanKind.Tag to c(0x116329), SpanKind.Attr to c(0x0550AE),
)

private val darkSyntax = mapOf(
    SpanKind.Plain to c(0xE6EDF3), SpanKind.Keyword to c(0xFF7B72), SpanKind.Str to c(0xA5D6FF),
    SpanKind.Comment to c(0x8B949E), SpanKind.Number to c(0x79C0FF), SpanKind.Function to c(0xD2A8FF),
    SpanKind.Operator to c(0x79C0FF), SpanKind.Punctuation to c(0xE6EDF3), SpanKind.Type to c(0xFFA657),
    SpanKind.Variable to c(0xFFA657), SpanKind.Tag to c(0x7EE787), SpanKind.Attr to c(0x79C0FF),
)

/** useDiffPalette. */
@Composable
@ReadOnlyComposable
fun diffPalette(): DiffPalette {
    val colors = HappyTheme.colors
    return if (colors.dark) {
        DiffPalette(
            surface = colors.surface, rowAdd = c(0x12261E), rowDel = c(0x25171C), gutterAdd = c(0x1B4721), gutterDel = c(0x78191B),
            gutterBorder = c(0x21262D), lineNumber = c(0x6E7681), markerAdd = c(0x3FB950), markerDel = c(0xF85149),
            wordAdd = c(0x1F6F2E), wordDel = c(0x8B2C2F), hunkBg = c(0x161B22), hunkText = c(0x58A6FF), sectionText = c(0x8B949E),
            syntax = darkSyntax, divider = colors.divider, text = colors.text, textSecondary = colors.textSecondary,
        )
    } else {
        DiffPalette(
            surface = colors.surface, rowAdd = c(0xE6FFEC), rowDel = c(0xFFEBE9), gutterAdd = c(0xCCFFD8), gutterDel = c(0xFFD7D5),
            gutterBorder = c(0xD8DEE4), lineNumber = c(0x959DA5), markerAdd = c(0x1A7F37), markerDel = c(0xCF222E),
            wordAdd = c(0xABF2BC), wordDel = c(0xFFC1C0), hunkBg = c(0xF1F8FF), hunkText = c(0x005CC5), sectionText = c(0x6E7781),
            syntax = lightSyntax, divider = colors.divider, text = colors.text, textSecondary = colors.textSecondary,
        )
    }
}

/**
 * DiffMetrics.tsx: mono text at [fontSize] (12 on phones), lines
 * `round(fontSize x 1.5)` high, the font's measured advance width, and
 * layout.ts's gutter width from it.
 */
@Immutable
data class DiffMetrics(val fontSize: Float, val lineHeight: Dp, val charWidth: Dp) {
    /** Mono at [fontSize], every line [lineHeight] high. */
    val code: TextStyle get() = TextStyle(fontFamily = PlexMono, fontSize = fontSize.sp, lineHeight = lineHeight.value.sp, lineHeightStyle = RnLineHeightStyle)

    /** Line numbers and hunk headers: one size down, same line height. */
    val small: TextStyle get() = code.copy(fontSize = (fontSize - 1).sp)

    fun gutterWidth(maxLineNo: Int, showLineNumbers: Boolean): Dp = DiffLayout.gutterWidth(charWidth.value, maxLineNo, showLineNumbers).dp

    /** Two characters, the marker column. */
    val markerWidth: Dp get() = ceil(charWidth.value * 2).dp

    companion object {
        const val DEFAULT_FONT_SIZE = 12f
    }
}

/** useDiffMetrics with MonoProbe: 50 Ms measured once per size. */
@Composable
fun rememberDiffMetrics(fontSize: Float = DiffMetrics.DEFAULT_FONT_SIZE): DiffMetrics {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    return remember(fontSize, measurer, density) {
        val lineHeight = (fontSize * 1.5f).roundToInt().dp
        val probe = DiffMetrics(fontSize, lineHeight, 0.dp)
        val width = measurer.measure("M".repeat(50), probe.code).size.width / 50f
        val charWidth = with(density) { width.toDp() }.takeIf { it.value in fontSize * 0.35f..fontSize * 1.2f } ?: (fontSize * 0.6f).dp
        probe.copy(charWidth = charWidth)
    }
}
