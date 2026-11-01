package com.slopus.happy.ui.chat

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import kotlinx.coroutines.flow.first
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Telegram's streaming reveal (`MultiLayoutTypingAnimator`, `ui/MultiLayoutTypingAnimator.java`
 * at 3de37c8): a caret runs through the answer's lines at
 * max(40 dp/s, what is left / 1.05 s), worked out again each time more words
 * come, so it is never more than about a second behind. Lines before it are
 * whole; the line it is on shows up to the caret and fades out over the last
 * 50 dp before it; nothing after it is drawn. The row is only as tall as the
 * caret's line (plus its own bottom margin) and never shrinks while words
 * come; it grows to each new line over 250 ms on Telegram's list curve, so the
 * list moves a line at a time, smoothly, however the words arrive. Once the
 * answer is done and the caret has reached its end the row grows to its whole
 * height, copy button and all, and the reveal steps out of the way.
 *
 * The row is laid out a line taller at once and the list ([RevealHost]) is
 * drawn that much lower, easing back up: the 250 ms are frames of one layer's
 * translation, with one layout a line, as Telegram's item animator moves
 * views and lays out once. The new line comes up from under the dock's fade.
 */
object TextRevealSpec {
    const val MIN_SPEED_DP_PER_SECOND = 40f
    const val TARGET_SECONDS = 1.05f
    val fade = 50.dp
    const val HEIGHT_MILLIS = 250

    /** `ChatListItemAnimator.DEFAULT_INTERPOLATOR`. */
    val easing = CubicBezierEasing(0.199f, 0.011f, 0.279f, 0.910f)
}

/** The list a revealing row grows in; null where nothing need move with it. */
interface RevealHost {
    /** Row [key] was laid out [delta] pixels taller: keep what the reader looks at still. */
    fun grew(key: Any, delta: Int)

    /** Row [key] is [pixels] shorter on screen than laid out, easing to 0: draw the list that much lower where the row's foot is its end. */
    fun lag(key: Any, pixels: Float)
}

val LocalRevealHost = staticCompositionLocalOf<RevealHost?> { null }

/** The reveal the texts under this point register with; null outside a revealing row. */
val LocalTextReveal = staticCompositionLocalOf<TextReveal?> { null }

/**
 * One streaming row's reveal: the texts it holds register ([revealText]),
 * the row's outermost box wears [revealHeight], and [run] drives both, one
 * step a frame, sleeping while the caret has caught up and nothing changed.
 * A frame of the caret changes one text's mask and, while a line grows in,
 * the list's lag: no composition, no layout, and no text measured or
 * recorded again. A line reached is one layout of the row.
 */
@Stable
class TextReveal internal constructor(
    private val density: Float,
    /** Show what is there at once, and reveal only what comes after. */
    startAtEnd: Boolean,
    /** The row's own bottom margin, kept under the caret's line. */
    private val bottomPadding: Float,
    internal val key: Any,
    internal val host: RevealHost?,
) {
    internal sealed interface Mask {
        data object Whole : Mask
        data object None : Mask
        data class Line(val line: Int, val x: Float) : Mask
    }

    /**
     * One text of the row, with its lines' extents measured once per layout:
     * a Text's own node, or a text drawn at [origin] in a node that draws
     * several ([coordinates] then being that node's).
     */
    inner class Piece internal constructor(internal val layout: State<TextLayoutResult?>) {
        internal var coordinates: LayoutCoordinates? = null
        internal var origin = Offset.Zero
        internal var mask by mutableStateOf<Mask>(if (startPending) Mask.Whole else Mask.None)
        internal var top = 0f
        internal var left = 0f
        internal var seen: TextLayoutResult? = null

        private var measured: TextLayoutResult? = null
        private var starts = FloatArray(0)
        private var ends = FloatArray(0)

        internal val lines: Int get() = layout.value?.lineCount ?: 0

        private fun extent(line: Int) {
            val text = layout.value ?: return
            if (text !== measured) {
                measured = text
                starts = FloatArray(text.lineCount) { Float.NaN }
                ends = FloatArray(text.lineCount)
            }
            if (starts[line].isNaN()) {
                val a = text.getLineLeft(line)
                val b = text.getLineRight(line)
                starts[line] = min(a, b)
                ends[line] = max(a, b)
            }
        }

        internal fun start(line: Int): Float = extent(line).let { starts[line] }
        internal fun end(line: Int): Float = extent(line).let { ends[line] }
        internal fun width(line: Int): Float = end(line) - start(line)
    }

    private val pieces = ArrayList<Piece>()
    private var version by mutableIntStateOf(0)
    /** Put the caret at the end of what is there once the texts have laid out. */
    private var startPending = startAtEnd

    private var caret: Piece? = null
    private var line = 0
    private var x = 0f
    private var speed = TextRevealSpec.MIN_SPEED_DP_PER_SECOND * density
    private var lastFrame = 0L

    internal var root: LayoutCoordinates? = null
    /** The row's whole height, as last measured. */
    internal var natural = 0

    /** How tall the row is on screen, easing to [laid]; NaN until the caret has been placed, the row then as tall as it first measured ([first]). */
    private var height = if (startAtEnd) Float.NaN else 0f
    /** How tall the row is laid out: the height's target, set once a line; -1 for [first]. */
    internal var laid by mutableIntStateOf(if (startAtEnd) -1 else 0)
        private set
    /** The row's height when it first measured: a row met mid-answer keeps it until the caret moves on, so new words never show all at once. */
    internal var first = -1
    private var heightFrom = 0f
    private var heightTo = if (startAtEnd) Float.NaN else 0f
    private var heightStart = 0L

    /** Everything is shown and the row is its whole height: the reveal does nothing more. */
    var done by mutableStateOf(false)
        private set

    internal fun register(piece: Piece) {
        pieces += piece
        version++
    }

    internal fun unregister(piece: Piece) {
        pieces -= piece
        if (caret === piece) caret = null
        version++
    }

    /** Runs the reveal until it is [done]; [streaming] false once no more words will come. */
    suspend fun run(streaming: State<Boolean>) {
        while (!done) {
            var idle = false
            withFrameNanos { idle = step(it, streaming.value) }
            if (idle) {
                lastFrame = 0L
                val watched = watch(streaming.value)
                snapshotFlow { watch(streaming.value) }.first { it != watched }
            }
        }
    }

    private data class Watch(val version: Int, val layouts: List<Int>, val streaming: Boolean)

    private fun watch(streaming: Boolean) = Watch(version, pieces.map { System.identityHashCode(it.layout.value) }, streaming)

    /** One frame; true when there is nothing to do until something changes. */
    internal fun step(frame: Long, streaming: Boolean): Boolean {
        val dt = if (lastFrame == 0L) 0f else (frame - lastFrame) / 1e9f
        lastFrame = frame
        val rootCoordinates = root?.takeIf { it.isAttached }
        val order = pieces.filter { piece ->
            val coordinates = piece.coordinates?.takeIf { it.isAttached } ?: return@filter false
            if (piece.lines == 0) return@filter false
            if (rootCoordinates != null) {
                val at = rootCoordinates.localPositionOf(coordinates, piece.origin)
                piece.top = at.y
                piece.left = at.x
            }
            true
        }.sortedWith(compareBy<Piece>({ it.top }, { it.left }))
        if (order.isEmpty()) return if (streaming) true else finish(frame)

        if (startPending) {
            startPending = false
            caret = order.last()
            line = order.last().lines - 1
            x = order.last().width(line)
        }
        var index = order.indexOf(caret)
        if (index < 0) {
            // The caret's text went (the words turned into a list or code): on from the first one not yet whole.
            index = order.indexOfFirst { it.mask != Mask.Whole }.let { if (it < 0) order.lastIndex else it }
            caret = order[index]
            line = 0
            x = 0f
        }
        val changed = order.any { it.layout.value !== it.seen }
        order.forEach { it.seen = it.layout.value }
        clamp(order[index])
        if (changed) speed = max(TextRevealSpec.MIN_SPEED_DP_PER_SECOND * density, remaining(order, index) / TextRevealSpec.TARGET_SECONDS)

        index = advance(order, index, speed * dt)
        val end = atEnd(order, index)
        for ((i, piece) in order.withIndex()) {
            val mask = when {
                i < index || end -> Mask.Whole
                i > index -> Mask.None
                else -> Mask.Line(line, x)
            }
            if (piece.mask != mask) piece.mask = mask
        }

        val caretPiece = order[index]
        val bottom = caretPiece.top + caretPiece.layout.value!!.getLineBottom(line) + bottomPadding
        // While words come the row only grows: room it has stays, so nothing under it moves back.
        val shown = height.takeIf { !it.isNaN() } ?: first.toFloat()
        val target = if (end && !streaming) natural.toFloat() else min(maxOf(bottom, shown, heightTo.takeIf { !it.isNaN() } ?: 0f), natural.toFloat())
        val resting = animateHeight(frame, target)
        if (end && !streaming && resting) return finish(frame)
        return end && resting
    }

    /** Lays the row out at [target] and eases its height on screen there; true once it rests. */
    private fun animateHeight(frame: Long, target: Float): Boolean {
        val current = height.takeIf { !it.isNaN() } ?: (if (first >= 0) first else natural).toFloat()
        if (target != heightTo) {
            heightFrom = current
            heightTo = target
            heightStart = frame
            val before = if (laid >= 0) laid else current.roundToInt()
            val next = target.roundToInt()
            laid = next
            if (next != before) host?.grew(key, next - before)
        }
        val t = ((frame - heightStart) / 1e6f / TextRevealSpec.HEIGHT_MILLIS).coerceIn(0f, 1f)
        height = if (t >= 1f) heightTo else lerp(heightFrom, heightTo, TextRevealSpec.easing.transform(t))
        host?.lag(key, laid - height)
        return t >= 1f
    }

    private fun finish(frame: Long): Boolean {
        pieces.forEach { if (it.mask != Mask.Whole) it.mask = Mask.Whole }
        if (!animateHeight(frame, natural.toFloat())) return false
        // The row composes without the reveal in this same frame, at its whole height.
        done = true
        return true
    }

    private fun clamp(piece: Piece) {
        if (line >= piece.lines) {
            line = piece.lines - 1
            x = piece.width(line)
        }
        x = x.coerceIn(0f, piece.width(line))
    }

    private fun remaining(order: List<Piece>, index: Int): Float {
        var total = 0f
        for (i in index until order.size) {
            val piece = order[i]
            val from = if (i == index) line else 0
            for (l in from until piece.lines) total += piece.width(l) - if (i == index && l == line) x else 0f
        }
        return total
    }

    /** Moves the caret [distance] pixels along the lines; returns the caret's text. */
    private fun advance(order: List<Piece>, start: Int, distance: Float): Int {
        var index = start
        var left = distance
        while (left > 0f) {
            val piece = order[index]
            val room = piece.width(line) - x
            if (room > left) {
                x += left
                break
            }
            left -= room.coerceAtLeast(0f)
            x = piece.width(line)
            when {
                line + 1 < piece.lines -> { line++; x = 0f }
                index + 1 < order.size -> { index++; line = 0; x = 0f }
                else -> break
            }
        }
        caret = order[index]
        return index
    }

    private fun atEnd(order: List<Piece>, index: Int): Boolean {
        if (index < order.lastIndex) return false
        val piece = order[index]
        return line >= piece.lines - 1 && x >= piece.width(line) - 0.001f
    }
}

/**
 * The reveal for a row whose words are [streaming] now, or null for one
 * that never streamed while composed, and when animations are off. A row
 * met mid-answer ([fresh] false: the block began a while ago, or the row
 * scrolled back into view) shows what is there and reveals only what comes.
 */
@Composable
fun rememberTextReveal(key: Any, streaming: Boolean, fresh: () -> Boolean): TextReveal? {
    val reduceMotion = com.slopus.happy.ui.components.rememberReduceMotion()
    val density = LocalDensity.current
    val host = LocalRevealHost.current
    val reveal = remember(key) {
        if (!streaming || reduceMotion) null
        else TextReveal(density.density, startAtEnd = !fresh(), with(density) { MessageSpec.agentMarginVertical.toPx() }, key, host)
    } ?: return null
    val live = rememberUpdatedState(streaming)
    LaunchedEffect(reveal) { reveal.run(live) }
    // A row scrolled away mid-ease leaves the list where it is.
    DisposableEffect(reveal) { onDispose { reveal.host?.lag(reveal.key, 0f) } }
    return reveal.takeIf { !it.done }
}

/** The row's height follows the caret's line while [reveal] runs; put it on the row's outermost box. */
fun Modifier.revealHeight(reveal: TextReveal?): Modifier = if (reveal == null) this else this
    .layout { measurable, constraints ->
        val placeable = measurable.measure(constraints)
        reveal.natural = placeable.height
        if (reveal.first < 0) reveal.first = placeable.height
        val height = reveal.laid.let { if (it < 0) reveal.first else it }.coerceIn(0, placeable.height)
        layout(placeable.width, height) { placeable.place(0, 0) }
    }
    .clipToBounds()
    .onPlaced { reveal.root = it }

/**
 * This text's part of the row's reveal ([LocalTextReveal]). The text is
 * recorded in a layer of its own, only when it changes; the mask is drawn
 * over that layer in another, so a frame of the caret records a rect, a clip
 * and two layer references, and the list and the text are left as they are.
 * [layout] is the text's latest layout.
 */
@Composable
fun Modifier.revealText(layout: State<TextLayoutResult?>): Modifier {
    val reveal = LocalTextReveal.current ?: return this
    val piece = remember(reveal) { reveal.Piece(layout) }
    DisposableEffect(piece) {
        reveal.register(piece)
        onDispose { reveal.unregister(piece) }
    }
    return this
        .onPlaced { piece.coordinates = it }
        .graphicsLayer()
        .drawWithContent {
            val text = piece.layout.value
            if (text == null) drawContent() else drawRevealed(piece, text) { this@drawWithContent.drawContent() }
        }
        // The text's own layer: the mask above draws it by reference.
        .graphicsLayer()
}

/**
 * [piece]'s [text] as its mask shows it, [content] drawing the text at the
 * origin: whole, nothing, or the lines before the caret's and its own up
 * to the caret, fading out over the last [TextRevealSpec.fade].
 */
internal fun DrawScope.drawRevealed(piece: TextReveal.Piece, text: TextLayoutResult, content: DrawScope.() -> Unit) {
    val mask = piece.mask
    if (mask == TextReveal.Mask.Whole) {
        content()
        return
    }
    if (mask !is TextReveal.Mask.Line || text.lineCount == 0) return
    val line = mask.line.coerceIn(0, text.lineCount - 1)
    val top = text.getLineTop(line)
    val bottom = text.getLineBottom(line)
    if (top > 0f) clipRect(bottom = top) { content() }
    val start = piece.start(line)
    val end = piece.end(line)
    val width = end - start
    if (width <= 0f || mask.x <= 0f) return
    if (mask.x >= width) {
        clipRect(top = top, bottom = bottom) { content() }
        return
    }
    val fade = TextRevealSpec.fade.toPx()
    val from = start + lerp(-fade, width, mask.x / width)
    drawIntoCanvas { it.saveLayer(Rect(start, top, end, bottom), Paint()) }
    clipRect(start, top, end, bottom) { content() }
    drawRect(
        Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), startX = from, endX = from + fade),
        topLeft = Offset(start, top),
        size = Size(width, bottom - top),
        blendMode = BlendMode.DstIn,
    )
    drawIntoCanvas { it.restore() }
}
