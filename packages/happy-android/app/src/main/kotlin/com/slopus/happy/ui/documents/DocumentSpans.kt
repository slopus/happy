package com.slopus.happy.ui.documents

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.PersistableBundle
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.LeadingMarginSpan
import android.text.style.LineBackgroundSpan
import android.text.style.LineHeightSpan
import android.text.style.ReplacementSpan
import android.text.style.TtsSpan
import com.slopus.happy.documents.DocumentBlock
import com.slopus.happy.documents.DocumentLine
import com.slopus.happy.documents.yjs.YAny
import kotlin.math.roundToInt

/** The kinds of line a document draws something beside (iOS's `DocumentLineKind`). */
enum class DocumentLineKind { Text, Heading, Bullet, Numbered, Check, Quote, Code, Object }

/**
 * What the text view knows of the line a paragraph shows, on the whole
 * paragraph, its "\n" included (iOS's `.documentLine` attribute and
 * `DocumentLayoutFragment`): enough to read it back, and to draw it. It
 * indents the paragraph ([DocumentIndent]), sets its line height and the
 * space above it, and draws its marker beside the text: a bullet, a
 * number, a task's box, a quote's bar or a code block's fill. The markers
 * aren't characters, so the text and the document's text agree offset for
 * offset, and the caret can't land inside a bullet.
 */
class DocumentLineSpan(
    val line: DocumentLine,
    val kind: DocumentLineKind,
    /** A numbered item's number as drawn ("3."). */
    val number: String?,
    private val metrics: DocumentStyle.Metrics,
    /** Space above the paragraph, px. */
    private val spacingBefore: Int,
    /** Each line's height, px. */
    private val lineHeight: Int,
) : LeadingMarginSpan, LineHeightSpan, LineBackgroundSpan {
    val id: String get() = line.id
    private val indent = metrics.indent(kind, line.depth)
    private val codeVertical = if (kind == DocumentLineKind.Code) metrics.codeVertical else 0

    override fun getLeadingMargin(first: Boolean): Int = indent

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val spanned = text as? Spanned ?: return
        val spanStart = spanned.getSpanStart(this)
        val spanEnd = spanned.getSpanEnd(this)
        // The line height as a fixed box, the extra split as CSS does; an object's line is as tall as the object.
        if (kind != DocumentLineKind.Object) {
            val natural = fm.descent - fm.ascent
            val extra = this.lineHeight - natural
            fm.ascent -= extra / 2
            fm.descent += extra - extra / 2
            fm.top = minOf(fm.top, fm.ascent)
            fm.bottom = maxOf(fm.bottom, fm.descent)
        }
        if (start == spanStart) {
            fm.ascent -= spacingBefore + codeVertical
            fm.top -= spacingBefore + codeVertical
        }
        if (end == spanEnd || (end == spanEnd - 1 && text.getOrNull(end) == '\n')) {
            fm.descent += codeVertical
            fm.bottom += codeVertical
        }
    }

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        val spanned = text as? Spanned ?: return
        val spanStart = spanned.getSpanStart(this)
        val paragraphFirst = start == spanStart
        val lineTop = top + if (paragraphFirst) spacingBefore + codeVertical else 0
        val base = x + dir * metrics.level * line.depth.coerceAtLeast(0)
        val column = metrics.marker
        val saved = p.color
        val style = p.style
        p.isAntiAlias = true
        when (kind) {
            DocumentLineKind.Quote -> {
                p.color = metrics.colors.rule
                p.style = Paint.Style.FILL
                val left = if (dir > 0) base else base - metrics.quoteBar
                c.drawRect(left.toFloat(), lineTop.toFloat(), (left + metrics.quoteBar).toFloat(), bottom.toFloat(), p)
            }
            DocumentLineKind.Bullet, DocumentLineKind.Check, DocumentLineKind.Numbered -> if (paragraphFirst) {
                val centerY = (lineTop + bottom) / 2f
                when (kind) {
                    DocumentLineKind.Bullet -> {
                        p.color = metrics.colors.text
                        p.style = Paint.Style.FILL
                        val cx = base + dir * ((column - metrics.bullet) / 2f - metrics.markerShift + metrics.bullet / 2f)
                        c.drawCircle(cx, centerY, metrics.bullet / 2f, p)
                    }
                    DocumentLineKind.Check -> {
                        val size = metrics.check.toFloat()
                        val left = base + dir * ((column - metrics.check) / 2f - metrics.markerShift) - if (dir < 0) size else 0f
                        val box = RectF(left, centerY - size / 2, left + size, centerY + size / 2)
                        val radius = metrics.checkCorner.toFloat()
                        if (line.block.checked) {
                            p.style = Paint.Style.FILL
                            p.color = metrics.colors.check
                            c.drawRoundRect(box, radius, radius, p)
                            p.color = metrics.colors.checkTick
                            p.style = Paint.Style.STROKE
                            p.strokeWidth = size / 9f
                            p.strokeCap = Paint.Cap.ROUND
                            p.strokeJoin = Paint.Join.ROUND
                            val tick = Path().apply {
                                moveTo(box.left + size * 0.26f, box.top + size * 0.52f)
                                lineTo(box.left + size * 0.43f, box.top + size * 0.69f)
                                lineTo(box.left + size * 0.75f, box.top + size * 0.34f)
                            }
                            c.drawPath(tick, p)
                        } else {
                            p.style = Paint.Style.STROKE
                            p.strokeWidth = metrics.checkStroke
                            p.color = metrics.colors.rule
                            val half = metrics.checkStroke / 2
                            c.drawRoundRect(RectF(box.left + half, box.top + half, box.right - half, box.bottom - half), radius, radius, p)
                        }
                    }
                    else -> {
                        val label = number ?: return
                        val paint = TextPaint(p)
                        paint.textSize = metrics.numberSize
                        paint.color = metrics.colors.text
                        paint.style = Paint.Style.FILL
                        paint.fontFeatureSettings = "tnum"
                        val width = paint.measureText(label)
                        val right = base + dir * (column - metrics.numberGap)
                        val left = if (dir > 0) maxOf(base.toFloat(), right - width) else right.toFloat()
                        c.drawText(label, left, baseline.toFloat(), paint)
                    }
                }
            }
            else -> Unit
        }
        p.color = saved
        p.style = style
    }

    override fun drawBackground(canvas: Canvas, paint: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, lineNumber: Int) {
        if (kind != DocumentLineKind.Code) return
        val spanned = text as? Spanned ?: return
        val first = start == spanned.getSpanStart(this)
        val last = end >= spanned.getSpanEnd(this) || (end == spanned.getSpanEnd(this) - 1)
        val saved = paint.color
        val style = paint.style
        paint.color = metrics.colors.codeFill
        paint.style = Paint.Style.FILL
        paint.isAntiAlias = true
        val inset = metrics.level * line.depth.coerceAtLeast(0)
        val rect = RectF((left + inset).toFloat(), (top + if (first) spacingBefore else 0).toFloat(), right.toFloat(), bottom.toFloat())
        val r = metrics.codeCorner.toFloat()
        val radii = floatArrayOf(
            if (first) r else 0f, if (first) r else 0f, if (first) r else 0f, if (first) r else 0f,
            if (last) r else 0f, if (last) r else 0f, if (last) r else 0f, if (last) r else 0f,
        )
        canvas.drawPath(Path().apply { addRoundRect(rect, radii, Path.Direction.CW) }, paint)
        paint.color = saved
        paint.style = style
    }

    /** Where a tap toggles this line's task, in the paragraph's first line's frame: a 44 dp target around the box. */
    fun taskTarget(x: Int, lineTop: Int, lineBottom: Int, rtl: Boolean, width: Int): RectF? {
        if (kind != DocumentLineKind.Check) return null
        val base = if (rtl) width - x - metrics.level * line.depth else x + metrics.level * line.depth
        val box = (metrics.marker - metrics.check) / 2f - metrics.markerShift
        val left = if (rtl) base - box - metrics.check else base + box
        val top = lineTop + spacingBefore
        val cy = top + (lineBottom - top) / 2f
        val grow = (metrics.checkTarget - metrics.check) / 2f
        return RectF(left - grow, cy - metrics.check / 2f - grow, left + metrics.check + grow, cy + metrics.check / 2f + grow)
    }

    private fun CharSequence.getOrNull(index: Int): Char? = if (index in indices) this[index] else null
}

/**
 * A run's formats exactly as the document stores them (iOS's
 * `.documentMarks`): what reading the text back takes. [trailing] is the
 * one on a paragraph's "\n", what text typed into an empty line carries.
 */
class DocumentMarksSpan(val marks: Map<String, YAny>, val trailing: Boolean = false)

/**
 * A block without text (a divider, a picture, a table, something this
 * editor can't show), drawn in its line's U+FFFC (iOS's
 * `DocumentObjectAttachment`): a divider's rule across the middle of one
 * line; a picture once read at its own size (a pixel to a point, as iOS),
 * no wider than the text, and until then a 16:9 note with its caption; a
 * table's cells on a grid, 32 a row; the others a rounded note naming what
 * is there.
 */
class DocumentObjectSpan(
    private val line: DocumentLine,
    private val label: String?,
    private val metrics: DocumentStyle.Metrics,
    /** The text's width, less the paragraph's indent. */
    private val width: () -> Int,
) : ReplacementSpan() {
    private val divider = line.block.type == "divider"
    private val image = line.block.type == "image"
    /** A table's cells' text, row by row (iOS draws them on a grid; editing them is desktop's). */
    val rows: List<List<String>>? = (line.block.content as? DocumentBlock.Content.Table)?.rows?.map { row -> row.map { cell -> cell.joinToString("") { it.text } } }
    /** The picture, if it has been read (`DocumentPictures`). */
    val picture: DocumentPicture? = if (image) line.block.props["url"]?.stringValue?.takeIf { it.isNotEmpty() }?.let(DocumentPictures::cached) else null

    /** How wide the picture shows in [w]: its own width, no wider. */
    private fun pictureWidth(w: Int): Int = picture?.let { minOf(w, (it.width * metrics.density).roundToInt()) } ?: w

    private fun height(w: Int): Int = when {
        divider -> metrics.bodyLineHeight
        rows != null -> maxOf(1, rows.size) * metrics.tableRow
        image -> picture?.takeIf { it.width > 0 }?.let { (pictureWidth(w).toFloat() * it.height / it.width).roundToInt() } ?: (w * 9f / 16).roundToInt()
        else -> metrics.noteHeight
    }

    private fun textWidth() = maxOf(1, width() - metrics.level * line.depth.coerceAtLeast(0) - 1)

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val w = textWidth()
        if (fm != null) {
            val h = maxOf(1, height(w))
            fm.ascent = -h * 3 / 4
            fm.descent = h + fm.ascent
            fm.top = fm.ascent
            fm.bottom = fm.descent
        }
        return w
    }

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val w = textWidth().toFloat()
        val saved = paint.color
        val style = paint.style
        paint.isAntiAlias = true
        val h = maxOf(1, height(w.toInt()))
        val boxTop = bottom - h.toFloat()
        val picture = picture
        if (picture != null) {
            val r = metrics.codeCorner.toFloat()
            val box = RectF(x, boxTop, x + pictureWidth(w.toInt()), bottom.toFloat())
            val clip = Path().apply { addRoundRect(box, r, r, Path.Direction.CW) }
            canvas.save()
            canvas.clipPath(clip)
            paint.isFilterBitmap = true
            canvas.drawBitmap(picture.bitmap, null, box, paint)
            canvas.restore()
        } else if (rows != null) {
            drawTable(canvas, rows, x, boxTop, w, h.toFloat(), paint)
        } else if (divider) {
            paint.color = metrics.colors.rule
            paint.style = Paint.Style.FILL
            val ruleY = (boxTop + h / 2f - metrics.hairline / 2f).roundToInt().toFloat()
            canvas.drawRect(x, ruleY, x + w, ruleY + metrics.hairline, paint)
        } else {
            paint.color = metrics.colors.codeFill
            paint.style = Paint.Style.FILL
            val r = metrics.codeCorner.toFloat()
            canvas.drawRoundRect(RectF(x, boxTop, x + w, bottom.toFloat()), r, r, paint)
            if (label != null) {
                val textPaint = TextPaint(paint)
                textPaint.color = metrics.colors.secondary
                textPaint.textSize = metrics.noteSize
                val fm = textPaint.fontMetrics
                val baseline = boxTop + h / 2f - (fm.ascent + fm.descent) / 2f
                val shown = android.text.TextUtils.ellipsize(label, textPaint, w - metrics.notePadding * 2, android.text.TextUtils.TruncateAt.END)
                // A picture not read yet has its caption in the middle (iOS's `DocumentObjectLayout.centered`).
                val left = if (image) x + (w - textPaint.measureText(shown, 0, shown.length)) / 2 else x + metrics.notePadding
                canvas.drawText(shown, 0, shown.length, left, baseline, textPaint)
            }
        }
        paint.color = saved
        paint.style = style
    }

    /** iOS's `DocumentObjectLayout.Table`: a rounded grid, the rows and columns even, each cell's text 8 in and centred down. */
    private fun drawTable(canvas: Canvas, rows: List<List<String>>, x: Float, top: Float, w: Float, h: Float, paint: Paint) {
        val rowCount = maxOf(1, rows.size)
        val columns = maxOf(1, rows.maxOfOrNull { it.size } ?: 1)
        val cellWidth = w / columns
        val rowHeight = h / rowCount
        val stroke = paint.strokeWidth
        paint.color = metrics.colors.rule
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = metrics.hairline
        val half = metrics.hairline / 2
        canvas.drawRoundRect(RectF(x + half, top + half, x + w - half, top + h - half), metrics.tableCorner, metrics.tableCorner, paint)
        for (r in 1 until rowCount) canvas.drawLine(x, top + r * rowHeight, x + w, top + r * rowHeight, paint)
        for (c in 1 until columns) canvas.drawLine(x + c * cellWidth, top, x + c * cellWidth, top + h, paint)
        paint.strokeWidth = stroke
        val textPaint = TextPaint(paint).apply {
            style = Paint.Style.FILL
            color = metrics.colors.text
            textSize = metrics.cellSize
        }
        val fm = textPaint.fontMetrics
        for ((r, row) in rows.withIndex()) {
            val baseline = top + r * rowHeight + rowHeight / 2 - (fm.ascent + fm.descent) / 2
            for ((c, cell) in row.withIndex()) {
                val room = maxOf(0f, cellWidth - metrics.cellPadding * 2)
                val shown = android.text.TextUtils.ellipsize(cell, textPaint, room, android.text.TextUtils.TruncateAt.END)
                canvas.drawText(shown, 0, shown.length, x + c * cellWidth + metrics.cellPadding, baseline, textPaint)
            }
        }
    }
}

/** An object's name for TalkBack, over its placeholder character. */
class DocumentObjectSpeech(val spoken: String) : TtsSpan(TYPE_TEXT, PersistableBundle().apply { putString(ARG_TEXT, spoken) })
