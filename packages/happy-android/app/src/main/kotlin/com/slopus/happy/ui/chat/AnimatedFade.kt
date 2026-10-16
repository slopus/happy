package com.slopus.happy.ui.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.clearAndSetSemantics

/** AnimatedOverlay.tsx `AnimatedFade`: 180 ms in (out-cubic), 140 ms out (in-cubic). */
object FadeSpec {
    const val IN_MS = 180
    const val OUT_MS = 140
    val inEasing = CubicBezierEasing(0.33f, 1f, 0.68f, 1f)
    val outEasing = CubicBezierEasing(0.32f, 0f, 0.67f, 0f)
}

/**
 * AnimatedOverlay.tsx `AnimatedFade`: opacity only, keeping its room so
 * nothing around it moves. Once faded out it takes no touches, which then
 * reach whatever is under it (`pointerEvents="none"`): it is placed out of
 * reach until it shows again. From the moment it starts to fade out it is
 * also out of the accessibility tree, so TalkBack can't land on a row
 * nobody can see (RN leaves an opacity-0 view readable; that isn't kept).
 */
@Composable
fun AnimatedFade(visible: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val alpha = remember { Animatable(if (visible) 1f else 0f) }
    LaunchedEffect(visible) {
        alpha.animateTo(
            if (visible) 1f else 0f,
            if (visible) tween(FadeSpec.IN_MS, easing = FadeSpec.inEasing) else tween(FadeSpec.OUT_MS, easing = FadeSpec.outEasing),
        )
    }
    Box(
        modifier
            .layout { measurable, constraints ->
                val placeable = measurable.measure(constraints)
                layout(placeable.width, placeable.height) {
                    // Far off screen, hit testing never finds it; it still takes its room here.
                    if (alpha.value > 0f || visible) placeable.place(0, 0) else placeable.place(OUT_OF_REACH, 0)
                }
            }
            .graphicsLayer { this.alpha = alpha.value }
            .then(if (visible) Modifier else Modifier.clearAndSetSemantics {}),
    ) {
        content()
    }
}

private const val OUT_OF_REACH = -100_000
