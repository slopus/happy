package com.slopus.happy.ui.photoedit

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Shader
import androidx.compose.runtime.Immutable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Where a photo is cut from, Telegram's crop (`Crop/CropView`, `CropState`):
 * a frame [width] × [height] (in the photo's pixels, as the result is
 * shaped) centred on [centerX], [centerY] of the photo, the photo turned
 * [turns] quarter turns anticlockwise and [straighten] degrees (±45, the
 * wheel) under it, and [mirrored] left to right. Zooming in is a smaller
 * frame over the same photo; [ratio] is the locked aspect, 0 when free.
 */
@Immutable
data class PhotoCrop(
    val centerX: Float,
    val centerY: Float,
    val width: Float,
    val height: Float,
    val turns: Int = 0,
    val straighten: Float = 0f,
    val mirrored: Boolean = false,
    val ratio: Float = 0f,
) {
    /** The photo's turn under the frame, degrees: the quarter turns and the wheel. */
    val angle: Float get() = -90f * turns + straighten

    /** Image pixels to the result's pixels: the frame's top left at 0, 0. */
    fun matrix(): Matrix = Matrix().apply {
        postTranslate(-centerX, -centerY)
        postRotate(angle)
        if (mirrored) postScale(-1f, 1f)
        postTranslate(width / 2, height / 2)
    }

    /** Unchanged from a photo of [w] × [h]: nothing turned, mirrored, locked or cut. */
    fun isIdentity(w: Int, h: Int): Boolean =
        turns % 4 == 0 && abs(straighten) < 0.05f && !mirrored && ratio == 0f &&
            abs(width - w) < 1f && abs(height - h) < 1f && abs(centerX - w / 2f) < 1f && abs(centerY - h / 2f) < 1f

    /**
     * Kept inside a photo of [w] × [h], as Telegram keeps its crop: a frame
     * whose turned box is larger than the photo shrinks about its centre
     * (zooming in), then its centre moves until the box is inside. The box
     * of a turned rectangle is what its corners reach, so this is exact.
     */
    fun inside(w: Int, h: Int): PhotoCrop {
        val radians = Math.toRadians(angle.toDouble())
        val c = abs(cos(radians)).toFloat()
        val s = abs(sin(radians)).toFloat()
        var fw = width
        var fh = height
        val boxW = fw * c + fh * s
        val boxH = fw * s + fh * c
        val shrink = min(1f, min(w / boxW, h / boxH))
        fw *= shrink
        fh *= shrink
        val halfW = (fw * c + fh * s) / 2
        val halfH = (fw * s + fh * c) / 2
        return copy(
            width = fw,
            height = fh,
            centerX = centerX.coerceIn(min(halfW, w / 2f), max(w - halfW, w / 2f)),
            centerY = centerY.coerceIn(min(halfH, h / 2f), max(h - halfH, h / 2f)),
        )
    }

    /** A frame of [ratio] (width / height), the largest inside this one, about the same centre. */
    fun locked(ratio: Float): PhotoCrop {
        if (ratio <= 0f) return copy(ratio = 0f)
        val fit = if (width / height > ratio) copy(width = height * ratio) else copy(height = width / ratio)
        return fit.copy(ratio = ratio)
    }

    /** A quarter turn anticlockwise on the screen (clockwise under a mirror): the frame turns with the photo. */
    fun turned(): PhotoCrop = copy(
        turns = ((turns + if (mirrored) 3 else 1) % 4),
        width = height,
        height = width,
        ratio = if (ratio > 0f) 1f / ratio else 0f,
    )

    /** A move of [delta] on the result, as a move over the photo. */
    fun toImageDelta(delta: Offset): Offset {
        val x = if (mirrored) -delta.x else delta.x
        val radians = Math.toRadians(-angle.toDouble())
        val c = cos(radians).toFloat()
        val s = sin(radians).toFloat()
        return Offset(x * c - delta.y * s, x * s + delta.y * c)
    }

    /** A point of the result to the photo's pixels. */
    fun toImage(point: Offset): Offset {
        val inverse = Matrix().also { matrix().invert(it) }
        val values = floatArrayOf(point.x, point.y)
        inverse.mapPoints(values)
        return Offset(values[0], values[1])
    }

    companion object {
        fun whole(w: Int, h: Int) = PhotoCrop(w / 2f, h / 2f, w.toFloat(), h.toFloat())

        /** Telegram's aspect list (`CropView.showAspectRatioDialog`): Original, Square, then these, turned to the frame. */
        val RATIOS = listOf(3 to 2, 5 to 3, 4 to 3, 5 to 4, 7 to 5, 16 to 9)

        const val MAX_STRAIGHTEN = 45f
        /** Telegram's crop zooms to ten times. */
        const val MAX_ZOOM = 10f
    }
}

/** Telegram's brushes (`Paint/Brush.java`), in its order, without shapes. */
enum class PaintTool(
    val defaultColor: Int,
    /** `getDefaultWeight`, 0..1 of the size slider. */
    val defaultSize: Float,
    /** `getAlpha`. */
    val alpha: Float,
    /** `getScale`: the stamp is this much wider than the weight. */
    val scale: Float,
) {
    Pen(PhotoColors.RED, 0.25f, 0.85f, 1f),
    Arrow(PhotoColors.ORANGE, 0.25f, 0.85f, 1f),
    Marker(PhotoColors.YELLOW, 0.5f, 0.45f, 1.5f),
    Neon(PhotoColors.GREEN, 0.5f, 0.7f, 1.45f),
    Blur(0, 1f, 1f, 1f),
    Eraser(0, 1f, 1f, 1f);

    val coloured: Boolean get() = this != Blur && this != Eraser
}

/** Telegram's `PersistColorPalette` presets and its colour picker's custom defaults. */
object PhotoColors {
    const val BLACK = 0xff000000.toInt()
    const val WHITE = 0xffffffff.toInt()
    const val RED = 0xffff453a.toInt()
    const val ORANGE = 0xffff8a00.toInt()
    const val YELLOW = 0xffffd60a.toInt()
    const val GREEN = 0xff34c759.toInt()
    const val LIGHT_BLUE = 0xff63e6e2.toInt()
    const val BLUE = 0xff0a84ff.toInt()
    const val VIOLET = 0xffbf5af2.toInt()

    /** The palette row under the tools. */
    val PRESETS = listOf(RED, ORANGE, YELLOW, GREEN, LIGHT_BLUE, BLUE, VIOLET, BLACK, WHITE)

    /** `ColorPickerBottomSheet.GridPickerView.colors`, a column each. */
    val GRID_HUES = listOf(
        0xFF00A1D8, 0xFF0060FD, 0xFF4C1FB7, 0xFF982BBC, 0xFFB82C5D, 0xFFFD3E12,
        0xFFFF6900, 0xFFFDAB00, 0xFFFCC700, 0xFFFCFA43, 0xFFD9EB37, 0xFF76BA3F,
    ).map { it.toInt() }

    const val GRID_COLUMNS = 12
    const val GRID_ROWS = 10

    /** The grid's colour at [x], [y], as `GridPickerView` builds it: greys on top, each hue darkened above and lightened below its middle. */
    fun grid(x: Int, y: Int): Int {
        if (y == 0) return blend(WHITE, BLACK, x / (GRID_COLUMNS - 1f))
        val middle = GRID_ROWS / 2 + 1
        return if (y < middle) blend(GRID_HUES[x], BLACK, (middle - y - 1) / (GRID_ROWS / 2f - 1) * 0.5f)
        else blend(GRID_HUES[x], WHITE, 0.5f - (GRID_ROWS - y - 1) / (GRID_ROWS / 2f) * 0.5f)
    }

    /** The spectrum's hues top to bottom (`SpectrumPickerView`). */
    val SPECTRUM = listOf(0xffff0000, 0xffffff00, 0xff00ff00, 0xff00ffff, 0xff0000ff, 0xffff00ff, 0xffff0000).map { it.toInt() }

    /**
     * The spectrum's colour at [x], [y] (0..1 across and down): the hue by
     * height, washed white on the left and dark on the right, as its
     * white-clear-clear-black overlay at 0.06, 0.22, 0.78, 0.94 draws it.
     */
    fun spectrum(x: Float, y: Float): Int {
        val along = y.coerceIn(0f, 1f) * (SPECTRUM.size - 1)
        val index = along.toInt().coerceAtMost(SPECTRUM.size - 2)
        val hue = blend(SPECTRUM[index], SPECTRUM[index + 1], along - index)
        val across = x.coerceIn(0f, 1f)
        return when {
            across < 0.22f -> blend(hue, WHITE, ((0.22f - across) / 0.16f).coerceAtMost(1f))
            across > 0.78f -> blend(hue, BLACK, ((across - 0.78f) / 0.16f).coerceAtMost(1f))
            else -> hue
        }
    }

    fun blend(from: Int, to: Int, ratio: Float): Int {
        val r = ratio.coerceIn(0f, 1f)
        fun channel(shift: Int) = (((from ushr shift) and 0xff) * (1 - r) + ((to ushr shift) and 0xff) * r).roundToInt()
        return (channel(24) shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
    }

    fun withAlpha(color: Int, alpha: Float): Int = ((alpha.coerceIn(0f, 1f) * 255).roundToInt() shl 24) or (color and 0xffffff)
}

/** One stroke, in the photo's pixels. */
@Immutable
data class PaintStroke(val tool: PaintTool, val color: Int, val weight: Float, val points: List<Offset>)

/** Everything done to one photo: its crop and its drawing. */
@Immutable
data class PhotoEdit(val crop: PhotoCrop, val strokes: List<PaintStroke> = emptyList()) {
    fun isEmpty(w: Int, h: Int): Boolean = strokes.isEmpty() && crop.isIdentity(w, h)
}

object PhotoPainting {
    /** Telegram's `RenderView.brushWeightForSize`: 8/2048 of the painting's width, and 90/2048 more at full size. */
    fun weight(size: Float, paintingWidth: Float): Float = paintingWidth * (8f + 90f * size.coerceIn(0f, 1f)) / 2048f

    /** The arrow's head: two strokes 0.45 rad either side of its last direction, three weights long at least. */
    fun arrowHead(points: List<Offset>, weight: Float, longSide: Float): List<Pair<Offset, Offset>> {
        if (points.size < 2) return emptyList()
        val tip = points.last()
        // The direction over the last stretch, not the last jitter.
        val from = points.asReversed().firstOrNull { (it - tip).getDistance() > weight * 2 } ?: points.first()
        val heading = atan2(tip.y - from.y, tip.x - from.x)
        val length = max(max(10f, longSide * 0.02f), weight * 3)
        return listOf(-0.45f, 0.45f).map { side ->
            val a = heading + Math.PI.toFloat() + side
            tip to Offset(tip.x + length * cos(a), tip.y + length * sin(a))
        }
    }

    fun path(points: List<Offset>): Path = Path().apply {
        if (points.isEmpty()) return@apply
        moveTo(points[0].x, points[0].y)
        if (points.size == 1) {
            lineTo(points[0].x + 0.01f, points[0].y)
            return@apply
        }
        // Quadratic through the midpoints, as a finger's line is smoothed.
        for (i in 1 until points.size) {
            val a = points[i - 1]
            val b = points[i]
            quadTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2)
        }
        lineTo(points.last().x, points.last().y)
    }

    /**
     * Draws [stroke] on [canvas], in the photo's pixels. [blur] paints the
     * photo blurred, for the blur brush ([blurShader]); the eraser clears what
     * is under it, so the drawing is a layer of its own.
     */
    fun draw(canvas: Canvas, stroke: PaintStroke, blur: Shader?, longSide: Float) {
        val path = path(stroke.points)
        val width = stroke.weight * stroke.tool.scale
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeJoin = Paint.Join.ROUND
            strokeCap = Paint.Cap.ROUND
            strokeWidth = width
        }
        when (stroke.tool) {
            PaintTool.Pen -> canvas.drawPath(path, paint.apply { color = PhotoColors.withAlpha(stroke.color, alphaOf(stroke.color) * stroke.tool.alpha) })
            PaintTool.Arrow -> {
                paint.color = PhotoColors.withAlpha(stroke.color, alphaOf(stroke.color) * stroke.tool.alpha)
                arrowHead(stroke.points, width, longSide).forEach { (a, b) -> path.moveTo(a.x, a.y); path.lineTo(b.x, b.y) }
                canvas.drawPath(path, paint)
            }
            PaintTool.Marker -> canvas.drawPath(path, paint.apply {
                strokeCap = Paint.Cap.SQUARE
                strokeJoin = Paint.Join.BEVEL
                color = PhotoColors.withAlpha(stroke.color, alphaOf(stroke.color) * stroke.tool.alpha)
            })
            PaintTool.Neon -> {
                // The glow in the colour, then a white core: Telegram's "light" shaders.
                canvas.drawPath(path, Paint(paint).apply {
                    color = PhotoColors.withAlpha(stroke.color, alphaOf(stroke.color) * stroke.tool.alpha)
                    maskFilter = BlurMaskFilter(max(1f, width * 0.6f), BlurMaskFilter.Blur.NORMAL)
                })
                canvas.drawPath(path, Paint(paint).apply {
                    color = PhotoColors.withAlpha(stroke.color, alphaOf(stroke.color))
                    strokeWidth = width * 0.55f
                })
                canvas.drawPath(path, Paint(paint).apply {
                    color = PhotoColors.withAlpha(PhotoColors.WHITE, 0.9f * alphaOf(stroke.color))
                    strokeWidth = width * 0.3f
                })
            }
            PaintTool.Blur -> if (blur != null) canvas.drawPath(path, paint.apply { shader = blur })
            PaintTool.Eraser -> canvas.drawPath(path, paint.apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR) })
        }
    }

    private fun alphaOf(color: Int): Float = (color ushr 24) / 255f

    /**
     * The photo blurred, for the blur brush, in the photo's pixels: shrunk
     * to 48 on its long side, smoothed back up to a quarter, and stretched
     * over the photo by the shader, so it costs a sixteenth of the photo.
     */
    fun blurShader(photo: Bitmap): Shader {
        val long = max(photo.width, photo.height)
        val small = 48f / long
        val tiny = Bitmap.createScaledBitmap(photo, max(1, (photo.width * small).roundToInt()), max(1, (photo.height * small).roundToInt()), true)
        val quarter = Bitmap.createScaledBitmap(tiny, max(1, photo.width / 4), max(1, photo.height / 4), true)
        if (quarter !== tiny) tiny.recycle()
        return BitmapShader(quarter, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
            setLocalMatrix(Matrix().apply { setScale(photo.width / quarter.width.toFloat(), photo.height / quarter.height.toFloat()) })
        }
    }

    /** The drawing of [strokes] on a clear layer the photo's size. */
    fun layer(w: Int, h: Int, strokes: List<PaintStroke>, blur: Shader?): Bitmap {
        val layer = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(layer)
        val long = max(w, h).toFloat()
        strokes.forEach { draw(canvas, it, blur, long) }
        return layer
    }

    /** The photo as edited: drawn on, then cut and turned by its crop. */
    fun render(photo: Bitmap, edit: PhotoEdit, blur: Shader? = null): Bitmap {
        val crop = edit.crop
        val out = Bitmap.createBitmap(max(1, crop.width.roundToInt()), max(1, crop.height.roundToInt()), Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.drawColor(android.graphics.Color.BLACK)
        val matrix = crop.matrix()
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(photo, matrix, paint)
        if (edit.strokes.isNotEmpty()) {
            val shader = blur ?: if (edit.strokes.any { it.tool == PaintTool.Blur }) blurShader(photo) else null
            val layer = layer(photo.width, photo.height, edit.strokes, shader)
            canvas.drawBitmap(layer, matrix, paint)
            layer.recycle()
        }
        return out
    }

    /** The scale that fits a [w] × [h] frame inside [areaW] × [areaH]. */
    fun fit(w: Float, h: Float, areaW: Float, areaH: Float): Float = min(areaW / w, areaH / h)

    fun distance(a: Offset, b: Offset): Float = hypot(a.x - b.x, a.y - b.y)
}

/** The side or corner of the crop frame a finger holds (`CropAreaView.Control`). */
enum class CropHandle(val left: Boolean, val top: Boolean, val right: Boolean, val bottom: Boolean) {
    TopLeft(true, true, false, false),
    TopRight(false, true, true, false),
    BottomRight(false, false, true, true),
    BottomLeft(true, false, false, true),
    Top(false, true, false, false),
    Right(false, false, true, false),
    Bottom(false, false, false, true),
    Left(true, false, false, false);

    val corner: Boolean get() = (left || right) && (top || bottom)
}

/**
 * The crop's gestures, on the screen: the frame is shown [scale] screen px
 * to each of its own, the photo fixed under it while a handle moves.
 */
object PhotoCropping {
    /** The handle within [reach] of [point] on [frame], corners before sides; null when the finger is on neither. */
    fun handle(frame: Rect, point: Offset, reach: Float): CropHandle? {
        if (point.x < frame.left - reach || point.x > frame.right + reach || point.y < frame.top - reach || point.y > frame.bottom + reach) return null
        val left = abs(point.x - frame.left) <= reach
        val right = !left && abs(point.x - frame.right) <= reach
        val top = abs(point.y - frame.top) <= reach
        val bottom = !top && abs(point.y - frame.bottom) <= reach
        return CropHandle.entries.firstOrNull { it.left == left && it.right == right && it.top == top && it.bottom == bottom }
    }

    /**
     * [frame] with [handle]'s sides moved by [delta]: at least [min] each
     * way and inside [area]; with a [ratio], the side moved most leads and
     * the frame keeps its shape about the side or corner across from it.
     */
    fun resize(frame: Rect, handle: CropHandle, delta: Offset, ratio: Float, min: Float, area: Rect): Rect {
        var left = frame.left
        var top = frame.top
        var right = frame.right
        var bottom = frame.bottom
        if (handle.left) left = (left + delta.x).coerceIn(area.left, right - min)
        if (handle.right) right = (right + delta.x).coerceIn(left + min, area.right)
        if (handle.top) top = (top + delta.y).coerceIn(area.top, bottom - min)
        if (handle.bottom) bottom = (bottom + delta.y).coerceIn(top + min, area.bottom)
        if (ratio <= 0f) return Rect(left, top, right, bottom)
        var width = right - left
        var height = bottom - top
        if (handle.corner) {
            if (abs(delta.x) >= abs(delta.y)) height = width / ratio else width = height * ratio
        } else if (handle.left || handle.right) height = width / ratio else width = height * ratio
        val anchorX = when { handle.left -> frame.right; handle.right -> frame.left; else -> frame.center.x }
        val anchorY = when { handle.top -> frame.bottom; handle.bottom -> frame.top; else -> frame.center.y }
        val roomX = when { handle.left -> anchorX - area.left; handle.right -> area.right - anchorX; else -> 2 * min(anchorX - area.left, area.right - anchorX) }
        val roomY = when { handle.top -> anchorY - area.top; handle.bottom -> area.bottom - anchorY; else -> 2 * min(anchorY - area.top, area.bottom - anchorY) }
        val shrink = min(1f, min(roomX / width, roomY / height))
        width *= shrink
        height *= shrink
        val grow = min(max(1f, max(min / width, min / height)), min(roomX / width, roomY / height))
        width *= grow
        height *= grow
        val x = when { handle.left -> anchorX - width; handle.right -> anchorX; else -> anchorX - width / 2 }
        val y = when { handle.top -> anchorY - height; handle.bottom -> anchorY; else -> anchorY - height / 2 }
        return Rect(x, y, x + width, y + height)
    }

    /** The crop once its frame, shown at [from] on the screen, is at [to] over the same photo. */
    fun reframed(crop: PhotoCrop, from: Rect, to: Rect, scale: Float): PhotoCrop {
        val shift = crop.toImageDelta((to.center - from.center) / scale)
        return crop.copy(centerX = crop.centerX + shift.x, centerY = crop.centerY + shift.y, width = to.width / scale, height = to.height / scale)
    }

    /** Whether all of [crop]'s frame is over a photo of [w] × [h]. */
    fun fits(crop: PhotoCrop, w: Int, h: Int): Boolean {
        val kept = crop.inside(w, h)
        return abs(kept.width - crop.width) < 0.5f && abs(kept.height - crop.height) < 0.5f &&
            abs(kept.centerX - crop.centerX) < 0.5f && abs(kept.centerY - crop.centerY) < 0.5f
    }

    /** The frame as far from [from] towards [to] as the photo under it reaches. */
    fun furthest(crop: PhotoCrop, from: Rect, to: Rect, scale: Float, w: Int, h: Int): Rect {
        if (fits(reframed(crop, from, to, scale), w, h)) return to
        var low = 0f
        var high = 1f
        repeat(14) {
            val middle = (low + high) / 2
            if (fits(reframed(crop, from, lerp(from, to, middle), scale), w, h)) low = middle else high = middle
        }
        return lerp(from, to, low)
    }

    /** The photo moved [delta] on the screen under the frame, kept under all of it. */
    fun panned(crop: PhotoCrop, delta: Offset, scale: Float, w: Int, h: Int): PhotoCrop {
        val shift = crop.toImageDelta(delta / scale)
        return crop.copy(centerX = crop.centerX - shift.x, centerY = crop.centerY - shift.y).inside(w, h)
    }

    /** Pinched [zoom] times: the frame covers that much less of the photo, to [PhotoCrop.MAX_ZOOM] at most, and no more than all of it. */
    fun zoomed(crop: PhotoCrop, zoom: Float, w: Int, h: Int): PhotoCrop {
        val smallest = max(w, h) / PhotoCrop.MAX_ZOOM
        val factor = min(zoom, max(crop.width, crop.height) / smallest).coerceAtLeast(0.01f)
        return crop.copy(width = crop.width / factor, height = crop.height / factor).inside(w, h)
    }

    private fun lerp(a: Rect, b: Rect, t: Float) =
        Rect(a.left + (b.left - a.left) * t, a.top + (b.top - a.top) * t, a.right + (b.right - a.right) * t, a.bottom + (b.bottom - a.bottom) * t)
}
