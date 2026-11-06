package com.slopus.happy.ui.call

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.draw.drawWithContent
import com.slopus.happy.call.CallControl
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * What the call does on screen, shown as the person's own tap would be (iOS's `VoiceTouch`): the control it
 * stands for lights in the call bar's colours, one band of them sweeping over it as a working row's title
 * shimmers ([ShimmerSpec]'s band), then it presses with the platform's ripple, and only then does the caller
 * act. The control itself is never clicked. With animations off (the animator duration scale at 0) the light
 * only shows and the ripple is the press.
 *
 *     (a row off screen scrolls to the middle first)
 *     0      ramp in (150 ms), the band starting across
 *     550    the band has crossed
 *     600    pressed
 *     750    the action is due: [play] returns
 *     750+   the light fades out (250 ms), the press lets go at 900
 *
 * Controls take part with [voiceTouch]; home's list brings its rows on screen through [rows]. Main thread.
 */
@Stable
object VoiceTouch {
    const val RAMP_IN_MS = 150
    const val SWEEP_MS = 550
    const val PRESS_AT_MS = 600L
    const val ACT_AT_MS = 750L
    const val FADE_OUT_MS = 250
    const val RELEASE_AT_MS = 900L

    enum class Phase { Lit, Pressed, Ending }

    /** The control lit now, how far it has got, and whether its band sweeps. */
    class Lit(val control: CallControl, val sweeps: Boolean) {
        var phase by mutableStateOf(Phase.Lit)
    }

    var lit: Lit? by mutableStateOf(null)
        private set

    private class Shown(val coordinates: () -> LayoutCoordinates?, val source: MutableInteractionSource)

    /** Each control on screen, the latest placed last. */
    private val shown = HashMap<CallControl, MutableList<Shown>>()

    /** Home's list while it shows: scrolls [agentId]'s row wholly on screen, to the middle, and returns once it stands still. */
    var rows: (suspend (agentId: String, glides: Boolean) -> Unit)? = null

    /** Lets go of the press and the light after [play] returned, whatever the call does next. */
    private val after = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /**
     * Lights [control], presses it, and returns when the action is due; false at once where the person can't
     * see it. [still]: animations are off.
     */
    suspend fun play(control: CallControl, still: Boolean): Boolean = withContext(Dispatchers.Main.immediate) {
        if (control is CallControl.Row) rows?.invoke(control.agentId, !still) ?: return@withContext false
        // A row scrolled on comes within a frame or two.
        val target = withTimeoutOrNull(300) {
            var found = find(control)
            while (found == null) { delay(16); found = find(control) }
            found
        } ?: return@withContext false
        val light = Lit(control, sweeps = !still)
        lit = light
        var press: PressInteraction.Press? = null
        try {
            delay(PRESS_AT_MS)
            val box = target.coordinates()?.takeIf { it.isAttached }?.size?.toSize()
            press = PressInteraction.Press(box?.let { Offset(it.width / 2, it.height / 2) } ?: Offset.Zero)
            target.source.emit(press)
            light.phase = Phase.Pressed
            delay(ACT_AT_MS - PRESS_AT_MS)
        } finally {
            light.phase = Phase.Ending
            val pressed = press
            after.launch {
                withContext(NonCancellable) {
                    delay(RELEASE_AT_MS - ACT_AT_MS)
                    pressed?.let { target.source.emit(PressInteraction.Release(it)) }
                    delay(FADE_OUT_MS.toLong())
                    if (lit === light) lit = null
                }
            }
        }
        true
    }

    /** The latest placed of [control]'s on screen, if any shows. */
    private fun find(control: CallControl): Shown? = shown[control]?.lastOrNull { entry ->
        val at = entry.coordinates()?.takeIf { it.isAttached } ?: return@lastOrNull false
        val seen = at.boundsInWindow()
        seen.width > 0 && seen.height > 0
    }

    internal fun register(control: CallControl, coordinates: () -> LayoutCoordinates?, source: MutableInteractionSource): () -> Unit {
        val entry = Shown(coordinates, source)
        shown.getOrPut(control) { ArrayList() }.add(entry)
        return {
            shown[control]?.let { list ->
                list.remove(entry)
                if (list.isEmpty()) shown.remove(control)
            }
        }
    }

    /** The call bar's colours while it listens ([CallBarColors]). */
    internal val colors = listOf(Color(0xFF4338CA), Color(0xFF7C3AED))
}

/**
 * [control] as the call presses it ([VoiceTouch]): its light drawn under the content, within [shape], and the
 * press made on [source], which the control's ripple shows ([androidx.compose.foundation.indication] or its
 * own `interactionSource`).
 */
fun Modifier.voiceTouch(control: CallControl, shape: Shape, source: MutableInteractionSource): Modifier = composed {
    val dark = HappyTheme.colors.dark
    val placed = remember { arrayOfNulls<LayoutCoordinates>(1) }
    DisposableEffect(control, source) {
        val unregister = VoiceTouch.register(control, { placed[0] }, source)
        onDispose(unregister)
    }
    val lit = VoiceTouch.lit?.takeIf { it.control == control }
    val wash = remember { Animatable(0f) }
    val band = remember { Animatable(0f) }
    var sweeping by remember { mutableStateOf(false) }
    val rest = if (dark) 0.22f else 0.12f
    val pressed = if (dark) 0.32f else 0.2f
    val peak = if (dark) 0.55f else 0.4f
    LaunchedEffect(lit) {
        if (lit == null) {
            sweeping = false
            wash.snapTo(0f)
            return@LaunchedEffect
        }
        if (lit.sweeps) {
            sweeping = true
            band.snapTo(0f)
            launch { band.animateTo(1f, tween(VoiceTouch.SWEEP_MS, easing = FastOutSlowInEasing)) }
        }
        wash.animateTo(rest, tween(VoiceTouch.RAMP_IN_MS, easing = LinearOutSlowInEasing))
    }
    val phase = lit?.phase
    LaunchedEffect(lit, phase) {
        when (phase) {
            VoiceTouch.Phase.Pressed -> wash.animateTo(pressed, tween(100))
            VoiceTouch.Phase.Ending -> {
                launch { wash.animateTo(0f, tween(VoiceTouch.FADE_OUT_MS)) }
                sweeping = false
            }
            else -> Unit
        }
    }
    onGloballyPositioned { placed[0] = it }
        .drawWithContent {
            val strength = wash.value
            if (strength > 0f || sweeping) {
                val outline = shape.createOutline(size, layoutDirection, this)
                val clip = Path().apply { addOutline(outline) }
                val (start, end) = VoiceTouch.colors
                clipPath(clip) {
                    if (strength > 0f) drawRect(Brush.horizontalGradient(VoiceTouch.colors), alpha = strength)
                    if (sweeping) {
                        // The band is the middle fifth of a ramp three widths wide, as a title's ([ShimmerSpec]):
                        // from just clear of the left edge to just clear of the right.
                        val half = ShimmerSpec.BAND_HALF_WIDTH * size.width
                        val center = -half + (size.width + 2 * half) * band.value
                        val color = lerp(start, end, (center / size.width).coerceIn(0f, 1f))
                        drawRect(
                            Brush.horizontalGradient(
                                0f to Color.Transparent, 0.5f to color.copy(alpha = peak), 1f to Color.Transparent,
                                startX = center - half, endX = center + half,
                            ),
                        )
                    }
                }
            }
            drawContent()
        }
}

/** [voiceTouch]'s interaction source for a control that has none of its own. */
@Composable
fun rememberVoiceTouchSource(): MutableInteractionSource = remember { MutableInteractionSource() }
