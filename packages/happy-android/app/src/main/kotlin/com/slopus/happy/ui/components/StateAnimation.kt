package com.slopus.happy.ui.components

import androidx.annotation.RawRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.rememberLottieAnimatable
import com.airbnb.lottie.compose.rememberLottieComposition
import com.slopus.happy.R
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * The state pictures Happy ships, each for exactly one meaning, as desktop's
 * LottieScene vocabulary has them (happy-desktop
 * `packages/happy-desktop-ui/src/LottieScene.tsx` and
 * `assets/animations/PROVENANCE.md`, at 8b133d98e). The files in `res/raw`
 * are desktop's, compacted back to the exact bytes its PROVENANCE records
 * (SHA-256 below): MIT, Happy Coder Contributors, this repository's own
 * happy-app animations. Errors, offline, a search that found nothing and
 * small inline tiles get no picture, as on desktop: a glyph at most.
 */
enum class StateArt(@RawRes val raw: Int) {
    /** Something is being read and it takes a moment (snail, `6a9c7b64…`). */
    Waiting(R.raw.state_snail),

    /** What is missing can be made right here, beside the button that makes it (wand, `8de70508…`). */
    Make(R.raw.state_wand),

    /** An agent is ready and waiting to be told what to do: an empty conversation (robot, `eeabc392…`). */
    Ready(R.raw.state_robot),

    /** The absence is the good outcome; nothing left to do (sparkles, `b14e504c…`). */
    Done(R.raw.state_sparkles),
}

object StateAnimationTags {
    const val ANIMATION = "stateAnimation"
    const val PAGE = "statePage"
}

/**
 * One state picture in a fixed [size] box (desktop's empty states use 128
 * and 96), drawn whether or not the animation has loaded, so nothing around
 * it moves. As desktop's LottieScene: it plays once when it appears and
 * holds its last frame, the pose it was drawn to return to; a tap plays it
 * again. It runs only while the screen is resumed, so it waits through the
 * background and goes on where it stopped. With animations removed it shows
 * the last frame and never moves.
 */
@Composable
fun StateAnimation(art: StateArt, modifier: Modifier = Modifier, size: Dp = 128.dp) {
    val reduceMotion = rememberReduceMotion()
    val composition by rememberLottieComposition(LottieCompositionSpec.RawRes(art.raw))
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    val animatable = rememberLottieAnimatable()
    // Plays asked for and plays finished; kept through recreation, so a rotation doesn't replay it.
    var requested by rememberSaveable(art) { mutableIntStateOf(1) }
    var played by rememberSaveable(art) { mutableIntStateOf(0) }
    LaunchedEffect(composition, reduceMotion, active, requested) {
        val loaded = composition ?: return@LaunchedEffect
        if (reduceMotion || played >= requested) {
            animatable.snapTo(loaded, progress = 1f)
            return@LaunchedEffect
        }
        if (!active) return@LaunchedEffect
        // Stopped by the background, it goes on from where it was; a replay starts over.
        val from = animatable.progress.takeIf { animatable.composition == loaded && it < 1f } ?: 0f
        animatable.animate(loaded, iterations = 1, initialProgress = from)
        played = requested
    }
    val label = stringResource(R.string.state_animation_replay)
    Box(
        modifier = modifier
            .size(size)
            .testTag(StateAnimationTags.ANIMATION)
            .then(
                if (reduceMotion) Modifier else Modifier.clickable(
                    interactionSource = null,
                    indication = null,
                    role = Role.Button,
                    onClickLabel = label,
                ) { if (played >= requested) requested = played + 1 }.semantics { contentDescription = label },
            ),
    ) {
        if (composition != null) LottieAnimation(composition, { animatable.progress }, Modifier.fillMaxSize())
    }
}

/**
 * A screen-filling state: [art] (or, for errors and offline, a plain
 * [icon]), a title, a line under it and an optional button, centred in the
 * content width and fixed in place.
 */
@Composable
fun StatePage(
    title: String?,
    body: String?,
    modifier: Modifier = Modifier,
    art: StateArt? = null,
    icon: Ionicon? = null,
    action: Pair<String, () -> Unit>? = null,
    tag: String = StateAnimationTags.PAGE,
) {
    val colors = HappyTheme.colors
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier
                .contentMaxWidth(LocalWindowLayout.current)
                .fillMaxWidth()
                .padding(horizontal = 32.dp, vertical = 56.dp)
                .testTag(tag),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            when {
                art != null -> StateAnimation(art)
                icon != null -> Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) { Icon(icon, 48.dp, colors.textSecondary) }
            }
            if (art != null || icon != null) Spacer(Modifier.size(8.dp))
            if (title != null) {
                Text(title, style = happyTextStyle(fontSize = 20, lineHeight = 26, weight = FontWeight.SemiBold), color = colors.text, textAlign = TextAlign.Center)
            }
            if (body != null) {
                Text(body, style = happyTextStyle(fontSize = 15, lineHeight = 21), color = colors.textSecondary, textAlign = TextAlign.Center)
            }
            if (action != null) {
                Spacer(Modifier.size(16.dp))
                RoundButton(title = action.first, onClick = action.second)
            }
        }
    }
}
