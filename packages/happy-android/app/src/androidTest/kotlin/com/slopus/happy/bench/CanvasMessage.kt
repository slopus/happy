package com.slopus.happy.bench

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.URLSpan
import android.text.style.UnderlineSpan
import android.view.View
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.layout
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.chat.markdown.SpanStyle

/**
 * The prototype behind research/telegram-chat.md: one agent message laid
 * out once, off the main thread, into StaticLayouts and boxes at fixed
 * offsets, and drawn on one Canvas with no child nodes, as Telegram's
 * ChatMessageCell draws MessageObject's TextLayoutBlocks. It follows
 * AgentMessage's spec (16 in, 10 above and below, MarkdownView's text,
 * headers, lists and code blocks, the 20-high copy row) closely enough to
 * compare frame costs; it is not a replacement and has no selection, links
 * or accessibility.
 */
class CanvasMessageLayout(val height: Int, private val ops: List<Op>) {
    sealed interface Op {
        fun draw(canvas: Canvas)
    }

    class TextOp(private val layout: StaticLayout, private val x: Float, private val y: Float, private val clip: RectF? = null) : Op {
        override fun draw(canvas: Canvas) {
            val save = canvas.save()
            if (clip != null) canvas.clipRect(clip)
            canvas.translate(x, y)
            layout.draw(canvas)
            canvas.restoreToCount(save)
        }
    }

    class BoxOp(private val rect: RectF, private val radius: Float, private val paint: Paint) : Op {
        override fun draw(canvas: Canvas) {
            if (radius > 0) canvas.drawRoundRect(rect, radius, radius, paint) else canvas.drawRect(rect, paint)
        }
    }

    fun draw(canvas: Canvas) {
        for (op in ops) op.draw(canvas)
    }
}

/** The colours the prototype draws in (light theme's). */
class CanvasPalette(val text: Int, val secondary: Int, val surfaceHighest: Int, val divider: Int)

/**
 * Lays a message out at [width] px. Thread-confined: every paint is its
 * own, so any thread may call it, as Telegram builds MessageObject on its
 * storage queue.
 */
class CanvasMessageBuilder(private val density: Float, private val fontScale: Float, private val palette: CanvasPalette) {
    private fun dp(v: Float) = v * density
    private fun sp(v: Float) = v * density * fontScale

    private fun paint(size: Float, mono: Boolean = false, bold: Boolean = false, color: Int = palette.text) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = sp(size)
        this.color = color
        typeface = when {
            mono -> Typeface.MONOSPACE
            bold -> Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            else -> Typeface.DEFAULT
        }
    }

    private val body = paint(16f)
    private val headers = listOf(16f to 24f, 20f to 24f, 16f to 28f, 16f to 24f, 16f to 24f, 16f to 24f)
        .map { (size, line) -> paint(size, bold = true) to line }
    private val headerMargins = listOf(16f to 8f, 16f to 8f, 16f to 8f, 8f to 8f, 0f to 0f, 0f to 0f)
    private val code = paint(14f, mono = true)
    private val language = paint(12f, mono = true, color = palette.secondary)
    private val copy = paint(12f)
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.surfaceHighest }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.divider; style = Paint.Style.STROKE; strokeWidth = dp(1f) }
    private val rule = Paint().apply { color = palette.divider }

    private fun spans(spans: List<MarkdownSpan>): CharSequence {
        val out = SpannableStringBuilder()
        for (span in spans) {
            val start = out.length
            out.append(span.text)
            val end = out.length
            if (SpanStyle.Bold in span.styles || SpanStyle.Semibold in span.styles) out.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (SpanStyle.Italic in span.styles) out.setSpan(StyleSpan(Typeface.ITALIC), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (SpanStyle.Code in span.styles) out.setSpan(TypefaceSpan("monospace"), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            span.url?.let {
                out.setSpan(URLSpan(it), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                out.setSpan(UnderlineSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        return out
    }

    /** A StaticLayout whose lines are [lineHeight] sp apart, as Compose's lineHeight sets them. */
    private fun layout(text: CharSequence, paint: TextPaint, width: Int, lineHeight: Float, wrap: Boolean = true): StaticLayout {
        val metrics = paint.fontMetrics
        val extra = sp(lineHeight) - (metrics.descent - metrics.ascent)
        val measureWidth = if (wrap) width.coerceAtLeast(1) else Layout.getDesiredWidth(text, paint).toInt() + 1
        return StaticLayout.Builder.obtain(text, 0, text.length, paint, measureWidth)
            .setIncludePad(false)
            .setLineSpacing(extra, 1f)
            .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
            .build()
    }

    fun build(blocks: List<MarkdownBlock>, width: Int): CanvasMessageLayout {
        val ops = ArrayList<CanvasMessageLayout.Op>()
        val left = dp(16f)
        val inner = (width - 2 * left).toInt()
        var y = dp(10f)
        for (block in blocks) {
            when (block) {
                is MarkdownBlock.Text -> {
                    y += dp(8f)
                    val l = layout(spans(block.content), body, inner, 25f)
                    ops += CanvasMessageLayout.TextOp(l, left, y)
                    y += l.height + dp(10f)
                }
                is MarkdownBlock.Header -> {
                    val index = (block.level - 1).coerceIn(0, 5)
                    val (paint, line) = headers[index]
                    y += dp(headerMargins[index].first)
                    val l = layout(spans(block.content), paint, inner, line)
                    ops += CanvasMessageLayout.TextOp(l, left, y)
                    y += l.height + dp(headerMargins[index].second)
                }
                is MarkdownBlock.BulletList, is MarkdownBlock.NumberedList -> {
                    val items = if (block is MarkdownBlock.BulletList) {
                        block.items.map { Triple(listOf("•", "◦", "▪")[it.depth.coerceAtMost(2)], it.depth, it.spans) }
                    } else {
                        (block as MarkdownBlock.NumberedList).items.map { Triple("${it.number}.", it.depth, it.spans) }
                    }
                    items.forEachIndexed { i, (marker, depth, content) ->
                        if (i > 0) y += dp(6f)
                        val x = left + dp(16f) * depth
                        val m = layout(marker, body, inner, 25f, wrap = false)
                        val textX = x + m.width + dp(8f)
                        val t = layout(spans(content), body, (left + inner - textX).toInt(), 25f)
                        ops += CanvasMessageLayout.TextOp(m, x, y + dp(1f))
                        ops += CanvasMessageLayout.TextOp(t, textX, y)
                        y += maxOf(t.height.toFloat(), m.height + dp(1f))
                    }
                    y += dp(8f)
                }
                is MarkdownBlock.CodeBlock -> {
                    y += dp(8f)
                    val top = y
                    var inside = 0f
                    val lang = block.language?.let { layout(it, language, inner, 16f, wrap = false) }
                    if (lang != null) {
                        ops += CanvasMessageLayout.TextOp(lang, left + dp(16f), top + dp(8f))
                        inside += dp(8f) + lang.height
                    }
                    val c = layout(block.content, code, inner, 20f, wrap = false)
                    val box = RectF(left, top, left + inner, top + inside + c.height + dp(32f))
                    ops.add(ops.size - (if (lang != null) 1 else 0), CanvasMessageLayout.BoxOp(box, dp(8f), fill))
                    ops += CanvasMessageLayout.TextOp(c, left + dp(16f), top + inside + dp(16f), clip = box)
                    val label = layout("Copy", copy, inner, 16f, wrap = false)
                    val button = RectF(box.right - dp(8f) - label.width - dp(16f), top + dp(8f), box.right - dp(8f), top + dp(8f) + label.height + dp(8f))
                    ops += CanvasMessageLayout.BoxOp(button, dp(4f), fill)
                    ops += CanvasMessageLayout.BoxOp(button, dp(4f), stroke)
                    ops += CanvasMessageLayout.TextOp(label, button.left + dp(8f), button.top + dp(4f))
                    y = box.bottom + dp(8f)
                }
                MarkdownBlock.HorizontalRule -> {
                    y += dp(8f)
                    ops += CanvasMessageLayout.BoxOp(RectF(left, y, left + inner, y + dp(1f)), 0f, rule)
                    y += dp(9f)
                }
                is MarkdownBlock.Table -> {
                    // MarkdownView's TableBlock: columns by their longest text, cells 12/8, a header ground, hairlines.
                    y += dp(8f)
                    val top = y
                    val widths = block.headers.indices.map { c ->
                        val longest = maxOf(block.headers[c].sumOf { it.text.length }, block.rows.maxOfOrNull { r -> r.getOrNull(c)?.sumOf { it.text.length } ?: 0 } ?: 0)
                        dp((longest * 8.5f + 24f).coerceIn(80f, 360f))
                    }
                    val clip = RectF(left, top, left + inner, Float.MAX_VALUE)
                    val rowsOut = listOf(block.headers) + block.rows.map { r -> block.headers.indices.map { r.getOrNull(it).orEmpty() } }
                    rowsOut.forEachIndexed { index, cells ->
                        val layouts = cells.mapIndexed { c, cell -> layout(spans(cell), if (index == 0) headers[0].first else body, (widths[c] - dp(24f)).toInt(), 24f) }
                        val h = (layouts.maxOfOrNull { it.height } ?: 0) + dp(16f)
                        if (index == 0) ops += CanvasMessageLayout.BoxOp(RectF(left, y, left + minOf(inner.toFloat(), widths.sum()), y + h), 0f, fill)
                        var x = left
                        layouts.forEachIndexed { c, l ->
                            ops += CanvasMessageLayout.TextOp(l, x + dp(12f), y + dp(8f), clip)
                            x += widths[c]
                        }
                        y += h
                        if (index < rowsOut.lastIndex) ops += CanvasMessageLayout.BoxOp(RectF(left, y, left + minOf(inner.toFloat(), widths.sum()), y + dp(1f)), 0f, rule)
                    }
                    ops += CanvasMessageLayout.BoxOp(RectF(left, top, left + minOf(inner.toFloat(), widths.sum()), y), dp(8f), stroke)
                    y += dp(8f)
                }
                else -> {
                    val l = layout(block.toString(), body, inner, 25f)
                    ops += CanvasMessageLayout.TextOp(l, left, y)
                    y += l.height
                }
            }
        }
        // The copy row under the text, and the message's own 10 below.
        y += dp(20f) + dp(10f)
        return CanvasMessageLayout(kotlin.math.ceil(y).toInt(), ops)
    }
}

/** The message as one Compose node: a fixed height, one draw, nothing to compose inside. */
@Composable
fun CanvasMessage(layout: CanvasMessageLayout, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Spacer(
        modifier
            .fillMaxWidth()
            .layout { measurable, constraints ->
                val placeable = measurable.measure(constraints.copy(minHeight = layout.height, maxHeight = layout.height))
                layout(placeable.width, layout.height) { placeable.place(0, 0) }
            }
            .drawBehind { drawIntoCanvas { layout.draw(it.nativeCanvas) } },
    )
}

/** The same message as a Telegram-style View cell: no children, measure is a field read, draw is the ops. */
class CanvasMessageView(context: Context) : View(context) {
    var message: CanvasMessageLayout? = null
        set(value) {
            val relayout = field?.height != value?.height
            field = value
            if (relayout) requestLayout()
            invalidate()
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), message?.height ?: 0)
    }

    override fun onDraw(canvas: Canvas) {
        message?.draw(canvas)
    }
}
