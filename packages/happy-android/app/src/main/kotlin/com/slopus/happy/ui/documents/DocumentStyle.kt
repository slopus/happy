package com.slopus.happy.ui.documents

import android.content.res.Resources
import android.graphics.Typeface
import android.os.Build
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.util.TypedValue
import com.slopus.happy.documents.DocumentBlock
import com.slopus.happy.documents.DocumentLine
import com.slopus.happy.documents.DocumentReader
import com.slopus.happy.documents.DocumentRun
import com.slopus.happy.documents.DocumentSchema
import com.slopus.happy.documents.DocumentText
import com.slopus.happy.documents.yjs.YAny
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * A document's type and colours as desktop's editor draws it (BlockNote
 * 0.51's default theme in happy-desktop-ui `DocumentEditor`,
 * `styles/document-surface.css`), set for a phone's reading width: iOS's
 * `DocumentTokens` and `Palette.document*`. Text in sp, so it follows the
 * system font size; indents and markers in dp.
 */
object DocumentTokens {
    const val BODY_SIZE = 17f
    const val BODY_LINE_HEIGHT = 26f
    const val CODE_SIZE = 15f
    const val CODE_LINE_HEIGHT = 22f

    /** Heading sizes by level, desktop's ramp brought down to a phone. */
    fun headingSize(level: Int): Float = when (level) {
        1 -> 30f
        2 -> 24f
        3 -> 20f
        else -> 18f
    }

    fun headingLineHeight(level: Int): Float = Math.round(headingSize(level) * 1.25f).toFloat()

    /** Space above a block, and above a heading. */
    const val BLOCK_SPACING = 6f
    const val HEADING_SPACING = 14f
    /** Between two list items. */
    const val LIST_SPACING = 2f

    // DocumentIndent.Metrics, DocumentMarkerLayout.Metrics (dp).
    const val LEVEL = 24f
    const val MARKER = 26f
    const val QUOTE = 16f
    const val CODE = 12f
    const val BULLET = 6f
    const val CHECK = 18f
    const val CHECK_CORNER = 5f
    const val CHECK_TARGET = 44f
    const val QUOTE_BAR = 3f
    const val CODE_CORNER = 8f
    const val CODE_VERTICAL = 8f
    const val NUMBER_GAP = 6f
    /** The marker column's optical shift left (iOS draws bullets and boxes 4 left of centre). */
    const val MARKER_SHIFT = 4f
    const val NOTE_HEIGHT = 44f
    const val NOTE_PADDING = 12f
    const val NOTE_SIZE = 15f

    /** `#rrggbb` light and dark. */
    class Palette(val light: Int, val dark: Int) {
        fun of(dark: Boolean) = if (dark) this.dark else light
    }

    private fun rgb(hex: Long) = (0xFF000000 or hex).toInt()

    val text = Palette(rgb(0x000000), rgb(0xffffff))
    val secondary = Palette(rgb(0x6b6b6b), rgb(0xa0a0a0))
    val ground = Palette(rgb(0xffffff), rgb(0x1f1f1f))
    val link = Palette(rgb(0x1a7f99), rgb(0x5cc8e2))
    val codeFill = Palette(rgb(0xf3f3f1), rgb(0x2a2a2a))
    val codeText = Palette(rgb(0xc7254e), rgb(0xff8fa8))
    val rule = Palette(rgb(0xd9d9d9), rgb(0x3d3d3d))
    val check = Palette(rgb(0x1a7f99), rgb(0x5cc8e2))
    val checkTick = Palette(rgb(0xffffff), rgb(0x1f1f1f))
    val done = Palette(rgb(0x9a9a9a), rgb(0x7a7a7a))
    val tool = Palette(rgb(0x000000), rgb(0xffffff))
    val toolActive = Palette(rgb(0x1a7f99), rgb(0x5cc8e2))
    val toolActiveFill = Palette(0x241A8099, 0x335CC7E3)

    /** BlockNote's named colours (`COLORS_DEFAULT`): text, then fill. */
    val namedColors: Map<String, Pair<Int, Int>> = mapOf(
        "gray" to (rgb(0x9b9a97) to rgb(0xebeced)), "brown" to (rgb(0x64473a) to rgb(0xe9e5e3)), "red" to (rgb(0xe03e3e) to rgb(0xfbe4e4)),
        "orange" to (rgb(0xd9730d) to rgb(0xf6e9d9)), "yellow" to (rgb(0xdfab01) to rgb(0xfbf3db)), "green" to (rgb(0x4d6461) to rgb(0xddedea)),
        "blue" to (rgb(0x0b6e99) to rgb(0xddebf1)), "purple" to (rgb(0x6940a5) to rgb(0xeae4f2)), "pink" to (rgb(0xad1a72) to rgb(0xf4dfeb)),
    )
}

/**
 * Turns lines into the text view's paragraphs and back (iOS's
 * `DocumentStyle`). Pure and thread-safe: the whole document is built off
 * the main thread when it opens; the main thread builds only the lines a
 * change touched.
 */
class DocumentStyle(resources: Resources, val dark: Boolean, private val labels: Labels = Labels()) {
    /** Names for blocks without text, as the note in their place says them. */
    class Labels(val picture: String = "Picture", val table: String = "Table", val unsupported: String = "Something Happy can't show here")

    class Colors(dark: Boolean) {
        val text = DocumentTokens.text.of(dark)
        val secondary = DocumentTokens.secondary.of(dark)
        val link = DocumentTokens.link.of(dark)
        val codeFill = DocumentTokens.codeFill.of(dark)
        val codeText = DocumentTokens.codeText.of(dark)
        val rule = DocumentTokens.rule.of(dark)
        val check = DocumentTokens.check.of(dark)
        val checkTick = DocumentTokens.checkTick.of(dark)
        val done = DocumentTokens.done.of(dark)
        val linkUnderline = (link and 0x00FFFFFF) or (0x66 shl 24)
    }

    /** Every size in px, for the spans. */
    class Metrics(resources: Resources, val colors: Colors) {
        private val metrics = resources.displayMetrics
        private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, metrics).roundToInt()
        fun sp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, metrics)

        val level = dp(DocumentTokens.LEVEL)
        val marker = dp(DocumentTokens.MARKER)
        val quote = dp(DocumentTokens.QUOTE)
        val code = dp(DocumentTokens.CODE)
        val bullet = dp(DocumentTokens.BULLET)
        val check = dp(DocumentTokens.CHECK)
        val checkCorner = dp(DocumentTokens.CHECK_CORNER)
        val checkTarget = dp(DocumentTokens.CHECK_TARGET)
        val checkStroke = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 1.5f, metrics)
        val quoteBar = dp(DocumentTokens.QUOTE_BAR)
        val codeCorner = dp(DocumentTokens.CODE_CORNER)
        val codeVertical = dp(DocumentTokens.CODE_VERTICAL)
        val numberGap = dp(DocumentTokens.NUMBER_GAP)
        val markerShift = dp(DocumentTokens.MARKER_SHIFT)
        val hairline = maxOf(1, dp(1f)).toFloat()
        val notePadding = dp(DocumentTokens.NOTE_PADDING).toFloat()
        val noteHeight = dp(DocumentTokens.NOTE_HEIGHT)
        val noteSize = sp(DocumentTokens.NOTE_SIZE)
        val numberSize = sp(DocumentTokens.BODY_SIZE)
        val bodyLineHeight = sp(DocumentTokens.BODY_LINE_HEIGHT).roundToInt()

        /** DocumentIndent: each level of nesting, then the marker column, a quote's bar or a code block's padding. */
        fun indent(kind: DocumentLineKind, depth: Int): Int {
            val lead = when (kind) {
                DocumentLineKind.Bullet, DocumentLineKind.Numbered, DocumentLineKind.Check -> marker
                DocumentLineKind.Quote -> quote
                DocumentLineKind.Code -> code
                else -> 0
            }
            return depth.coerceAtLeast(0) * level + lead
        }
    }

    val colors = Colors(dark)
    val metrics = Metrics(resources, colors)
    /** The text's width less nothing: the view sets it as it lays out, for the objects' notes. */
    @Volatile var textWidth: Int = resources.displayMetrics.widthPixels

    val bodySize: Float = metrics.sp(DocumentTokens.BODY_SIZE)
    private val codeSize = metrics.sp(DocumentTokens.CODE_SIZE)

    fun kind(line: DocumentLine): DocumentLineKind = when (line.block.type) {
        "heading" -> DocumentLineKind.Heading
        "bulletListItem", "toggleListItem" -> DocumentLineKind.Bullet
        "numberedListItem" -> DocumentLineKind.Numbered
        "checkListItem" -> DocumentLineKind.Check
        "quote" -> DocumentLineKind.Quote
        "codeBlock" -> DocumentLineKind.Code
        else -> if (line.block.isInline) DocumentLineKind.Text else DocumentLineKind.Object
    }

    fun textSize(line: DocumentLine): Float = when (line.block.type) {
        "heading" -> metrics.sp(DocumentTokens.headingSize(line.block.level))
        "codeBlock" -> codeSize
        else -> bodySize
    }

    fun lineHeight(line: DocumentLine): Int = when (line.block.type) {
        "heading" -> metrics.sp(DocumentTokens.headingLineHeight(line.block.level))
        "codeBlock" -> metrics.sp(DocumentTokens.CODE_LINE_HEIGHT)
        else -> metrics.sp(DocumentTokens.BODY_LINE_HEIGHT)
    }.roundToInt()

    fun spacingBefore(line: DocumentLine, previous: DocumentLine?): Int {
        previous ?: return 0
        val value = when {
            line.block.type == "heading" -> DocumentTokens.HEADING_SPACING
            line.block.type == "codeBlock" || previous.block.type == "codeBlock" -> DocumentTokens.BLOCK_SPACING
            line.block.type in DocumentSchema.listTypes && previous.block.type in DocumentSchema.listTypes -> DocumentTokens.LIST_SPACING
            else -> DocumentTokens.BLOCK_SPACING
        }
        return metrics.sp(value).roundToInt()
    }

    fun numberText(line: DocumentLine): String? = line.number?.let { "$it." }

    /** One line as its paragraph, its "\n" included. */
    fun paragraph(line: DocumentLine, previous: DocumentLine?): SpannableStringBuilder = paragraphs(listOf(line), previous)

    /**
     * Lines as their paragraphs, after [previous]. All the text goes in
     * before any span: a paragraph span ending at the end of a builder
     * grows over whatever is appended after it, so styling as it is
     * appended would stack every marker's margin onto the lines below.
     */
    fun paragraphs(lines: List<DocumentLine>, previous: DocumentLine?): SpannableStringBuilder {
        val out = SpannableStringBuilder()
        val starts = IntArray(lines.size)
        lines.forEachIndexed { i, line ->
            starts[i] = out.length
            when (val content = line.block.content) {
                is DocumentBlock.Content.Inline -> for (run in content.runs) out.append(run.text.replace('\n', DocumentText.LINE_BREAK))
                else -> out.append(DocumentText.OBJECT)
            }
            out.append('\n')
        }
        var before = previous
        lines.forEachIndexed { i, line ->
            style(out, starts[i], line, before)
            before = line
        }
        return out
    }

    /** The whole document, for opening. */
    fun document(lines: List<DocumentLine>): SpannableStringBuilder = paragraphs(lines, null)

    /**
     * Sets the spans of the paragraph at [start] that shows [line], whose
     * text is already there: the person's typing, read back, keeps its
     * characters (and the keyboard's composing word), only its looks change.
     */
    fun style(text: Spannable, start: Int, line: DocumentLine, previous: DocumentLine?) {
        val length = if (line.block.isInline) line.block.plainText.length else 1
        val end = start + length + 1
        clear(text, start, end)
        val kind = kind(line)
        val lineSpan = DocumentLineSpan(line, kind, numberText(line), metrics, spacingBefore(line, previous), lineHeight(line))
        text.setSpan(lineSpan, start, end, Spanned.SPAN_PARAGRAPH)
        // The paragraph's own type, on its "\n" too so an empty line has its height.
        val size = textSize(line)
        text.setSpan(DocumentLook.Size(size.roundToInt()), start, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
        when (line.block.type) {
            "heading" -> text.setSpan(weight(if (line.block.level == 1) 700 else 600), start, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
            "codeBlock" -> text.setSpan(DocumentLook.Mono(), start, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
        }
        text.setSpan(DocumentLook.Color(colors.text), start, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
        when (val content = line.block.content) {
            is DocumentBlock.Content.Inline -> {
                var at = start
                val code = line.block.type == "codeBlock"
                val done = line.block.type == "checkListItem" && line.block.checked
                for (run in content.runs) {
                    val runEnd = at + run.text.length
                    val extends = "link" !in run.marks && "code" !in run.marks
                    val flags = if (extends) Spanned.SPAN_EXCLUSIVE_INCLUSIVE else Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
                    text.setSpan(DocumentMarksSpan(run.marks), at, runEnd, flags)
                    for (span in looks(run.marks, code, done)) text.setSpan(span, at, runEnd, flags)
                    at = runEnd
                }
                val trailing = content.runs.lastOrNull()?.marks.orEmpty().filterKeys { it != "link" && it != "code" }
                text.setSpan(DocumentMarksSpan(trailing, trailing = true), end - 1, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                if (done) for (span in looks(emptyMap(), code, true)) text.setSpan(span, end - 1, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
            }
            else -> {
                val label = when (line.block.type) {
                    "divider" -> null
                    "image" -> line.block.props["caption"]?.stringValue?.takeIf { it.isNotEmpty() }?.let { "${labels.picture}: $it" } ?: labels.picture
                    "table" -> labels.table
                    else -> labels.unsupported
                }
                text.setSpan(DocumentObjectSpan(line, label, metrics) { textWidth - metrics.indent(DocumentLineKind.Object, 0) }, start, start + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
    }

    /** Takes this style's spans off the text between [start] and [end]; a neighbour's, which only touches it, stays. */
    fun clear(text: Spannable, start: Int, end: Int) {
        for (span in text.getSpans(start, end, Any::class.java)) {
            if (span !is DocumentLineSpan && span !is DocumentMarksSpan && span !is DocumentObjectSpan && span !is DocumentLook) continue
            val s = text.getSpanStart(span)
            val e = text.getSpanEnd(span)
            // Only this paragraph's: a neighbour's ends at its start or starts at its end.
            if ((s < end && e > start) || (s == e && s in start until end)) text.removeSpan(span)
        }
    }

    /** A run's formats as looks: weight, slant, monospace, strike, underline, link and colours. */
    private fun looks(marks: Map<String, YAny>, code: Boolean, done: Boolean): List<CharacterStyle> {
        val out = ArrayList<CharacterStyle>()
        val bold = "bold" in marks
        val italic = "italic" in marks
        if (bold || italic) out += DocumentLook.Style(when {
            bold && italic -> Typeface.BOLD_ITALIC
            bold -> Typeface.BOLD
            else -> Typeface.ITALIC
        })
        if ("code" in marks && !code) {
            out += DocumentLook.Mono()
            out += DocumentLook.Size(codeSize.roundToInt())
            out += DocumentLook.Fill(colors.codeFill)
            out += DocumentLook.Color(colors.codeText)
        }
        if ("strike" in marks || done) out += DocumentLook.Strike()
        if ("underline" in marks) out += DocumentLook.Underline()
        if ("link" in marks) {
            out += DocumentLook.Color(colors.link)
            out += DocumentLook.Underline()
        }
        marks["textColor"]?.let { color(it, text = true) }?.let { out += DocumentLook.Color(it) }
        marks["backgroundColor"]?.let { color(it, text = false) }?.let { out += DocumentLook.Fill(it) }
        if (done) out += DocumentLook.Color(DocumentTokens.done.of(dark))
        return out
    }

    private fun color(mark: YAny, text: Boolean): Int? {
        val name = mark["stringValue"]?.stringValue ?: mark.stringValue ?: return null
        val pair = DocumentTokens.namedColors[name] ?: return null
        return if (text) pair.first else pair.second
    }

    private fun weight(weight: Int): CharacterStyle =
        if (Build.VERSION.SDK_INT >= 28) DocumentLook.Weight(Typeface.create(Typeface.DEFAULT, weight, false)) else DocumentLook.Style(Typeface.BOLD)

    companion object {
        /** A paragraph's runs, read from the text view's text: each character's marks, the run's over the "\n"'s. */
        fun runs(text: Spanned, start: Int, end: Int): List<DocumentRun> {
            val out = ArrayList<DocumentRun>()
            var at = start
            while (at < end) {
                val next = text.nextSpanTransition(at, end, DocumentMarksSpan::class.java).coerceAtMost(end)
                val spans = text.getSpans(at, next, DocumentMarksSpan::class.java)
                    .filter { text.getSpanStart(it) <= at && text.getSpanEnd(it) >= next }
                val marks = (spans.firstOrNull { !it.trailing } ?: spans.firstOrNull())?.marks.orEmpty()
                DocumentReader.append(out, DocumentRun(DocumentText.blockText(text.subSequence(at, next).toString()), marks))
                at = if (next > at) next else end
            }
            return out
        }

        /** How wide a numbered item's number is drawn, for tests. */
        fun numberWidth(style: DocumentStyle, number: String): Int {
            val paint = android.text.TextPaint()
            paint.textSize = style.metrics.numberSize
            paint.fontFeatureSettings = "tnum"
            return ceil(paint.measureText(number)).toInt()
        }
    }
}

/** The looks [DocumentStyle] sets, told apart from spans anything else set (the keyboard's, a paste's). */
sealed interface DocumentLook {
    class Style(style: Int) : android.text.style.StyleSpan(style), DocumentLook
    class Weight(typeface: Typeface) : android.text.style.MetricAffectingSpan(), DocumentLook {
        private val face = typeface
        override fun updateDrawState(tp: android.text.TextPaint) { tp.typeface = face }
        override fun updateMeasureState(tp: android.text.TextPaint) { tp.typeface = face }
    }
    class Mono : TypefaceSpan("monospace"), DocumentLook
    class Size(px: Int) : AbsoluteSizeSpan(px), DocumentLook
    class Fill(color: Int) : BackgroundColorSpan(color), DocumentLook
    class Color(color: Int) : ForegroundColorSpan(color), DocumentLook
    class Strike : StrikethroughSpan(), DocumentLook
    class Underline : UnderlineSpan(), DocumentLook
}
