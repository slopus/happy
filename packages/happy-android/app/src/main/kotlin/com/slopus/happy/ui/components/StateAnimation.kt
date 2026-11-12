package com.slopus.happy.ui.components

import android.content.Context
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
import com.airbnb.lottie.LottieComposition
import com.airbnb.lottie.LottieCompositionFactory
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.rememberLottieAnimatable
import com.airbnb.lottie.compose.rememberLottieComposition
import com.slopus.happy.R
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.util.concurrent.ConcurrentHashMap

/**
 * The state pictures Happy ships, each for exactly one meaning, as desktop's
 * LottieScene vocabulary has them (happy-desktop
 * `packages/happy-desktop-ui/src/LottieScene.tsx` and
 * `assets/animations/PROVENANCE.md`, at 8b133d98e). The files in `res/raw`
 * are desktop's, compacted back to the exact bytes its PROVENANCE records
 * (SHA-256 below): MIT, Happy Coder Contributors, this repository's own
 * happy-app animations. [Tickets] is not desktop's: a Telegram sticker
 * (`"tgs": 1`, in-point 60) Steve chose for the Artifacts list, kept as
 * given; Lottie's progress runs from its in-point, so it starts at frame
 * 60. [Action] is not desktop's either: the 🪄 Telegram sticker Kirill chose
 * for new work's Task, gunzipped and kept as given (happy-ios
 * `Resources/Animations/PROVENANCE.md`). Errors, offline, a search that found nothing and
 * small inline tiles get no picture, as on desktop: a glyph at most.
 * Waiting has none either (desktop's snail): a read shows the platform's
 * spinner ([LoadingIndicator]).
 */
enum class StateArt(@RawRes val raw: Int, val restsOnFirstFrame: Boolean = false) {
    /** What is missing can be made right here, beside the button that makes it (wand, `8de70508…`). */
    Make(R.raw.state_wand),

    /** An agent is ready and waiting to be told what to do: an empty conversation (robot, `eeabc392…`). */
    Ready(R.raw.state_robot),

    /** The absence is the good outcome; nothing left to do (sparkles, `b14e504c…`). */
    Done(R.raw.state_sparkles),

    /** Nothing open yet: the tablet's main panel beside the sidebar (owl, `95402270…`; happy-ios 75715e1c0). */
    Owl(R.raw.state_owl),

    /** Nothing made to keep yet: the empty Artifacts list (yellow ticket, `8715ac66…`). */
    Tickets(R.raw.state_tickets),

    /**
     * A task about to be made: over new work's Task, as a bot stands under [Ready] (magic wand, `6d23637e…`).
     * It rests on its first frame, so a tap plays its whole spell (happy-ios `StateScene.restsOnFirstFrame`).
     */
    Action(R.raw.state_magic_wand, restsOnFirstFrame = true),
}

object StateAnimationTags {
    const val ANIMATION = "stateAnimation"
    const val PAGE = "statePage"
}

/**
 * State pictures read once and kept: a picture read here is drawn in the
 * first frame of whatever shows it, where Lottie's own loading leaves that
 * frame blank while it reads the file on another thread.
 */
object StateCompositions {
    private val read = ConcurrentHashMap<Int, LottieComposition>()

    /** Reads [arts] on this thread, ahead of need: app start does, off the main thread. */
    fun preload(context: Context, arts: List<StateArt>) {
        for (art in arts) get(context, art.raw)
    }

    /** [raw], if it has been read. */
    fun peek(@RawRes raw: Int): LottieComposition? = read[raw]

    /** [raw], read now on this thread unless it has been already; null if it won't parse. */
    fun get(context: Context, @RawRes raw: Int): LottieComposition? =
        read[raw] ?: LottieCompositionFactory.fromRawResSync(context.applicationContext, raw).value?.also { read[raw] = it }

    /** Forgets every picture read, as at launch. Tests start cold with this. */
    internal fun forget() = read.clear()
}

/**
 * One state picture in a fixed [size] box (desktop's empty states use 128
 * and 96), drawn whether or not the animation has loaded, so nothing around
 * it moves. As desktop's LottieScene: it plays once when it appears and
 * holds its last frame, the pose it was drawn to return to; a tap plays it
 * again. Not [autoplay], it holds that frame from the start and moves only
 * when tapped. It runs only while the screen is resumed, so it waits through
 * the background and goes on where it stopped. With animations removed it
 * shows the last frame and never moves. Art that [StateArt.restsOnFirstFrame]
 * holds its first frame instead, and shows it again after each play.
 * [immediate], it is there in the very first frame it is shown (new work's
 * robot and magic wand): read now if [StateCompositions] doesn't have it.
 */
@Composable
fun StateAnimation(art: StateArt, modifier: Modifier = Modifier, size: Dp = 128.dp, autoplay: Boolean = true, immediate: Boolean = false) {
    // Plays asked for; kept through recreation, so a rotation doesn't replay it.
    var requested by rememberSaveable(art) { mutableIntStateOf(if (autoplay) 1 else 0) }
    SceneAnimation(art.raw, requested, { requested = it + 1 }, modifier, size, art.restsOnFirstFrame, immediate)
}

/**
 * [raw] as [StateAnimation] plays it, for a caller that says when: it plays
 * once each time [requested] passes the plays it has finished, and
 * otherwise holds its last frame, or its first if [restsOnFirstFrame],
 * shown again once a play ends. A tap asks [onReplay] for one more, with
 * the plays finished so far; null, it can't be tapped. One already read
 * ([StateCompositions]), or [immediate], is drawn from its first frame.
 */
@Composable
fun SceneAnimation(
    @RawRes raw: Int,
    requested: Int,
    onReplay: ((played: Int) -> Unit)?,
    modifier: Modifier = Modifier,
    size: Dp = 128.dp,
    restsOnFirstFrame: Boolean = false,
    immediate: Boolean = false,
) {
    val reduceMotion = rememberReduceMotion()
    val context = LocalContext.current
    val ready = remember(raw) { if (immediate) StateCompositions.get(context, raw) else StateCompositions.peek(raw) }
    // Lottie's cache holds what was read here too, so this reads nothing twice.
    val loading by rememberLottieComposition(LottieCompositionSpec.RawRes(raw))
    val composition = ready ?: loading
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    val animatable = rememberLottieAnimatable()
    // Plays finished; kept through recreation with [requested].
    var played by rememberSaveable(raw) { mutableIntStateOf(0) }
    val rest = if (restsOnFirstFrame) 0f else 1f
    val idle = reduceMotion || played >= requested
    LaunchedEffect(composition, reduceMotion, active, requested) {
        val loaded = composition ?: return@LaunchedEffect
        if (reduceMotion || played >= requested) {
            animatable.snapTo(loaded, progress = rest)
            return@LaunchedEffect
        }
        if (!active) return@LaunchedEffect
        // Stopped by the background, it goes on from where it was; a replay starts over.
        val resuming = animatable.composition == loaded && played == requested - 1
        val from = animatable.progress.takeIf { resuming && it < 1f } ?: 0f
        animatable.animate(loaded, iterations = 1, initialProgress = from)
        if (restsOnFirstFrame) animatable.snapTo(loaded, progress = 0f)
        played = requested
    }
    val label = stringResource(R.string.state_animation_replay)
    Box(
        modifier = modifier
            .size(size)
            .testTag(StateAnimationTags.ANIMATION)
            .then(
                if (reduceMotion || onReplay == null) Modifier else Modifier.clickable(
                    interactionSource = null,
                    indication = null,
                    role = Role.Button,
                    onClickLabel = label,
                ) { if (played >= requested) onReplay(played) }.semantics { contentDescription = label },
            ),
    ) {
        // Until the effect has set it, the frame it is about to: at rest, or the start of its play.
        if (composition != null) LottieAnimation(composition, { if (animatable.composition == null) (if (idle) rest else 0f) else animatable.progress }, Modifier.fillMaxSize())
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
