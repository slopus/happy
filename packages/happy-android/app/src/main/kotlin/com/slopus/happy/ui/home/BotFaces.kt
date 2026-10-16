package com.slopus.happy.ui.home

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.Immutable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import com.slopus.happy.model.BOT_FACE_PAINT_SIZE
import com.slopus.happy.model.BOT_FACE_STYLE_ASSET
import com.slopus.happy.model.BotFace
import com.slopus.happy.model.BotFaceStyle
import com.slopus.happy.model.FaceFill
import com.slopus.happy.model.FaceShape
import com.slopus.happy.model.resolveBotFace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** One filled shape of a face, in the style's 400 units, already where the canvas puts it. */
@Immutable
class FaceStroke(val path: Path, val color: Color)

/** A face ready to draw at any size: the background, then its shapes in order. */
@Immutable
class BotFacePicture(val seed: String, val width: Float, val height: Float, val background: Color?, val strokes: List<FaceStroke>)

/** The picture for a resolved face. SVG fills inherit, so a shape without one takes its group's. */
fun botFacePicture(face: BotFace): BotFacePicture {
    val strokes = ArrayList<FaceStroke>()
    fun add(shape: FaceShape, inherited: FaceFill?, x: Float, y: Float) {
        val fill = shape.fill ?: inherited
        when (shape) {
            is FaceShape.Group -> shape.children.forEach { add(it, fill, x, y) }
            is FaceShape.Path -> {
                val color = face.color(fill)?.let(::parseFaceColor) ?: return
                val path = PathParser().parsePathString(normalizePathData(shape.d)).toPath()
                if (shape.evenOdd) path.fillType = PathFillType.EvenOdd
                path.translate(Offset(x, y))
                strokes += FaceStroke(path, color)
            }
            is FaceShape.Ellipse -> {
                val color = face.color(fill)?.let(::parseFaceColor) ?: return
                val path = Path().apply { addOval(Rect(x + shape.cx - shape.rx, y + shape.cy - shape.ry, x + shape.cx + shape.rx, y + shape.cy + shape.ry)) }
                strokes += FaceStroke(path, color)
            }
        }
    }
    // The root's fill="none": a shape with no fill anywhere above it draws nothing.
    face.parts.forEach { part -> part.shapes.forEach { add(it, null, part.x, part.y) } }
    return BotFacePicture(face.seed, face.width, face.height, face.background?.let(::parseFaceColor), strokes)
}

/** Draws [picture] over this scope's whole size, which should be square. */
fun DrawScope.drawBotFace(picture: BotFacePicture) {
    scale(size.width / picture.width, size.height / picture.height, pivot = Offset.Zero) {
        picture.background?.let { drawRect(it, size = Size(picture.width, picture.height)) }
        picture.strokes.forEach { drawPath(it.path, it.color) }
    }
}

/**
 * paintBotFace: the face as PNG bytes, [BOT_FACE_PAINT_SIZE] square. The
 * daemon keeps raster pictures only, so it is painted off screen here,
 * nothing mounted, while the bot is being made.
 */
fun paintBotFace(picture: BotFacePicture, size: Int = BOT_FACE_PAINT_SIZE): ByteArray {
    val image = ImageBitmap(size, size)
    CanvasDrawScope().draw(Density(1f), LayoutDirection.Ltr, Canvas(image), Size(size.toFloat(), size.toFloat())) { drawBotFace(picture) }
    val bytes = ByteArrayOutputStream()
    check(image.asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, bytes)) { "The face could not be painted." }
    check(bytes.size() > 0) { "The face could not be painted." }
    return bytes.toByteArray()
}

/** The colours the style writes: `#rrggbb` and a couple of names. */
internal fun parseFaceColor(value: String): Color? {
    val hex = value.removePrefix("#")
    if (value.startsWith("#")) {
        val full = when (hex.length) {
            3 -> hex.map { "$it$it" }.joinToString("")
            6 -> hex
            else -> return null
        }
        return full.toLongOrNull(16)?.let { Color(0xFF000000 or it) }
    }
    return when (value.lowercase()) {
        "white" -> Color.White
        "black" -> Color.Black
        else -> null
    }
}

/**
 * Path data as Compose's parser reads it. SVG lets an arc's two flags run
 * into what follows ("0 01-3.2"), being a single digit each; a number
 * reader would take "01" for one number, so every token is spelled out
 * apart.
 */
internal fun normalizePathData(d: String): String {
    val out = StringBuilder(d.length + 16)
    var i = 0
    var command = ' '
    var argument = 0
    while (i < d.length) {
        val c = d[i]
        when {
            c.isLetter() && c != 'e' && c != 'E' -> {
                command = c
                argument = 0
                out.append(c).append(' ')
                i++
            }
            c == ' ' || c == ',' || c == '\n' || c == '\t' || c == '\r' -> i++
            else -> {
                val arc = command == 'a' || command == 'A'
                val flag = arc && (argument % 7 == 3 || argument % 7 == 4)
                val end = if (flag) i + 1 else numberEnd(d, i)
                out.append(d, i, end).append(' ')
                argument++
                i = end
            }
        }
    }
    return out.toString().trimEnd()
}

private fun numberEnd(d: String, start: Int): Int {
    var j = start
    if (j < d.length && (d[j] == '-' || d[j] == '+')) j++
    var dot = false
    var exponent = false
    while (j < d.length) {
        val c = d[j]
        when {
            c.isDigit() -> j++
            c == '.' && !dot && !exponent -> {
                dot = true
                j++
            }
            (c == 'e' || c == 'E') && !exponent -> {
                exponent = true
                j++
                if (j < d.length && (d[j] == '-' || d[j] == '+')) j++
            }
            else -> break
        }
    }
    return if (j == start) start + 1 else j
}

/**
 * The bundled style, read once off the main thread, and the faces drawn
 * from it, kept for the seeds on offer.
 */
class BotFaces(private val readStyle: () -> String) {
    private val lock = Mutex()
    private var style: BotFaceStyle? = null
    private val pictures = object : LinkedHashMap<String, BotFacePicture>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, BotFacePicture>) = size > 32
    }

    /** The credit the picker shows; null until the style has been read. */
    val loadedStyle: BotFaceStyle? get() = style

    suspend fun style(): BotFaceStyle = lock.withLock {
        style ?: withContext(Dispatchers.IO) { BotFaceStyle.parse(readStyle()) }.also { style = it }
    }

    suspend fun picture(seed: String): BotFacePicture {
        synchronized(pictures) { pictures[seed] }?.let { return it }
        val style = style()
        val picture = withContext(Dispatchers.Default) { botFacePicture(resolveBotFace(style, seed)) }
        synchronized(pictures) { pictures[seed] = picture }
        return picture
    }

    suspend fun paint(seed: String): ByteArray {
        val picture = picture(seed)
        return withContext(Dispatchers.Default) { paintBotFace(picture) }
    }

    companion object {
        fun assets(context: Context) = BotFaces { context.assets.open(BOT_FACE_STYLE_ASSET).bufferedReader().use { it.readText() } }
    }
}
