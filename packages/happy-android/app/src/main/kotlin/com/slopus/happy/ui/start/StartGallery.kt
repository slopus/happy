package com.slopus.happy.ui.start

import android.view.accessibility.AccessibilityManager
import androidx.annotation.RawRes
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.R
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.onboarding.OnboardingContentSpec
import com.slopus.happy.ui.onboarding.cappedScale
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

object StartGalleryTags {
    const val GALLERY = "start.gallery"
    const val PAGER = "start.pager"
    const val DOTS = "start.dots"
    fun art(index: Int) = "start.art.$index"
    fun title(index: Int) = "start.title.$index"
    fun body(index: Int) = "start.body.$index"
    fun dot(index: Int) = "start.dot.$index"
}

/** One slide: its art over its title and line. */
data class StartSlide(val art: Art, val title: Int, val body: Int) {
    sealed interface Art {
        /** The Happy mark, in the words' colour. */
        data object Logo : Art
        /** Happy Cloud's mark in Liquid Metal ([LiquidMetalMark]), filling its square; moving only while its slide shows. */
        data object Cloud : Art
        /** One of desktop's scenes (res/raw), played as its slide arrives. */
        data class Scene(@RawRes val raw: Int) : Art
    }
}

/**
 * happy-desktop's welcome deck (happyAgentWelcomeSlides.ts) without
 * "Secure and compliant", which desktop dropped: its logo, then its scenes
 * (alien-monster, llama, wand), the same Lottie files as desktop's.
 */
val StartSlides = listOf(
    StartSlide(StartSlide.Art.Logo, R.string.start_slide_happy_title, R.string.start_slide_happy_body),
    StartSlide(StartSlide.Art.Scene(R.raw.state_alien_monster), R.string.start_slide_team_title, R.string.start_slide_team_body),
    StartSlide(StartSlide.Art.Scene(R.raw.state_llama), R.string.start_slide_mix_title, R.string.start_slide_mix_body),
    StartSlide(StartSlide.Art.Scene(R.raw.state_wand), R.string.start_slide_open_title, R.string.start_slide_open_body),
)

/** iOS's StartLayout.Metrics, in dp. */
object StartGallerySpec {
    /** The art's square: a phone's, a tablet's, and a short window's. */
    val art = 96.dp
    val artRegular = 128.dp
    val artCompact = 56.dp
    /** The Happy mark fills this much of its square; a scene fills all of it. */
    const val ART_FILL = 0.8f
    /** Happy Cloud's Liquid Metal mark is drawn this much larger than the art's square (iOS StartLayout.Metrics.cloudScale). */
    const val CLOUD_SCALE = 1.3f
    val artGap = 24.dp
    val artGapCompact = 16.dp
    val titleGap = 8.dp
    val dotsGap = 24.dp
    val dotsGapCompact = 12.dp
    /** Kept clear above and below the slides. */
    val margin = 16.dp
    val sidePadding = 24.dp
    val columnMaxWidth = 440.dp
    val compactHeight = 600.dp
    val regularWidth = 600.dp
    val regularHeight = 700.dp
    val dot = 8.dp
    /** Each dot's target: 24 across, as tall as the row. */
    val dotTarget = 24.dp
    /**
     * Onboarding's title (28/34), capped at 1.2 as it is. Filled line by
     * line: the English titles hold each short sentence together with
     * no-break spaces, so they break only between sentences, after as many
     * as fit ("Any team. Any model. / One app.").
     */
    val title = OnboardingContentSpec.title.copy(lineBreak = LineBreak.Simple)
    val body = happyTextStyle(fontSize = 17, lineHeight = 24)
    /** Desktop holds a slide 15 s for its longer words; a phone's are one line. */
    const val ADVANCE_MILLIS = 8_000L
    const val CROSSFADE_MILLIS = 175

    /** The art's square for a window of this size. */
    fun artFor(width: Dp, height: Dp): Dp = when {
        height < compactHeight -> artCompact
        width >= regularWidth && height >= regularHeight -> artRegular
        else -> art
    }
}

/**
 * The first screen's slides, WelcomeDeck.tsx on a phone: the art in a fixed
 * square, then the title and its line, swiped across with dots under them.
 * Every slide's words are laid over one another in each page and only its
 * own are seen ([SlideWordsRoom]), so no title, line or dot moves as the
 * slides change. They move on by themselves
 * every [advanceMillis] while the screen is resumed and
 * nothing is being dragged, wrapping to the first with a crossfade; any
 * change starts the wait again. A slide's scene plays once each time the
 * slide settles in place and holds its last frame; a tap plays it again.
 * With animations removed, or TalkBack on, nothing moves by itself and the
 * dots change slides without the slide; with animations removed the scenes
 * only show their last frame.
 *
 * [art] is the square for the window ([StartGallerySpec.artFor]).
 */
@Composable
fun StartGallery(
    textColor: Color,
    secondaryColor: Color,
    dotColor: Color,
    art: Dp,
    compact: Boolean,
    modifier: Modifier = Modifier,
    slides: List<StartSlide> = StartSlides,
    /** Every press on a slide's art, with its time, watched and never consumed (Happy Cloud's welcome counts them). */
    /** How long a slide holds before the next: Happy Cloud's longer lines hold 12 s, as iOS's. */
    advanceMillis: Long = StartGallerySpec.ADVANCE_MILLIS,
    onArtPress: ((Long) -> Unit)? = null,
) {
    val pager = rememberPagerState { slides.size }
    val scope = rememberCoroutineScope()
    val reduceMotion = rememberReduceMotion()
    val touchExploration = rememberTouchExploration()
    val dragged by pager.interactionSource.collectIsDraggedAsState()
    val fade = remember { Animatable(1f) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Each slide's arrivals, the plays its scene is asked for; the last one counted, so a rotation counts none.
    var arrivals by rememberSaveable { mutableStateOf(IntArray(slides.size)) }
    var arrived by rememberSaveable { mutableIntStateOf(-1) }
    fun play(page: Int, times: Int) {
        arrivals = arrivals.copyOf().also { it[page] = times }
    }
    LaunchedEffect(pager.settledPage) {
        val page = pager.settledPage
        if (page != arrived) {
            arrived = page
            play(page, arrivals[page] + 1)
        }
    }

    // A jump of more than one slide (the wrap, a far dot) crossfades
    // rather than running past the others.
    suspend fun show(page: Int) {
        if (reduceMotion) {
            pager.scrollToPage(page)
        } else if (abs(page - pager.currentPage) > 1) {
            fade.animateTo(0f, tween(StartGallerySpec.CROSSFADE_MILLIS))
            pager.scrollToPage(page)
            fade.animateTo(1f, tween(StartGallerySpec.CROSSFADE_MILLIS))
        } else {
            pager.animateScrollToPage(page)
        }
    }

    LaunchedEffect(pager.settledPage, dragged, reduceMotion, touchExploration, slides.size, advanceMillis) {
        if (reduceMotion || touchExploration || dragged || slides.size < 2) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            delay(advanceMillis)
            // Not in this effect: the move changes the page, which restarts the effect, and would stop it half done (the crossfade at 0).
            scope.launch { show((pager.settledPage + 1) % slides.size) }
        }
    }

    val artGap = if (compact) StartGallerySpec.artGapCompact else StartGallerySpec.artGap
    val dotsGap = if (compact) StartGallerySpec.dotsGapCompact else StartGallerySpec.dotsGap
    Column(modifier.fillMaxWidth().testTag(StartGalleryTags.GALLERY), horizontalAlignment = Alignment.CenterHorizontally) {
        HorizontalPager(
            state = pager,
            modifier = Modifier.fillMaxWidth().graphicsLayer { alpha = fade.value }.testTag(StartGalleryTags.PAGER),
            verticalAlignment = Alignment.Top,
        ) { page ->
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                SlideArt(
                    art = slides[page].art,
                    side = art,
                    tint = textColor,
                    plays = arrivals[page],
                    showing = page == pager.settledPage,
                    onReplay = { played -> play(page, played + 1) },
                    modifier = Modifier.testTag(StartGalleryTags.art(page)).then(
                        if (onArtPress == null) Modifier else Modifier.pointerInput(onArtPress) {
                            awaitEachGesture { onArtPress(awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial).uptimeMillis) }
                        },
                    ),
                )
                Spacer(Modifier.height(artGap))
                SlideWordsRoom(slides, own = page, textColor = textColor, secondaryColor = secondaryColor)
            }
        }
        Spacer(Modifier.height(dotsGap))
        Row(Modifier.testTag(StartGalleryTags.DOTS), horizontalArrangement = Arrangement.Center) {
            slides.forEachIndexed { index, slide ->
                val current = index == pager.currentPage
                val title = stringResource(slide.title)
                Box(
                    Modifier
                        .size(StartGallerySpec.dotTarget)
                        .clickable(role = Role.Tab) { scope.launch { show(index) } }
                        .semantics {
                            contentDescription = title
                            selected = current
                        }
                        .testTag(StartGalleryTags.dot(index)),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(StartGallerySpec.dot).clip(CircleShape).background(if (current) textColor else dotColor))
                }
            }
        }
    }
}

@Composable
private fun SlideArt(art: StartSlide.Art, side: Dp, tint: Color, plays: Int, showing: Boolean, onReplay: (Int) -> Unit, modifier: Modifier) {
    Box(modifier.size(side), contentAlignment = Alignment.Center) {
        when (art) {
            StartSlide.Art.Logo -> Image(
                painter = painterResource(R.drawable.logo_black),
                contentDescription = null,
                colorFilter = ColorFilter.tint(tint),
                modifier = Modifier.size(side * StartGallerySpec.ART_FILL),
            )
            // 1.3 the art's square, centred on it (iOS cloudScale): the cloud is wide, so it spills only sideways and nothing under it moves.
            StartSlide.Art.Cloud -> LiquidMetalMark(
                Modifier.wrapContentSize(unbounded = true).requiredSize(side * StartGallerySpec.CLOUD_SCALE),
                paused = !showing,
                fallbackColor = tint,
            )
            is StartSlide.Art.Scene -> SceneAnimation(art.raw, plays, onReplay, size = side)
        }
    }
}

/**
 * Every slide's words, one over another in two rooms: every title in the
 * tallest title's, then 8, then every line in the tallest line's. So
 * nothing moves as the slides change: each title starts where the others
 * do, and each line too, under a short title as under a long one. Only
 * slide [own]'s are seen or read; with none, it is the room alone, which
 * the next screen keeps so its words fall where these are.
 */
@Composable
internal fun SlideWordsRoom(
    slides: List<StartSlide>,
    own: Int?,
    textColor: Color,
    secondaryColor: Color,
    modifier: Modifier = Modifier,
) {
    fun Modifier.seen(index: Int) = if (index == own) this else alpha(0f).clearAndSetSemantics {}
    Column(
        modifier
            .padding(horizontal = StartGallerySpec.sidePadding)
            .widthIn(max = StartGallerySpec.columnMaxWidth)
            .fillMaxWidth(),
    ) {
        Box {
            slides.forEachIndexed { index, slide ->
                Text(
                    text = stringResource(slide.title),
                    style = cappedScale(StartGallerySpec.title, OnboardingContentSpec.TITLE_MAX_SCALE),
                    color = textColor,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .then(if (index == own) Modifier.testTag(StartGalleryTags.title(index)) else Modifier)
                        .seen(index)
                        .fillMaxWidth()
                        .semantics { heading() },
                )
            }
        }
        Spacer(Modifier.height(StartGallerySpec.titleGap))
        Box {
            slides.forEachIndexed { index, slide ->
                Text(
                    text = stringResource(slide.body),
                    style = StartGallerySpec.body.copy(lineBreak = LineBreak.Paragraph),
                    color = secondaryColor,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .then(if (index == own) Modifier.testTag(StartGalleryTags.body(index)) else Modifier)
                        .seen(index)
                        .fillMaxWidth(),
                )
            }
        }
    }
}

/** Whether TalkBack (touch exploration) is on, following it as it changes. */
@Composable
private fun rememberTouchExploration(): Boolean {
    val context = LocalContext.current
    val manager = remember(context) { context.getSystemService(AccessibilityManager::class.java) }
    var on by remember(manager) { mutableStateOf(manager?.isTouchExplorationEnabled == true) }
    DisposableEffect(manager) {
        val listener = AccessibilityManager.TouchExplorationStateChangeListener { on = it }
        manager?.addTouchExplorationStateChangeListener(listener)
        onDispose { manager?.removeTouchExplorationStateChangeListener(listener) }
    }
    return on
}
