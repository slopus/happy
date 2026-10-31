package com.slopus.happy.ui

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.DurationBasedAnimationSpec
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorizedDurationBasedAnimationSpec
import androidx.compose.animation.core.VectorizedFiniteAnimationSpec
import androidx.compose.animation.core.tween
import androidx.compose.animation.AnimatedContentScope
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.snap
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Stable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.draw.drawWithContent
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import androidx.navigationevent.NavigationEventDispatcher
import androidx.navigationevent.NavigationEventTransitionState
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlin.math.roundToInt

private typealias NavScope = AnimatedContentTransitionScope<NavBackStackEntry>

/**
 * One page motion for every push and pop, measured from One UI 9's Settings
 * on the Galaxy Z Fold7 (`research/navigation-motion.md`): the new page
 * slides in over the old one from the pane's end edge, the whole pane width,
 * in 450 ms on cubic-bezier(0.22, 0.4, 0, 1). The old page moves 26% of the
 * width the other way and dims by 20%; nothing fades. Back is the same motion
 * reversed, whatever asks for it: the toolbar arrow, the system back key or
 * three-button bar, or a deep link's pop. Start and end follow the layout
 * direction; the tablet sidebar stays outside the moving pane. With
 * animations off pages change at once. A push or pop is timed from the
 * first frame it draws ([FromFirstFrame]), so a heavy page doesn't skip it.
 *
 * The back gesture scrubs that pop under the finger: the pages sit where the
 * gesture's progress puts them, linearly, as Settings' do. On release the rest
 * runs on the same curve from where the finger left it (commit), or back to
 * the start (cancel), in the matching share of 450 ms. See [GestureEasing].
 *
 * The dim is a black scrim over the page beneath, 20% at full cover
 * ([PageDims], drawn by [page]): the same pixels as that page at 80% opacity
 * over black, without the full-window offscreen layer a page's alpha costs
 * the GPU on the first frame of every push (10 to 18 ms on the Fold).
 */
@Immutable
class NavMotion(
    val enter: NavScope.() -> EnterTransition,
    val exit: NavScope.() -> ExitTransition,
    val popEnter: NavScope.() -> EnterTransition,
    val popExit: NavScope.() -> ExitTransition,
    val predictivePopEnter: NavScope.(Int) -> EnterTransition,
    val predictivePopExit: NavScope.(Int) -> ExitTransition,
    /** The pages beneath a moving one, which [page] dims. */
    val dims: PageDims = PageDims(),
) {
    companion object {
        const val DURATION_MILLIS = 450

        /** How far the page beneath travels, as a share of the pane's width. */
        const val PARALLAX = 0.26f

        /** How much the page beneath darkens when fully covered. */
        const val DIM = 0.2f

        val easing = CubicBezierEasing(0.22f, 0.4f, 0f, 1f)

        val None = NavMotion(
            { EnterTransition.None }, { ExitTransition.None }, { EnterTransition.None }, { ExitTransition.None },
            { EnterTransition.None }, { ExitTransition.None },
        )

        fun pageSlide(dragging: () -> Boolean): NavMotion {
            val dims = PageDims()
            val pop = pop(easing, fromFirstFrame = true, dims)
            val gesture = pop(GestureEasing(dragging), fromFirstFrame = false, dims)
            return NavMotion(
                enter = {
                    dims.top(targetState)
                    slideIntoContainer(SlideDirection.Start, spec(easing, fromFirstFrame = true))
                },
                exit = {
                    dims.beneath(initialState, spec(easing, fromFirstFrame = true))
                    slideOutOfContainer(SlideDirection.Start, spec(easing, fromFirstFrame = true), ::parallax)
                },
                popEnter = { pop.first(this) },
                popExit = { pop.second(this) },
                predictivePopEnter = { gesture.first(this) },
                predictivePopExit = { gesture.second(this) },
                dims = dims,
            )
        }

        private fun parallax(fullSlide: Int) = (fullSlide * PARALLAX).roundToInt()

        private fun <T> spec(easing: Easing, fromFirstFrame: Boolean): FiniteAnimationSpec<T> =
            tween<T>(DURATION_MILLIS, easing = easing).let { if (fromFirstFrame) FromFirstFrame(it) else it }

        private fun pop(easing: Easing, fromFirstFrame: Boolean, dims: PageDims): Pair<NavScope.() -> EnterTransition, NavScope.() -> ExitTransition> =
            Pair(
                {
                    dims.beneath(targetState, spec(easing, fromFirstFrame))
                    slideIntoContainer(SlideDirection.End, spec(easing, fromFirstFrame), ::parallax)
                },
                {
                    dims.top(initialState)
                    slideOutOfContainer(SlideDirection.End, spec(easing, fromFirstFrame))
                },
            )
    }
}

/**
 * Which pages are beneath a moving one, each with the motion that moves it:
 * NavMotion's transitions say, as they are chosen, and [page] draws the
 * scrim from them. A page on top is not dimmed.
 */
@Stable
class PageDims {
    private val beneath = HashMap<String, FiniteAnimationSpec<Float>>()

    internal fun beneath(entry: NavBackStackEntry, spec: FiniteAnimationSpec<Float>) {
        beneath[entry.id] = spec
    }

    internal fun top(entry: NavBackStackEntry) {
        beneath.remove(entry.id)
    }

    internal fun spec(entry: NavBackStackEntry): FiniteAnimationSpec<Float>? = beneath[entry.id]
}

/** The NavHost's [PageDims], for [page]; none outside one with [NavMotion]. */
val LocalPageDims = staticCompositionLocalOf<PageDims?> { null }

/**
 * A destination whose page wears the dim while another moves over it
 * ([DimmedPage]): every NavHost destination of the app is one.
 */
inline fun <reified T : Any> NavGraphBuilder.page(noinline content: @Composable AnimatedContentScope.(NavBackStackEntry) -> Unit) {
    composable<T> { entry -> DimmedPage(entry) { content(entry) } }
}

/**
 * [content], with [NavMotion.DIM]'s black scrim over it in step with the
 * motion while it is the page beneath ([PageDims]); nothing on top or at rest.
 */
@Composable
fun AnimatedContentScope.DimmedPage(entry: NavBackStackEntry, content: @Composable () -> Unit) {
    val dims = LocalPageDims.current
    if (dims == null) return content()
    val covered = transition.animateFloat(transitionSpec = { dims.spec(entry) ?: snap() }, label = "dim") { if (it == EnterExitState.Visible) 0f else 1f }
    Box(
        Modifier.drawWithContent {
            drawContent()
            val dim = if (dims.spec(entry) != null) covered.value * NavMotion.DIM else 0f
            if (dim > 0f) drawRect(Color.Black, alpha = dim)
        },
        propagateMinConstraints = true,
    ) { content() }
}

/**
 * [spec] timed from the first frame it is drawn in, not from the frame that
 * started it. A page's first frame composes, lays out and draws the page
 * coming in, 50 ms or more for a chat on the Fold; Compose's clock starts
 * before that frame, so the next one would land a third of the way in and a
 * push would seem to jump. The first sample is taken as one frame in.
 * Duration-based specs only; never for seeking, whose fraction is the time.
 */
internal class FromFirstFrame<T>(private val spec: DurationBasedAnimationSpec<T>) : FiniteAnimationSpec<T> {
    override fun <V : AnimationVector> vectorize(converter: TwoWayConverter<T, V>): VectorizedFiniteAnimationSpec<V> =
        Vectorized(spec.vectorize(converter))

    private class Vectorized<V : AnimationVector>(private val spec: VectorizedDurationBasedAnimationSpec<V>) : VectorizedFiniteAnimationSpec<V> {
        private var start = -1L

        private fun time(playTimeNanos: Long, sampling: Boolean): Long {
            if (playTimeNanos <= 0L) return 0L
            if (start < 0L && sampling) start = (playTimeNanos - FRAME_NANOS).coerceIn(0L, LATE_NANOS)
            return (playTimeNanos - start.coerceAtLeast(0L)).coerceAtLeast(0L)
        }

        override fun getValueFromNanos(playTimeNanos: Long, initialValue: V, targetValue: V, initialVelocity: V): V =
            spec.getValueFromNanos(time(playTimeNanos, sampling = true), initialValue, targetValue, initialVelocity)

        override fun getVelocityFromNanos(playTimeNanos: Long, initialValue: V, targetValue: V, initialVelocity: V): V =
            spec.getVelocityFromNanos(time(playTimeNanos, sampling = false), initialValue, targetValue, initialVelocity)

        // Long enough for the latest start; the curve is at rest by then.
        override fun getDurationNanos(initialValue: V, targetValue: V, initialVelocity: V): Long =
            spec.getDurationNanos(initialValue, targetValue, initialVelocity) + LATE_NANOS
    }

    private companion object {
        const val FRAME_NANOS = 8_333_333L
        const val LATE_NANOS = 150_000_000L
    }
}

/**
 * The back gesture's easing. navigation-compose seeks the pop to the
 * gesture's progress while the finger is down, then on release runs the rest
 * linearly to the end over (1 - progress) of the duration, or back to the
 * start over progress of it on FastOutSlowIn. Linear while [dragging], the
 * page follows the finger; after it, the part left is redrawn on
 * [NavMotion.easing], so a commit or a cancel moves as a pop does.
 */
internal class GestureEasing(private val dragging: () -> Boolean) : Easing {
    private var released = 0f

    override fun transform(fraction: Float): Float {
        if (dragging()) {
            released = fraction
            return fraction
        }
        val from = released
        return when {
            from >= 1f -> fraction
            fraction >= from -> from + (1f - from) * NavMotion.easing.transform((fraction - from) / (1f - from))
            // The library's cancel is fraction = from × (1 − FastOutSlowIn(time)).
            else -> from * (1f - NavMotion.easing.transform(fastOutSlowInInverse.transform(1f - fraction / from)))
        }
    }

    private companion object {
        /** FastOutSlowIn is cubic-bezier(0.4, 0, 0.2, 1); its inverse swaps each point's axes. */
        val fastOutSlowInInverse = CubicBezierEasing(0f, 0.4f, 1f, 0.2f)
    }
}

private fun NavigationEventDispatcher?.dragging(): Boolean =
    this?.transitionState?.value is NavigationEventTransitionState.InProgress

@Composable
fun rememberNavMotion(): NavMotion {
    val reduceMotion = rememberReduceMotion()
    val dispatcher = LocalNavigationEventDispatcherOwner.current?.navigationEventDispatcher
    return remember(reduceMotion, dispatcher) {
        if (reduceMotion) NavMotion.None else NavMotion.pageSlide { dispatcher.dragging() }
    }
}

/**
 * Black behind the NavHost while two pages are on screen, so the page beneath
 * dims instead of showing the window through it. At rest a page is drawn on
 * the window as before.
 */
@Composable
fun Modifier.backdrop(nav: NavHostController): Modifier {
    val entries by nav.visibleEntries.collectAsState()
    val dispatcher = LocalNavigationEventDispatcherOwner.current?.navigationEventDispatcher
    val gesture = dispatcher?.transitionState?.collectAsState()
    val moving = entries.count { it.destination !is NavGraph } > 1 ||
        gesture?.value is NavigationEventTransitionState.InProgress
    return if (moving) background(Color.Black) else this
}
