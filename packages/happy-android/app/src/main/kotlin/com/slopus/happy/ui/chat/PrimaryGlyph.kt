package com.slopus.happy.ui.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.slopus.happy.ui.components.rememberReduceMotion

/**
 * Send turning into Stop and back (iOS `AgentInputPrimaryGlyphMotion`): the
 * glyph going away shrinks to [SCALE] and fades as the new one grows in from
 * it, over [DURATION_MS], eased in and out. Reduce Motion keeps the fade.
 */
object PrimaryGlyphMotion {
    const val DURATION_MS = 200
    const val SCALE = 0.5f
    const val TAG = "composer.primaryGlyph"
}

/** [glyph] drawn for [key], morphing as [PrimaryGlyphMotion] says whenever [key] changes. */
@Composable
fun <K> PrimaryGlyph(key: K, modifier: Modifier = Modifier, glyph: @Composable (K) -> Unit) {
    val still = rememberReduceMotion()
    AnimatedContent(
        targetState = key,
        modifier = modifier.testTag(PrimaryGlyphMotion.TAG),
        contentAlignment = Alignment.Center,
        transitionSpec = {
            val time = tween<Float>(PrimaryGlyphMotion.DURATION_MS, easing = EaseInOut)
            val scale = if (still) 1f else PrimaryGlyphMotion.SCALE
            (fadeIn(time) + scaleIn(time, scale)) togetherWith (fadeOut(time) + scaleOut(time, scale))
        },
        label = "primaryGlyph",
    ) { shown ->
        Box(contentAlignment = Alignment.Center) { glyph(shown) }
    }
}
