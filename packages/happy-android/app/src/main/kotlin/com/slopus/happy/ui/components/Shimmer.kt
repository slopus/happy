package com.slopus.happy.ui.components

import androidx.compose.animation.core.withInfiniteAnimationFrameMillis
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.onVisibilityChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.delay
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlin.coroutines.coroutineContext

/**
 * Desktop's ShimmerText (`ShimmerText.tsx`, `styles/shimmer-text.css`): one
 * sweep takes 1.6 s, linear, with no rest between sweeps. The ramp is three
 * times the text's width with the band in its middle fifth, so the band's
 * centre travels from half a width before the text to half a width past it
 * and is clear of the text at both ends of the loop.
 */
object ShimmerSpec {
    const val DURATION_MILLIS = 1600

    /** `sheen`'s pale band: the ink mixed 15% into the ground behind it. */
    const val SHEEN_INK = 0.15f

    /** `lift`'s resting letters: the ink mixed 38% into the ground. */
    const val REST_INK = 0.38f

    /** From the band's centre to where it has faded back into the letters, in text widths (40% to 50% of 3). */
    const val BAND_HALF_WIDTH = 0.3f

    /**
     * The band for `sheen`, the default: the letters keep [ink], their own
     * colour, and a band of nearly the page wipes through them. Pass it as
     * `highlightColor` with [ink] as `baseColor`.
     */
    fun sheen(ink: Color, ground: Color): Color = lerp(ground, ink, SHEEN_INK)

    /**
     * The resting letters for `lift`: dimmed toward [ground], with a band of
     * the full [ink] passing through. For text whose dimness is itself the
     * message that something isn't finished (Submit while it sends).
     */
    fun rest(ink: Color, ground: Color): Color = lerp(ground, ink, REST_INK)

    /** Where the band's centre is at [phase] (0 to 1 across one sweep), in text widths from its start. */
    fun bandCenter(phase: Float): Float = -0.5f + 2f * phase

    /**
     * The least time between two steps of a sweep or a pulse: 60 a second,
     * every other frame at 120 Hz. A step then moves the band's centre a
     * 48th of the text's width, under a band six tenths of it wide that
     * fades from its centre to nothing: it reads as the same glide.
     */
    const val TICK_MILLIS = 16L

    /** How much earlier than [TICK_MILLIS] the clock asks for its next frame, so it lands on the vsync and not one after. */
    const val TICK_SLACK_MILLIS = 5L
}

/**
 * The one clock every shimmer and pulsing [StatusDot] on screen keeps, so
 * they all move together and a screen of working rows costs one frame loop,
 * not one per row. It runs only while something that is shown moves on it
 * ([attach], [StatusDot]'s pulse), on the composition's frame clock (so it stops with the app in
 * the background), and stretches with the system's animator duration scale;
 * at scale 0 it doesn't run.
 *
 * A tick writes no snapshot state: it sets [phase] and [millis] and asks each
 * attached node to draw again ([DrawModifierNode.invalidateDraw]), so a frame
 * of the sweep is those nodes' draws and nothing else, no snapshot to apply
 * and no reader to look up. It ticks at most every [ShimmerSpec.TICK_MILLIS]:
 * on a 120 Hz screen every other vsync, where a band moving 1/96 of its sweep
 * a step reads the same as one moving 1/192, and half the frames go undrawn.
 */
@Stable
class ShimmerClock {
    /** What each tick draws again: the sweeping and pulsing nodes shown. */
    private val targets = LinkedHashSet<DrawModifierNode>()
    private var attached by mutableIntStateOf(0)
    private var pulses by mutableIntStateOf(0)

    /** Shimmers currently sweeping on this clock. */
    val sweeping: Int get() = attached

    /** Where every sweep is, 0 to 1 across one; it holds still while nothing sweeps. Read in draw. */
    var phase: Float = 0f
        private set

    /** The frame time of the last tick, scaled by the duration scale; null while the clock isn't running. */
    var millis: Long? = null
        private set

    /**
     * A shimmer shown sweeping, counted from composition (a removed node can
     * stay attached a frame or more, so its node doesn't count itself).
     */
    fun attach() {
        attached++
    }

    fun detach() {
        attached--
    }

    /** [node] is drawn again on every tick while it is attached. */
    internal fun draws(node: DrawModifierNode) {
        targets.add(node)
    }

    internal fun undraws(node: DrawModifierNode) {
        targets.remove(node)
    }

    /** A pulse ([StatusDot]) runs on this clock, drawn by its node; it isn't counted in [sweeping]. */
    internal fun attachPulse(node: DrawModifierNode) {
        if (targets.add(node)) pulses++
    }

    internal fun detachPulse(node: DrawModifierNode) {
        if (targets.remove(node)) pulses--
    }

    /** Runs the clock for as long as the calling coroutine lives. */
    suspend fun run() {
        val scale = coroutineContext[MotionDurationScale]
        snapshotFlow { if (attached > 0 || pulses > 0) scale?.scaleFactor ?: 1f else 0f }
            .distinctUntilChanged()
            .collectLatest { factor ->
                if (factor <= 0f) {
                    millis = null
                    return@collectLatest
                }
                val period = ShimmerSpec.DURATION_MILLIS * factor.toDouble()
                while (true) {
                    withInfiniteAnimationFrameMillis { now ->
                        phase = (now / period % 1.0).toFloat()
                        millis = (now / factor).toLong()
                        targets.forEach { it.invalidateDraw() }
                    }
                    // The next vsync at least this long after this one.
                    delay(ShimmerSpec.TICK_MILLIS - ShimmerSpec.TICK_SLACK_MILLIS)
                }
            }
    }
}

/** The clock shimmers under this point keep; null where nothing provides one, and then each keeps its own. */
val LocalShimmerClock = staticCompositionLocalOf<ShimmerClock?> { null }

/** Provides one running [ShimmerClock] to [content], unless one is provided already. */
@Composable
fun ProvideShimmerClock(content: @Composable () -> Unit) {
    if (LocalShimmerClock.current != null) {
        content()
        return
    }
    val clock = rememberRunningShimmerClock()
    CompositionLocalProvider(LocalShimmerClock provides clock, content = content)
}

/** The provided clock, or one of the caller's own, running while it is composed. */
@Composable
internal fun rememberShimmerClock(): ShimmerClock = LocalShimmerClock.current ?: rememberRunningShimmerClock()

@Composable
private fun rememberRunningShimmerClock(): ShimmerClock {
    val clock = remember { ShimmerClock() }
    LaunchedEffect(clock) { clock.run() }
    return clock
}

/**
 * Sweeps a band of [highlight] through whatever this draws, clipped to what
 * it paints: the band is mixed over the drawn pixels only (SrcAtop on an
 * offscreen layer), so glyph edges stay exact and the background stays
 * clear. Only the paint moves, nothing reflows or recomposes: the clock
 * draws the band's node again on each tick, over the content's own layer,
 * so a frame of the sweep draws a gradient and nothing else. While the node
 * is off screen it lets the clock stop. [phase] freezes the sweep at one
 * point of the loop, for tests and screenshots. With animations off, put no
 * shimmer on at all ([ShimmerText] does this).
 */
@Composable
fun Modifier.shimmer(highlight: Color, phase: Float? = null): Modifier {
    val clock = rememberShimmerClock()
    var visible by remember { mutableStateOf(true) }
    if (phase == null && visible) {
        DisposableEffect(clock) {
            clock.attach()
            onDispose { clock.detach() }
        }
    }
    return this
        .onVisibilityChanged { visible = it }
        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .then(ShimmerElement(clock, highlight, phase, sweeping = phase == null && visible))
        // What shimmers, in a layer of its own: a frame of the sweep records the band and a reference to it, never the text again.
        .graphicsLayer()
}

private data class ShimmerElement(val clock: ShimmerClock, val highlight: Color, val phase: Float?, val sweeping: Boolean) : ModifierNodeElement<ShimmerNode>() {
    override fun create() = ShimmerNode(clock, highlight, phase, sweeping)

    override fun update(node: ShimmerNode) {
        if (node.clock !== clock) node.sweep(false)
        node.clock = clock
        node.highlight = highlight
        node.phase = phase
        node.sweep(sweeping)
        node.invalidateDraw()
    }
}

private class ShimmerNode(var clock: ShimmerClock, var highlight: Color, var phase: Float?, private var sweeping: Boolean) : Modifier.Node(), DrawModifierNode {
    private var onClock = false

    override fun onAttach() = sweep(sweeping)

    override fun onDetach() {
        sweep(false)
        sweeping = false
    }

    fun sweep(on: Boolean) {
        sweeping = on
        val want = on && isAttached
        if (want == onClock) return
        onClock = want
        if (want) clock.draws(this) else clock.undraws(this)
    }

    override fun ContentDrawScope.draw() {
        drawContent()
        val at = phase ?: if (sweeping) clock.phase else 0f
        val width = size.width
        if (width <= 0f) return
        val center = ShimmerSpec.bandCenter(at) * width
        val half = ShimmerSpec.BAND_HALF_WIDTH * width
        if (center + half <= 0f || center - half >= width) return
        drawRect(
            brush = Brush.horizontalGradient(
                0f to highlight.copy(alpha = 0f),
                0.5f to highlight,
                1f to highlight.copy(alpha = 0f),
                startX = center - half,
                endX = center + half,
            ),
            blendMode = BlendMode.SrcAtop,
        )
    }
}

/**
 * ShimmerText.tsx: one line of text in [baseColor] with a band of
 * [highlightColor] sweeping through it, clipped to the glyphs (desktop's
 * look and timing, [ShimmerSpec]). For desktop's `sheen`, what every busy
 * title uses, pass the title's own colour as [baseColor] and
 * `ShimmerSpec.sheen(ink, ground)` as [highlightColor]: the letters stay
 * exactly as legible as their neighbours and a pale band wipes through.
 *
 * [shimmering] turns the sweep on and off on the same Text, so a row's size
 * never changes with it. Without the sweep (not [shimmering], or animations
 * off) the text is plain [stillColor], [baseColor] unless given. Every
 * shimmer keeps [LocalShimmerClock], and stops while scrolled away.
 */
@Composable
fun ShimmerText(
    text: String,
    style: TextStyle,
    baseColor: Color,
    highlightColor: Color,
    modifier: Modifier = Modifier,
    shimmering: Boolean = true,
    stillColor: Color = baseColor,
    phase: Float? = null,
) {
    val sweeps = shimmering && (phase != null || !rememberReduceMotion())
    Text(
        text = text,
        style = style,
        color = if (sweeps) baseColor else stillColor,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier.then(if (sweeps) Modifier.shimmer(highlightColor, phase) else Modifier),
    )
}
