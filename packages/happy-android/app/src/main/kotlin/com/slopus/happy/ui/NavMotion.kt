package com.slopus.happy.ui

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.navigation.NavBackStackEntry
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlin.math.sign

private typealias NavScope = AnimatedContentTransitionScope<NavBackStackEntry>

/**
 * How the app's one NavHost moves between screens: Material's shared X axis.
 * Forward, the new screen comes in from the end side while the old one
 * leaves toward the start, each travelling [travel] as they cross in
 * opacity; Back is the mirror. Start and end follow the layout direction,
 * so a right-to-left language mirrors it. The travel is a fixed distance,
 * not a share of the pane, so a wide tablet detail moves no further than a
 * phone. With animations off ([rememberReduceMotion]) screens change at once.
 *
 * [HappyApp] also passes the two pop transitions to the NavHost's predictive
 * callbacks: an edge gesture scrubs the same reverse motion and the library
 * handles its completion or cancellation. Leaving those callbacks at their
 * defaults would scale the outgoing screen down instead of sliding it.
 */
@Immutable
class NavMotion(
    val enter: NavScope.() -> EnterTransition,
    val exit: NavScope.() -> ExitTransition,
    val popEnter: NavScope.() -> EnterTransition,
    val popExit: NavScope.() -> ExitTransition,
) {
    companion object {
        const val DURATION_MILLIS = 300

        /** The outgoing screen has faded by here; the incoming one fades in over the rest. */
        const val FADE_OUT_MILLIS = 90

        /** Material's shared-axis travel. */
        val travel = 30.dp

        val None = NavMotion({ EnterTransition.None }, { ExitTransition.None }, { EnterTransition.None }, { ExitTransition.None })

        fun sharedAxisX(travelPx: Int): NavMotion {
            val slide = tween<IntOffset>(DURATION_MILLIS, easing = FastOutSlowInEasing)
            val fadeIn = fadeIn(tween(DURATION_MILLIS - FADE_OUT_MILLIS, delayMillis = FADE_OUT_MILLIS, easing = LinearOutSlowInEasing))
            val fadeOut = fadeOut(tween(FADE_OUT_MILLIS, easing = FastOutLinearInEasing))
            // The container hands over a full-width offset already signed for the direction; keep the sign, not the width.
            val distance = { fullSlide: Int -> fullSlide.sign * travelPx }
            fun NavScope.into(towards: SlideDirection) = slideIntoContainer(towards, slide, distance) + fadeIn
            fun NavScope.outOf(towards: SlideDirection) = slideOutOfContainer(towards, slide, distance) + fadeOut
            return NavMotion(
                enter = { into(SlideDirection.Start) },
                exit = { outOf(SlideDirection.Start) },
                popEnter = { into(SlideDirection.End) },
                popExit = { outOf(SlideDirection.End) },
            )
        }
    }
}

@Composable
fun rememberNavMotion(): NavMotion {
    val reduceMotion = rememberReduceMotion()
    val travelPx = with(LocalDensity.current) { NavMotion.travel.roundToPx() }
    return remember(reduceMotion, travelPx) { if (reduceMotion) NavMotion.None else NavMotion.sharedAxisX(travelPx) }
}
