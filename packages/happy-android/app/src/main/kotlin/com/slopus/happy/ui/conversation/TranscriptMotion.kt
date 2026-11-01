package com.slopus.happy.ui.conversation

import android.graphics.Picture
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.drawText
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.util.lerp
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.MessageSpec
import com.slopus.happy.ui.chat.TextRevealSpec
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The transcript's motion, Telegram's (`ChatListItemAnimator`): one
 * duration, [MILLIS], on one curve, [easing].
 */
object TranscriptMotionSpec {
    const val MILLIS = 250

    /** `ChatListItemAnimator.DEFAULT_INTERPOLATOR`, cubic-bezier(0.199, 0.011, 0.279, 0.910). */
    val easing = TextRevealSpec.easing

    /** A row's start waits up to this, the lowest first: `(1 − bottom / listHeight) × 100` (`:1421`). */
    const val STAGGER_MILLIS = 100
    const val ENTER_SCALE = 0.9f

    /** More rows than this arriving at once (a sync catching up) just appear. */
    const val MAX_ROWS = 8

    /** A sent message's bubble is opaque this far into its flight (TextMessageEnterTransition, `:472`). */
    const val FLIGHT_OPAQUE = 0.4f

    /** A sent message flies only if it is this many lines or fewer (`:129`). */
    const val FLIGHT_LINES = 10

    /** How long a sent message waits for its row before it gives up flying. */
    const val FLIGHT_WAIT_MILLIS = 600L
}

/**
 * Rows arriving at the newest end while the reader is there, as Telegram's
 * item animator adds them:
 *
 * - The rows already shown move up to make room: the list's own layer is
 *   drawn [lift] lower, by the new rows' height, easing to 0. No row is
 *   laid out or placed again for it.
 * - Each new row fades in from 0.9 of its size ([enter]), the lowest first,
 *   the rest up to 100 ms after.
 *
 * A streaming answer or thought comes in through its reveal instead, which
 * grows it from nothing. Reading older history, nothing moves. With Reduce
 * Motion nothing animates.
 * A sent message on its way ([SendFlight]) doesn't fade in; it flies.
 */
@Stable
internal class TranscriptMotion(private val list: LazyListState) {
    private var rows: List<ConversationRow>? = null
    private var known: HashSet<String>? = null
    private val entering = HashSet<String>()
    private val delays = HashMap<String, Float>()
    /** Entering rows that fly in from the composer instead of fading ([SendFlight]); they still take room. */
    private val flown = HashSet<String>()
    private var height = -1f

    /** False from an insertion until [run] has wound [clock] back: the new rows' first frame is their start. */
    private var started = false

    /** Milliseconds into the current insertion; read in layers only. */
    private val clock = Animatable(0f)

    private val generationState = androidx.compose.runtime.mutableIntStateOf(0)

    /** Bumped by each insertion that animates; the list runs [run] for it. */
    val generation: Int get() = generationState.intValue

    /** Takes [next], the rows as composed now; the ones new at the newest end enter, unless [still]. */
    fun update(next: List<ConversationRow>, still: Boolean) {
        if (next === rows) return
        val before = known
        val newest = rows?.firstOrNull()?.key
        rows = next
        known = next.mapTo(HashSet(next.size * 2)) { it.key }
        if (before == null || newest == null) return
        // Reading older history: the list keeps its place, and nothing it shows moves.
        if (list.firstVisibleItemIndex != 0 || list.firstVisibleItemScrollOffset != 0) return
        var end = -1
        for (i in 0..minOf(next.lastIndex, TranscriptMotionSpec.MAX_ROWS)) if (next[i].key == newest) { end = i; break }
        if (end == 0) return
        // At the newest end the newest row is the one shown: the list would keep the old one in place,
        // with what arrived under the dock.
        list.requestScrollToItem(0)
        if (end < 0 || still) return
        entering.clear()
        delays.clear()
        flown.clear()
        for (i in 0 until end) if (next[i].key !in before && !next[i].streams()) entering += next[i].key
        if (entering.isEmpty()) return
        height = -1f
        started = false
        generationState.intValue++
    }

    /** Whether row [key] is entering: it then wears [enter]. */
    fun entering(key: String): Boolean = key in entering && key !in flown

    /** Row [key] flies in from the composer: it doesn't fade, before or after it lands. */
    fun flies(key: String) {
        if (key in entering) flown += key
    }

    /** Row [key]'s fade and growth; its stagger is found from where it was placed. */
    fun enter(key: String): Modifier = Modifier
        .onPlaced { placed ->
            if (key !in delays) {
                val parent = placed.parentLayoutCoordinates?.size?.height ?: 0
                val bottom = placed.positionInParent().y + placed.size.height
                delays[key] = if (parent <= 0) 0f else (1f - bottom / parent).coerceIn(0f, 1f) * TranscriptMotionSpec.STAGGER_MILLIS
            }
        }
        .graphicsLayer {
            val p = progress(key)
            alpha = p
            val scale = lerp(TranscriptMotionSpec.ENTER_SCALE, 1f, p)
            scaleX = scale
            scaleY = scale
        }

    /** How far row [key] has entered, eased: 0 until its stagger has passed, 1 once settled. */
    fun progress(key: String): Float {
        // Read first, always: the row's layer is drawn again as the clock runs, and once it settles.
        val elapsed = elapsed()
        if (key !in entering) return 1f
        val delay = delays[key] ?: 0f
        return TranscriptMotionSpec.easing.transform(((elapsed - delay) / TranscriptMotionSpec.MILLIS).coerceIn(0f, 1f))
    }

    /** How much lower the list is drawn this frame: the new rows' height, easing out. Read in the list's layer. */
    fun lift(): Float {
        // Read first, always: the layer is drawn again as the clock runs.
        val t = (elapsed() / TranscriptMotionSpec.MILLIS).coerceIn(0f, 1f)
        if (entering.isEmpty()) return 0f
        if (t >= 1f) return 0f
        if (height <= 0f) {
            // The first frame they are laid out in: their height, before anything has moved.
            var sum = 0
            for (item in list.layoutInfo.visibleItemsInfo) if (item.key in entering) sum += item.size
            height = sum.toFloat()
        }
        return height * (1f - TranscriptMotionSpec.easing.transform(t))
    }

    private fun elapsed(): Float = clock.value.let { if (started) it else 0f }.also { generationState.intValue }

    /** Runs one insertion: [TranscriptMotionSpec.MILLIS] plus the longest stagger, then everything at rest. */
    suspend fun run() {
        clock.snapTo(0f)
        started = true
        val total = TranscriptMotionSpec.MILLIS + TranscriptMotionSpec.STAGGER_MILLIS
        clock.animateTo(total.toFloat(), tween(total, easing = LinearEasing))
        entering.clear()
        delays.clear()
        flown.clear()
        // Drawn once more, at rest.
        clock.snapTo(total + 1f)
    }
}

val LocalSendFlight = staticCompositionLocalOf<SendFlight?> { null }

/**
 * A sent message flying from the composer to its place, as Telegram's
 * TextMessageEnterTransition does, for a text of
 * [TranscriptMotionSpec.FLIGHT_LINES] lines or fewer with nothing attached,
 * sent at the newest end:
 *
 * - The composer gives [launch] its words as laid out, and where they were.
 * - The message's row [claim]s them as it composes and stays hidden while
 *   they fly. Its words tell the flight where they are ([place]).
 * - [SendFlightOverlay], over the screen, draws the bubble and the words
 *   moving from the field to the row over [TranscriptMotionSpec.MILLIS] on
 *   the curve, the bubble opaque by [TranscriptMotionSpec.FLIGHT_OPAQUE].
 *   Where the bubble breaks its lines differently from the field, the
 *   field's words cross-fade into the bubble's. Both are pictures drawn
 *   once, so a frame of the flight shapes no text.
 */
@Stable
class SendFlight {
    internal class Flight(val text: String, val words: Picture, val ends: IntArray, val origin: Offset) {
        var key: String? = null
        var target by mutableStateOf<Target?>(null)
        val progress = Animatable(0f)
    }

    /** A claimed row's words: where they are laid out ([coordinates]), and how ([prose]). */
    internal class Target(val coordinates: LayoutCoordinates, val prose: Prose)

    internal var flight by mutableStateOf<Flight?>(null)
        private set

    /** Whether the transcript is at its newest end, where a sent message's row shows; the transcript sets it. */
    internal var atNewest: () -> Boolean = { false }

    /** The composer sent [text], laid out in its field as [layout] at [origin] (in the root). */
    internal fun launch(text: String, layout: TextLayoutResult, origin: Offset, density: Density, color: Color) {
        if (text.isBlank() || layout.lineCount > TranscriptMotionSpec.FLIGHT_LINES || !atNewest()) return
        val size = layout.size.toSize()
        val picture = Picture()
        val canvas = picture.beginRecording(size.width.toInt().coerceAtLeast(1), size.height.toInt().coerceAtLeast(1))
        CanvasDrawScope().draw(density, layout.layoutInput.layoutDirection, Canvas(canvas), size) { drawText(layout, color) }
        picture.endRecording()
        flight = Flight(text.trim(), picture, IntArray(layout.lineCount) { layout.getLineEnd(it) }, origin)
    }

    /** Whether [row] is the sent message in flight, claiming it if it is the one just sent. */
    internal fun claim(row: ConversationRow): Boolean {
        val flight = flight ?: return false
        if (flight.key != null) return flight.key == row.key
        if (row !is ConversationRow.User || row.pictures.isNotEmpty() || row.text.trim() != flight.text) return false
        flight.key = row.key
        return true
    }

    /** Whether row [key] is hidden while its words fly; read in its layer. */
    internal fun hides(key: String): Boolean = flight?.key == key

    /** The claimed row [key]'s words are at [coordinates], laid out as [prose]. */
    internal fun place(key: String, coordinates: LayoutCoordinates, prose: Prose) {
        val flight = flight ?: return
        if (flight.key == key && flight.target == null) flight.target = Target(coordinates, prose)
    }

    internal fun done(flight: Flight) {
        if (this.flight === flight) this.flight = null
    }
}

/** Draws [flight]'s message on its way (see [SendFlight]) over this box, which fills the screen. */
@Composable
internal fun BoxScope.SendFlightOverlay(flight: SendFlight, bubble: BubblePalette, palette: ProsePalette) {
    val current = flight.flight ?: return
    val density = LocalDensity.current
    val padding = with(density) { Offset(MessageSpec.bubblePaddingHorizontal.toPx(), MessageSpec.bubblePaddingVertical.toPx()) }
    val radius = with(density) { MessageSpec.bubbleRadius.toPx() }
    LaunchedEffect(current) {
        val target = withTimeoutOrNull(TranscriptMotionSpec.FLIGHT_WAIT_MILLIS) { snapshotFlow { current.target }.first { it != null } }
        if (target != null) current.progress.animateTo(1f, tween(TranscriptMotionSpec.MILLIS, easing = TranscriptMotionSpec.easing))
        flight.done(current)
    }
    val root = remember { arrayOf<LayoutCoordinates?>(null) }
    Box(
        Modifier
            .matchParentSize()
            .onPlaced { root[0] = it }
            .drawBehind {
                val here = root[0]?.takeIf { it.isAttached }?.positionInRoot() ?: Offset.Zero
                val target = current.target?.takeIf { it.coordinates.isAttached }
                if (target == null) {
                    // Waiting for its row: the words stay where they were typed.
                    translate(current.origin.x - here.x, current.origin.y - here.y) { drawPicture(current.words, 1f) }
                    return@drawBehind
                }
                val p = current.progress.value
                // The row follows the list as it moves up for it; the flight lands on it wherever it is.
                val at = target.coordinates.positionInRoot()
                val size = target.coordinates.size.toSize()
                val segment = target.prose.segments.firstOrNull() as? DrawnSegment
                val first = segment?.parts?.firstOrNull()?.pieces?.firstOrNull()
                val line = if (segment != null && first != null) Offset(first.x.toFloat(), (segment.tops[0] + first.y).toFloat()) else Offset.Zero
                val from = current.origin - (at + line)
                val shift = Offset(lerp(from.x, 0f, p), lerp(from.y, 0f, p)) - here
                val opaque = (p / TranscriptMotionSpec.FLIGHT_OPAQUE).coerceAtMost(1f)
                val box = Size(size.width + 2 * padding.x, size.height + 2 * padding.y)
                val shape = RoundedCornerShape(radius).createOutline(box, layoutDirection, this)
                translate(at.x - padding.x + shift.x, at.y - padding.y + shift.y) {
                    drawOutline(shape, bubble.background, alpha = opaque)
                    drawOutline(shape, bubble.border, alpha = opaque, style = Stroke(1f))
                }
                // The bubble breaks the words where the field did: they just move. Otherwise one fades into the other.
                val same = segment != null && segment.parts.size == 1 && segment.parts[0].pieces.size == 1 &&
                    first!!.text.text == current.text && first.layout.lineCount == current.ends.size &&
                    current.ends.indices.all { first.layout.getLineEnd(it) == current.ends[it] }
                val recorded = segment?.recording?.value?.takeIf { it.palette == palette }
                if (same || recorded == null) {
                    translate(at.x + line.x + shift.x, at.y + line.y + shift.y) { drawPicture(current.words, 1f) }
                } else {
                    translate(at.x + line.x + shift.x, at.y + line.y + shift.y) { drawPicture(current.words, 1f - p) }
                    translate(at.x + shift.x, at.y + shift.y) { drawPicture(recorded.picture, p) }
                }
            },
    )
}

private fun DrawScope.drawPicture(picture: Picture, alpha: Float) {
    if (alpha <= 0f) return
    drawIntoCanvas { canvas ->
        val native = canvas.nativeCanvas
        if (alpha >= 1f) {
            native.drawPicture(picture)
        } else {
            val saved = native.saveLayerAlpha(0f, 0f, picture.width.toFloat(), picture.height.toFloat(), (alpha * 255).toInt())
            native.drawPicture(picture)
            native.restoreToCount(saved)
        }
    }
}

/** Whether this row's words stream in ([com.slopus.happy.ui.chat.TextReveal]), growing it from nothing as they come. */
private fun ConversationRow.streams(): Boolean = when (this) {
    is ConversationRow.Text -> live != null
    is ConversationRow.Reasoning -> live != null
    else -> false
}
