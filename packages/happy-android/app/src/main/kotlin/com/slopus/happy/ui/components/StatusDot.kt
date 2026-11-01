package com.slopus.happy.ui.components

import android.provider.Settings
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * StatusDot.tsx: a [size] circle (6 by default) in [color]. Pulsing fades
 * between full and 30% opacity, 1 s each way, eased; settling back takes
 * 200 ms. The pulse keeps the screen's [ShimmerClock] and is drawn by it:
 * a frame of it draws one circle, with no animation of its own to run, no
 * state to write and nothing to compose. [onRenderThread], the pulse runs
 * there ([RenderThreadPulse]) and costs the main thread nothing a frame; it
 * then stops at once rather than settling.
 */
@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier, pulsing: Boolean = false, size: Dp = 6.dp, onRenderThread: Boolean = false) {
    if (pulsing && onRenderThread && renderThreadMotion()) {
        RenderThreadPulse(color, modifier, size)
        return
    }
    Box(modifier = modifier.size(size).then(PulseElement(rememberShimmerClock(), color, pulsing)))
}

/** The pulse's numbers: StatusDot.tsx's. */
internal object PulseSpec {
    const val HALF_MILLIS = 1000L
    const val LOW = 0.3f
    const val SETTLE_MILLIS = 200L

    /** The dot's opacity [millis] into its pulse: down to [LOW] over a second, eased, then back up as it went down. */
    fun alpha(millis: Long): Float {
        val t = millis % (2 * HALF_MILLIS)
        val way = if (t < HALF_MILLIS) t else 2 * HALF_MILLIS - t
        return 1f - (1f - LOW) * FastOutSlowInEasing.transform(way.toFloat() / HALF_MILLIS)
    }
}

private data class PulseElement(val clock: ShimmerClock, val color: Color, val pulsing: Boolean) : ModifierNodeElement<PulseNode>() {
    override fun create() = PulseNode(clock, color, pulsing)

    override fun update(node: PulseNode) {
        if (node.clock !== clock) node.leave()
        node.clock = clock
        node.color = color
        node.pulse(pulsing)
        node.invalidateDraw()
    }
}

private class PulseNode(var clock: ShimmerClock, var color: Color, private var pulsing: Boolean) : Modifier.Node(), DrawModifierNode {
    private var onClock = false
    /** The clock's time when the pulse began, or when it stopped and the dot began to settle. */
    private var since: Long? = null
    /** The opacity the dot settles back from. */
    private var from = 1f

    override fun onAttach() = pulse(pulsing, force = true)

    override fun onDetach() = leave()

    fun leave() {
        if (onClock) clock.detachPulse(this)
        onClock = false
        since = null
    }

    fun pulse(on: Boolean, force: Boolean = false) {
        if (on == pulsing && !force) return
        // Stopping: settle from wherever the pulse is.
        val settling = !on && pulsing && !force
        if (settling) from = alphaNow()
        since = if (settling) clock.millis else null
        pulsing = on
        val want = isAttached && (on || settling)
        if (want == onClock) return
        if (want) clock.attachPulse(this) else clock.detachPulse(this)
        onClock = want
    }

    private fun alphaNow(): Float {
        val now = clock.millis ?: return 1f
        val start = since ?: now.also { since = it }
        val elapsed = now - start
        if (pulsing) return PulseSpec.alpha(elapsed)
        val t = (elapsed.toFloat() / PulseSpec.SETTLE_MILLIS).coerceIn(0f, 1f)
        if (t >= 1f && onClock) {
            // Settled: off the clock until it pulses again.
            clock.detachPulse(this)
            onClock = false
        }
        return from + (1f - from) * FastOutSlowInEasing.transform(t)
    }

    override fun ContentDrawScope.draw() {
        drawCircle(color, alpha = alphaNow())
    }
}

/** Whether the person has turned animations off (Android's "Remove animations": duration scale 0). */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}
