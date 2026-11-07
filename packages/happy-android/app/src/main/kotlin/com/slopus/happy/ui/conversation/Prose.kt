package com.slopus.happy.ui.conversation

import android.graphics.Picture
import android.os.Looper
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle as ComposeSpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.chat.markdown.SpanStyle
import com.slopus.happy.chat.markdown.isHttpMarkdownLink
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.ui.chat.MarkdownSpec
import com.slopus.happy.ui.chat.MessageSpec
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyColors
import java.util.IdentityHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max

/**
 * Where prose rows are laid out: the transcript's content column, [column]
 * pixels wide ([com.slopus.happy.ui.layout.contentMaxWidth]), and how text
 * is measured. Two geometries are equal when they lay text out the same.
 */
@Immutable
class ProseGeometry(val column: Int, val density: Density, val rtl: Boolean) {
    /** The same, with this composition's density and direction. */
    fun at(density: Density, rtl: Boolean): ProseGeometry =
        if (sameDensity(density) && rtl == this.rtl) this else ProseGeometry(column, density, rtl)

    fun withColumn(column: Int): ProseGeometry = if (column == this.column) this else ProseGeometry(column, density, rtl)

    private fun sameDensity(other: Density) = other.density == density.density && other.fontScale == density.fontScale

    override fun equals(other: Any?): Boolean =
        other is ProseGeometry && other.column == column && other.rtl == rtl && sameDensity(other.density)

    override fun hashCode(): Int = (column * 31 + density.density.hashCode()) * 31 + density.fontScale.hashCode() * 2 + if (rtl) 1 else 0

    override fun toString(): String = "ProseGeometry($column px, ${density.density}x, font ${density.fontScale}, ${if (rtl) "rtl" else "ltr"})"

    internal fun px(dp: Dp): Int = with(density) { dp.roundToPx() }
}

/** Which row a text is: each sits at its own width in the column and draws its own way. */
enum class ProseKind {
    /** An answer: [MarkdownView][com.slopus.happy.ui.chat.MarkdownView] at the column less 16 a side, the full width. */
    Answer,
    /** A person's bubble: the same Markdown, 12 further in a side, as wide as its widest line. */
    User,
    /** Another agent's message: the "From another agent" line, then the Markdown, at the answer's width. */
    Collaborator,
    /** The model's thinking, opened: plain 14/20 text in the secondary colour, 4 under its line. */
    Reasoning,
    ;

    /** Between the column's edge and the text, either side. */
    fun inset(geometry: ProseGeometry): Int = when (this) {
        User -> geometry.px(MessageSpec.userPaddingHorizontal) + geometry.px(MessageSpec.bubblePaddingHorizontal)
        else -> geometry.px(MessageSpec.agentMarginHorizontal)
    }

    /** How wide this kind's text may run in [geometry]'s column. */
    fun available(geometry: ProseGeometry): Int = (geometry.column - 2 * inset(geometry)).coerceAtLeast(1)
}

/**
 * One row's text as it will be laid out: [text] is what it says, [blocks]
 * its Markdown, [label] a line drawn over it (a collaborator's).
 */
@Immutable
class ProseSource(val key: String, val kind: ProseKind, val text: String, val blocks: List<MarkdownBlock>, val label: String? = null) {
    /** Whether [other] lays out as this does; the text compared last, and by identity first. */
    fun same(other: ProseSource): Boolean =
        kind == other.kind && label == other.label && (text === other.text || text == other.text)
}

/**
 * A row's text laid out, as Telegram's MessageObject holds its
 * TextLayoutBlocks: built off the main thread for [geometry], at
 * [available] pixels, into [segments] the row stacks. A [DrawnSegment] is
 * text and rules the row draws in one node; a [ComposedSegment] is a block
 * that stays a composable (code, tables, options, pictures, diagrams,
 * buttons).
 */
@Immutable
class Prose internal constructor(
    val source: ProseSource,
    val geometry: ProseGeometry,
    val available: Int,
    val segments: List<ProseSegment>,
    internal val parts: List<ProsePart>,
) {
    /** The drawn text, top to bottom: what the screen reader reads and the tests find. */
    val pieces: List<ProsePiece> get() = segments.flatMap { (it as? DrawnSegment)?.parts?.flatMap(ProsePart::pieces).orEmpty() }
}

sealed interface ProseSegment

/**
 * Blocks drawn together, [parts] stacked at [tops]; [width] is the widest
 * of them, [height] their total. [recording] is the segment drawn ahead on
 * the lane, glyphs shaped, for one palette and width: the row plays it back
 * rather than drawing its texts, which would shape them on the main thread.
 */
@Immutable
class DrawnSegment internal constructor(internal val parts: List<ProsePart>, internal val tops: IntArray, val width: Int, val height: Int) : ProseSegment {
    /** Every piece's words, in order, for semantics. */
    val texts: List<AnnotatedString> = parts.flatMap { part -> part.pieces.map { it.text } }
    val hasLinks: Boolean = texts.any { it.hasLinkAnnotations(0, it.length) }
    internal val recording = mutableStateOf<ProseRecording?>(null)
}

/** The colours a drawn row paints in: its text, its secondary text, its rules. */
@Immutable
data class ProsePalette(val text: Color, val secondary: Color, val divider: Color) {
    companion object {
        fun of(colors: HappyColors) = ProsePalette(colors.text, colors.textSecondary, colors.divider)
    }
}

/** A segment drawn into [picture] in [palette], [width] pixels wide. */
internal class ProseRecording(val palette: ProsePalette, val width: Int, val picture: Picture)

/** A block the row composes, as MarkdownView does. */
@Immutable
class ComposedSegment(val block: MarkdownBlock) : ProseSegment

/**
 * One block's drawing: its [pieces] and [rules] from its own top, [height]
 * tall with its margins, [width] as wide as it draws (the whole width for
 * a list or a rule, which fill it in MarkdownView).
 */
@Immutable
class ProsePart internal constructor(
    internal val block: MarkdownBlock?,
    internal val label: String?,
    val pieces: List<ProsePiece>,
    internal val rules: IntArray,
    val width: Int,
    val height: Int,
)

/**
 * A laid-out text at [x] from the start edge and [y] from its part's top:
 * a paragraph, a header, a list item or its marker, a label. [secondary]
 * draws it in the secondary colour; [reveals] is false for a list's marker,
 * which a streaming reveal shows whole, as MarkdownView's does.
 */
@Immutable
class ProsePiece internal constructor(
    val text: AnnotatedString,
    val layout: TextLayoutResult,
    val x: Int,
    val y: Int,
    val secondary: Boolean = false,
    val reveals: Boolean = true,
)

/** Where text was laid out on the main thread; tests make it throw ([strict]), the benchmark counts it. */
object ProseThread {
    @Volatile var strict = false

    /** Builds that ran on the main thread since the process started. */
    val mainBuilds = AtomicInteger()

    /** Segments a row drew by playing back what the lane drew ahead. */
    val playbacks = AtomicInteger()

    fun check() {
        if (!Looper.getMainLooper().isCurrentThread) return
        mainBuilds.incrementAndGet()
        if (strict) throw MainThreadLayoutException()
    }
}

class MainThreadLayoutException : IllegalStateException("Prose laid out on the main thread")

private val LinkUnderline = ComposeSpanStyle(textDecoration = TextDecoration.Underline)

/**
 * MarkdownView's RenderSpans for a drawn row: the same styles, http(s)
 * links and the app's own (references, Happy URLs) as [LinkAnnotation.Url]
 * (for hit tests and semantics) with their underline as a style, since nothing applies a link's styles to a
 * measured text but [androidx.compose.foundation.text.BasicText].
 */
internal fun proseSpans(spans: List<MarkdownSpan>): AnnotatedString = buildAnnotatedString {
    for (span in spans) {
        val style = ComposeSpanStyle(
            fontWeight = if (SpanStyle.Bold in span.styles || SpanStyle.Semibold in span.styles) FontWeight.SemiBold else null,
            fontStyle = if (SpanStyle.Italic in span.styles) FontStyle.Italic else null,
            fontFamily = if (SpanStyle.Code in span.styles) AppMono else null,
        )
        val url = span.url
        if (url != null && (isHttpMarkdownLink(url) || HappyReferences.opensInApp(url))) {
            withLink(LinkAnnotation.Url(url)) { withStyle(style.merge(LinkUnderline)) { append(span.text) } }
        } else if (url != null && HappyReferences.mention(url) != null) {
            // A person this phone named (never a link an agent typed): in the strong face, opening nothing.
            withStyle(style.copy(fontWeight = FontWeight.SemiBold)) { append(span.text) }
        } else if (SpanStyle.Code in span.styles) {
            // A long press on it takes it whole (desktop 3e08585d), not the word under the finger.
            pushStringAnnotation(INLINE_CODE, "")
            withStyle(style) { append(span.text) }
            pop()
        } else {
            withStyle(style) { append(span.text) }
        }
    }
}

/** The annotation over an inline code span in a drawn row's text ([proseSpans]). */
internal const val INLINE_CODE = "inline-code"

/**
 * Lays rows' text out with Compose's own text engine ([TextMeasurer]), so a
 * drawn row is pixel for pixel what MarkdownView's Texts measure. One per
 * thread: a measurer is not to be shared, the font resolver is.
 */
internal class ProseBuilder(resolver: FontFamily.Resolver) {
    private val measurer = TextMeasurer(resolver, Density(1f), LayoutDirection.Ltr, cacheSize = 0)

    /** [text] in [style] as a Text in [constraints] measures it. */
    fun measure(text: AnnotatedString, style: TextStyle, constraints: Constraints, geometry: ProseGeometry): TextLayoutResult {
        ProseThread.check()
        return measurer.measure(
            text,
            style,
            constraints = constraints,
            layoutDirection = if (geometry.rtl) LayoutDirection.Rtl else LayoutDirection.Ltr,
            density = geometry.density,
        )
    }

    /**
     * [source] at [geometry]. Blocks that are the same objects as in
     * [previous] (a streaming answer's settled paragraphs, which LiveText
     * keeps) keep their parts when the geometry is the same, so a delta lays
     * out only what grew.
     */
    fun build(source: ProseSource, geometry: ProseGeometry, previous: Prose? = null): Prose {
        val available = source.kind.available(geometry)
        val reuse = IdentityHashMap<MarkdownBlock, ProsePart>()
        var reusedLabel: ProsePart? = null
        if (previous != null && previous.geometry == geometry && previous.source.kind == source.kind) {
            for (part in previous.parts) {
                if (part.block != null) reuse[part.block] = part
                else if (part.label == source.label) reusedLabel = part
            }
        }
        val parts = ArrayList<ProsePart>()
        val segments = ArrayList<ProseSegment>()
        val drawn = ArrayList<ProsePart>()
        fun flush() {
            if (drawn.isEmpty()) return
            val tops = IntArray(drawn.size)
            var y = 0
            var width = 0
            drawn.forEachIndexed { i, part ->
                tops[i] = y
                y += part.height
                width = max(width, part.width)
            }
            segments += DrawnSegment(drawn.toList(), tops, width, y)
            drawn.clear()
        }
        fun add(part: ProsePart) {
            parts += part
            drawn += part
        }
        when (source.kind) {
            ProseKind.Reasoning -> add(reasoning(source.text, geometry, available))
            else -> {
                source.label?.let { label -> add(reusedLabel ?: label(label, geometry, available)) }
                for (block in source.blocks) {
                    val part = reuse[block] ?: part(block, geometry, available)
                    if (part == null) {
                        flush()
                        segments += ComposedSegment(block)
                    } else {
                        add(part)
                    }
                }
            }
        }
        flush()
        return Prose(source, geometry, available, segments, parts)
    }

    private fun text(spans: List<MarkdownSpan>, style: TextStyle, geometry: ProseGeometry, width: Int, x: Int = 0, y: Int = 0, fixed: Boolean = false): ProsePiece {
        val text = proseSpans(spans)
        val constraints = if (fixed) Constraints.fixedWidth(width.coerceAtLeast(0)) else Constraints(maxWidth = width.coerceAtLeast(0))
        return ProsePiece(text, measure(text, style, constraints, geometry), x, y)
    }

    /** One block as MarkdownView lays it out, or null for one it composes. */
    private fun part(block: MarkdownBlock, geometry: ProseGeometry, available: Int): ProsePart? = when (block) {
        is MarkdownBlock.Text -> {
            val top = geometry.px(MarkdownSpec.textMarginTop)
            val piece = text(block.content, MarkdownSpec.text, geometry, available, y = top)
            ProsePart(block, null, listOf(piece), NO_RULES, piece.layout.size.width, top + piece.layout.size.height + geometry.px(MarkdownSpec.textMarginBottom))
        }
        is MarkdownBlock.Header -> {
            val (style, margins) = MarkdownSpec.headers[(block.level - 1).coerceIn(0, 5)]
            val top = geometry.px(margins.first)
            val piece = text(block.content, style, geometry, available, y = top)
            ProsePart(block, null, listOf(piece), NO_RULES, piece.layout.size.width, top + piece.layout.size.height + geometry.px(margins.second))
        }
        is MarkdownBlock.BulletList -> list(block, block.items.map { Triple(MarkdownSpec.bullets[it.depth.coerceAtMost(2)], it.depth, it.spans) }, geometry, available)
        is MarkdownBlock.NumberedList -> list(block, block.items.map { Triple("${it.number}.", it.depth, it.spans) }, geometry, available)
        MarkdownBlock.HorizontalRule -> {
            val margin = geometry.px(MarkdownSpec.ruleMargin)
            val line = geometry.px(1.dp)
            ProsePart(block, null, emptyList(), intArrayOf(margin, line), available, margin + line + margin)
        }
        is MarkdownBlock.CodeBlock, is MarkdownBlock.Mermaid, is MarkdownBlock.Options, is MarkdownBlock.Table, is MarkdownBlock.Image, is MarkdownBlock.Buttons -> null
    }

    /**
     * ListBlock: rows [MarkdownSpec.listGap] apart, 8 below; each row [listIndent]
     * a depth in, the marker 1 down and 8 before its text, which takes the rest
     * of the row as its fixed width (the Row's weight).
     */
    private fun list(block: MarkdownBlock, items: List<Triple<String, Int, List<MarkdownSpan>>>, geometry: ProseGeometry, available: Int): ProsePart {
        val pieces = ArrayList<ProsePiece>(items.size * 2)
        val gap = geometry.px(MarkdownSpec.listGap)
        val markerTop = geometry.px(1.dp)
        val markerEnd = geometry.px(MarkdownSpec.bulletGap)
        var y = 0
        items.forEachIndexed { i, (marker, depth, spans) ->
            if (i > 0) y += gap
            val indent = geometry.px(MarkdownSpec.listIndent * depth)
            val room = (available - indent).coerceAtLeast(0)
            val mark = AnnotatedString(marker)
            val markLayout = measure(mark, MarkdownSpec.text, Constraints(maxWidth = (room - markerEnd).coerceAtLeast(0)), geometry)
            val markWidth = markLayout.size.width + markerEnd
            val item = text(spans, MarkdownSpec.text, geometry, room - markWidth, x = indent + markWidth, y = y, fixed = true)
            pieces += ProsePiece(mark, markLayout, indent, y + markerTop, reveals = false)
            pieces += item
            y += max(markLayout.size.height + markerTop, item.layout.size.height)
        }
        return ProsePart(block, null, pieces, NO_RULES, available, y + geometry.px(MarkdownSpec.listMarginBottom))
    }

    /** A collaborator's "From another agent": 13/18 semibold, secondary, over the Markdown. */
    private fun label(label: String, geometry: ProseGeometry, available: Int): ProsePart {
        val text = AnnotatedString(label)
        val layout = measure(text, ConversationRowSpec.label, Constraints(maxWidth = available), geometry)
        return ProsePart(null, label, listOf(ProsePiece(text, layout, 0, 0, secondary = true, reveals = false)), NO_RULES, layout.size.width, layout.size.height)
    }

    /** An opened thought: 14/20 secondary, 4 under the line that opens it. */
    private fun reasoning(words: String, geometry: ProseGeometry, available: Int): ProsePart {
        val text = AnnotatedString(words)
        val top = geometry.px(ReasoningSpec.bodyGap)
        val layout = measure(text, ConversationRowSpec.body, Constraints(maxWidth = available), geometry)
        return ProsePart(null, null, listOf(ProsePiece(text, layout, 0, top, secondary = true, reveals = false)), NO_RULES, layout.size.width, top + layout.size.height)
    }

    private companion object {
        val NO_RULES = IntArray(0)
    }
}

/** The thinking row's own measures (ConversationRowSpec has the type). */
object ReasoningSpec {
    val gap = 4.dp
    val bodyGap = 4.dp
}
