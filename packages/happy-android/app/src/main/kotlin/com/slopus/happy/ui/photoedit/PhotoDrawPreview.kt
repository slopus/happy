package com.slopus.happy.ui.photoedit

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import kotlin.math.max

/** Display-sized photo and ink. Strokes retain photo coordinates for the full-resolution export. */
internal class PhotoDrawPreview(
    photo: Bitmap,
    width: Int,
    height: Int,
    private val frame: Rect,
    private val toScreen: Matrix,
    strokes: List<PaintStroke>,
) {
    val background = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val ink = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    private val longSide = max(photo.width, photo.height).toFloat()
    private val blur by lazy { PhotoPainting.blurShader(photo) }

    init {
        Canvas(background).apply {
            drawColor(android.graphics.Color.BLACK)
            clipRect(frame.left, frame.top, frame.right, frame.bottom)
            concat(toScreen)
            drawBitmap(photo, 0f, 0f, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        }
        strokes.forEach(::commit)
    }

    fun commit(stroke: PaintStroke) {
        val canvas = Canvas(ink)
        canvas.clipRect(frame.left, frame.top, frame.right, frame.bottom)
        canvas.concat(toScreen)
        draw(canvas, stroke)
    }

    fun redraw(strokes: List<PaintStroke>) {
        ink.eraseColor(0)
        strokes.forEach(::commit)
    }

    fun draw(canvas: Canvas, stroke: PaintStroke, path: Path = PhotoPainting.path(stroke.points)) {
        PhotoPainting.draw(canvas, stroke, if (stroke.tool == PaintTool.Blur) blur else null, longSide, path)
    }
}

/** Append smoothing segments once per pointer sample; copy the points only when the stroke finishes. */
internal class LivePaintStroke(tool: PaintTool, color: Int, weight: Float, first: Offset) {
    private val points = arrayListOf(first)
    private val smoothed = Path().apply { moveTo(first.x, first.y) }
    val stroke = PaintStroke(tool, color, weight, points)

    fun append(point: Offset): Boolean {
        val last = points.last()
        if (PhotoPainting.distance(point, last) <= 1.5f) return false
        smoothed.quadTo(last.x, last.y, (last.x + point.x) / 2, (last.y + point.y) / 2)
        points += point
        return true
    }

    fun path() = Path(smoothed).apply {
        val last = points.last()
        lineTo(last.x + if (points.size == 1) 0.01f else 0f, last.y)
    }

    fun finish() = stroke.copy(points = points.toList())
}