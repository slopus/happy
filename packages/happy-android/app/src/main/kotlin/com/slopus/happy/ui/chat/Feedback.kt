package com.slopus.happy.ui.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType

/** haptics.ts `hapticsLight`: a light tick. */
fun HapticFeedback.light() = performHapticFeedback(HapticFeedbackType.ContextClick)

/** haptics.ts `hapticsError`. */
fun HapticFeedback.error() = performHapticFeedback(HapticFeedbackType.Reject)

/** Shaker.tsx's keyframes: 0, then ±3 four times, then 0, over 300 ms. */
object ShakeSpec {
    const val AMPLITUDE = 3f
    const val COUNT = 4
    const val DURATION_MS = 300
    val keyframes: List<Float> = buildList {
        add(0f)
        repeat(COUNT) { add(if (it % 2 == 0) AMPLITUDE else -AMPLITUDE) }
        add(0f)
    }
}

/** Shaker.tsx's handle: [shake] runs the keyframes on whatever wears [Modifier.shake]. */
@Stable
class ShakeState {
    internal val offset = Animatable(0f)

    suspend fun shake() {
        val step = ShakeSpec.DURATION_MS / ShakeSpec.keyframes.size
        // Animated.timing's default easing is easeInOut.
        for (frame in ShakeSpec.keyframes) offset.animateTo(frame, tween(step, easing = EaseInOut))
    }
}

@Composable
fun rememberShake(): ShakeState = remember { ShakeState() }

/** Shaker.tsx: a horizontal shake that moves the drawing, not the layout. */
fun Modifier.shake(state: ShakeState?): Modifier =
    if (state == null) this else graphicsLayer { translationX = state.offset.value * density }
