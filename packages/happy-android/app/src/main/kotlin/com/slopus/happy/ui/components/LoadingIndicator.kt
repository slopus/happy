package com.slopus.happy.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.Crossfade
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay

object LoadingIndicatorTags {
    const val INDICATOR = "loadingIndicator"
}

/**
 * Something is being read: the platform's indeterminate spinner (Material
 * 3's, its own 40 size, in the secondary text colour), centred in the
 * space given. It shows only once the wait outlasts [DELAY_MS], fading in
 * over [FADE_MS], so a quick read shows nothing at all. With animations
 * off it appears at once, after the same delay.
 */
@Composable
fun LoadingIndicator(modifier: Modifier = Modifier) {
    val instant = rememberReduceMotion()
    val alpha = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        delay(LoadingIndicatorSpec.DELAY_MS)
        if (instant) alpha.snapTo(1f) else alpha.animateTo(1f, tween(LoadingIndicatorSpec.FADE_MS))
    }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            color = HappyTheme.colors.textSecondary,
            modifier = Modifier.graphicsLayer { this.alpha = alpha.value }.testTag(LoadingIndicatorTags.INDICATOR),
        )
    }
}

object LoadingIndicatorSpec {
    const val DELAY_MS = 400L
    const val FADE_MS = 250
    const val CROSSFADE_MS = 250
}

/**
 * [LoadingIndicator] while [loading], [content] once not, crossfading so
 * the spinner fades out as what was read fades in.
 */
@Composable
fun LoadingCrossfade(loading: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Crossfade(loading, modifier, label = "loading") { shown ->
        if (shown) LoadingIndicator() else content()
    }
}

/**
 * [content] for [state], fading from one to the next when [key] changes (a
 * loader into what was read, one state page into another); a new [state]
 * under the same key just redraws.
 */
@Composable
fun <S> FadeContent(state: S, key: (S) -> Any?, modifier: Modifier = Modifier, content: @Composable (S) -> Unit) {
    AnimatedContent(
        targetState = state,
        modifier = modifier,
        transitionSpec = { fadeIn(tween(LoadingIndicatorSpec.CROSSFADE_MS)) togetherWith fadeOut(tween(LoadingIndicatorSpec.CROSSFADE_MS)) },
        contentKey = key,
        label = "fade",
    ) { content(it) }
}
