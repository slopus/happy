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
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
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
 * The dim is the page beneath at 80% opacity over [backdrop]'s black, which
 * is drawn only while two pages are on screen.
 */
@Immutable
class NavMotion(
    val enter: NavScope.() -> EnterTransition,
    val exit: NavScope.() -> ExitTransition,
    val popEnter: NavScope.() -> EnterTransition,
    val popExit: NavScope.() -> ExitTransition,
    val predictivePopEnter: NavScope.(Int) -> EnterTransition,
    val predictivePopExit: NavScope.(Int) -> ExitTransition,
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
            val pop = pop(easing, fromFirstFrame = true)
            val gesture = pop(GestureEasing(dragging), fromFirstFrame = false)
            return NavMotion(
                enter = { slideIntoContainer(SlideDirection.Start, spec(easing, fromFirstFrame = true)) },
                exit = {
                    slideOutOfContainer(SlideDirection.Start, spec(easing, fromFirstFrame = true), ::parallax) +
                        fadeOut(spec(easing, fromFirstFrame = true), targetAlpha = 1f - DIM)
                },
                popEnter = { pop.first(this) },
                popExit = { pop.second(this) },
                predictivePopEnter = { gesture.first(this) },
                predictivePopExit = { gesture.second(this) },
            )
        }

        private fun parallax(fullSlide: Int) = (fullSlide * PARALLAX).roundToInt()

        private fun <T> spec(easing: Easing, fromFirstFrame: Boolean): FiniteAnimationSpec<T> =
            tween<T>(DURATION_MILLIS, easing = easing).let { if (fromFirstFrame) FromFirstFrame(it) else it }

        private fun pop(easing: Easing, fromFirstFrame: Boolean): Pair<NavScope.() -> EnterTransition, NavScope.() -> ExitTransition> =
            Pair(
                {
                    slideIntoContainer(SlideDirection.End, spec(easing, fromFirstFrame), ::parallax) +
                        fadeIn(spec(easing, fromFirstFrame), initialAlpha = 1f - DIM)
                },
                { slideOutOfContainer(SlideDirection.End, spec(easing, fromFirstFrame)) },
            )
    }
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
