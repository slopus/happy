package com.slopus.happy.ui.components

import androidx.compose.animation.core.withInfiniteAnimationFrameMillis
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.onVisibilityChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
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
}

/**
 * The one clock every shimmer on screen keeps, so they all sweep together
 * and a list of working rows costs one frame loop, not one per row. It runs
 * only while something that is shown shimmers ([attach]), on the
 * composition's frame clock (so it stops with the app in the background),
 * and stretches with the system's animator duration scale; at scale 0 it
 * doesn't run.
 */
@Stable
class ShimmerClock {
    private var attached by mutableIntStateOf(0)

    /** Shimmers currently sweeping on this clock. */
    val sweeping: Int get() = attached

    /** Where every sweep is, 0 to 1 across one; it holds still while nothing sweeps. */
    var phase by mutableFloatStateOf(0f)
        private set

    fun attach() {
        attached++
    }

    fun detach() {
        attached--
    }

    /** Runs the clock for as long as the calling coroutine lives. */
    suspend fun run() {
        val scale = coroutineContext[MotionDurationScale]
        snapshotFlow { if (attached > 0) scale?.scaleFactor ?: 1f else 0f }
            .distinctUntilChanged()
            .collectLatest { factor ->
                if (factor <= 0f) return@collectLatest
                val period = ShimmerSpec.DURATION_MILLIS * factor.toDouble()
                while (true) {
                    withInfiniteAnimationFrameMillis { millis -> phase = (millis / period % 1.0).toFloat() }
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
 * clear. Only the paint moves, nothing reflows or recomposes: the phase is
 * read in the band's draw alone, over the content's own layer, so a frame
 * of the sweep draws a gradient and nothing else. While the node is off
 * screen it lets the clock stop. [phase] freezes the sweep at one point of
 * the loop, for tests and screenshots. With animations off, put no
 * shimmer on at all ([ShimmerText] does this).
 */
@Composable
fun Modifier.shimmer(highlight: Color, phase: Float? = null): Modifier {
    val clock = LocalShimmerClock.current ?: rememberRunningShimmerClock()
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
        .drawWithContent {
            drawContent()
            val at = phase ?: if (visible) clock.phase else 0f
            val width = size.width
            if (width <= 0f) return@drawWithContent
            val center = ShimmerSpec.bandCenter(at) * width
            val half = ShimmerSpec.BAND_HALF_WIDTH * width
            if (center + half <= 0f || center - half >= width) return@drawWithContent
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
        // What shimmers, in a layer of its own: a frame of the sweep records the band and a reference to it, never the text again.
        .graphicsLayer()
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
