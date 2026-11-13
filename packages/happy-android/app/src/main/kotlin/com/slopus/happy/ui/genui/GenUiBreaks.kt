package com.slopus.happy.ui.genui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.IntrinsicMeasurable
import androidx.compose.ui.layout.IntrinsicMeasureScope
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.layout.MultiContentMeasurePolicy
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import com.slopus.happy.genui.Span

/** The break [breakable] allows after an identifier's `_`: a zero-width space, drawn only. */
internal const val BREAK_AFTER_UNDERSCORE = '\u200B'

/**
 * [text] with a break allowed after each `_` between two letters or digits
 * (`STRIPE_SECRET_KEY`), as iOS's GenUITextElement.breakable (baa0587ed).
 * Only for drawing in a column too narrow for the identifier.
 */
internal fun breakable(text: String): String {
    if ('_' !in text) return text
    return buildString(text.length + 4) {
        text.forEachIndexed { i, c ->
            append(c)
            if (c == '_' && i > 0 && i + 1 < text.length && text[i - 1].isLetterOrDigit() && text[i + 1].isLetterOrDigit()) append(BREAK_AFTER_UNDERSCORE)
        }
    }
}

/** The words of [spans] that [breakable] would break, as written. */
internal fun identifiers(spans: List<Span>): List<String> = words(spans).filter { breakable(it) != it }

/** Every piece of [spans] a line may not break inside: its words, cut after an identifier's `_`s. */
internal fun pieces(spans: List<Span>): List<String> = words(spans).flatMap { breakable(it).split(BREAK_AFTER_UNDERSCORE) }.filter { it.isNotEmpty() }.distinct()

private fun words(spans: List<Span>): List<String> = spans.joinToString("") { it.text }.split(Regex("\\s+")).filter { it.isNotEmpty() }.distinct()

/**
 * A text holding identifiers, drawn as written ([written]) where its width
 * holds its widest identifier in [style], and with the identifiers
 * breakable ([breakable]) where it doesn't. Its narrowest readable width
 * (min intrinsic) is the widest of [pieces] in [style]: between spaces and
 * `_` breaks, as iOS measures it. Both are composed and only the one its width calls for is
 * measured and placed, as [SwitchView]'s branches; TalkBack reads the
 * placed one, and a zero-width space reads as nothing.
 */
@Composable
internal fun IdentifierText(
    written: AnnotatedString,
    breakable: AnnotatedString,
    identifiers: List<String>,
    pieces: List<String>,
    style: TextStyle,
    modifier: Modifier,
    text: @Composable (AnnotatedString) -> Unit,
) {
    val measurer = rememberTextMeasurer(cacheSize = 0)
    val policy = remember(identifiers, pieces, style, measurer) { IdentifierPolicy(identifiers, pieces, style, measurer) }
    Layout(listOf({ text(written) }, { text(breakable) }), modifier, policy)
}

private class IdentifierPolicy(
    private val identifiers: List<String>,
    private val pieces: List<String>,
    private val style: TextStyle,
    private val measurer: TextMeasurer,
) : MultiContentMeasurePolicy {
    private var unbroken = 0
    private var widestPiece = 0
    private var measuredFor = Float.NaN to Float.NaN

    /** The widest identifier as written, and the widest piece between breaks, in [style]: once per density and text size. */
    private fun IntrinsicMeasureScope.widths() {
        if (measuredFor == density to fontScale) return
        fun width(word: String) = measurer.measure(word, style, softWrap = false, maxLines = 1, density = this, layoutDirection = layoutDirection).size.width
        unbroken = identifiers.maxOf(::width)
        widestPiece = pieces.maxOfOrNull(::width) ?: 0
        measuredFor = density to fontScale
    }

    private fun IntrinsicMeasureScope.unbroken(): Int = widths().let { unbroken }

    override fun MeasureScope.measure(measurables: List<List<Measurable>>, constraints: Constraints): MeasureResult {
        val (written, breakable) = measurables
        val shown = if (constraints.maxWidth < unbroken()) breakable else written
        val placeables = shown.map { it.measure(constraints) }
        val p = placeables.first()
        return layout(p.width, p.height) { p.placeRelative(0, 0) }
    }

    /** Its narrowest readable width: the widest piece between spaces and `_` breaks (iOS's widestPiece). */
    override fun IntrinsicMeasureScope.minIntrinsicWidth(measurables: List<List<IntrinsicMeasurable>>, height: Int): Int = widths().let { widestPiece }

    override fun IntrinsicMeasureScope.maxIntrinsicWidth(measurables: List<List<IntrinsicMeasurable>>, height: Int): Int =
        measurables[0].first().maxIntrinsicWidth(height)

    override fun IntrinsicMeasureScope.minIntrinsicHeight(measurables: List<List<IntrinsicMeasurable>>, width: Int): Int =
        shown(measurables, width).minIntrinsicHeight(width)

    override fun IntrinsicMeasureScope.maxIntrinsicHeight(measurables: List<List<IntrinsicMeasurable>>, width: Int): Int =
        shown(measurables, width).maxIntrinsicHeight(width)

    /** The one a [width] shows, as [measure] picks it. */
    private fun IntrinsicMeasureScope.shown(measurables: List<List<IntrinsicMeasurable>>, width: Int): IntrinsicMeasurable =
        measurables[if (width < unbroken()) 1 else 0].first()
}
