package com.slopus.happy.ui

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Easing
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
 * Telegram Android's ordinary page motion: 150 ms, 48 dp of foreground
 * travel, simultaneous alpha, decelerate factor 1.5 (1 - (1 - t)^3).
 * Forward, the new page moves in from the end side and fades in over the
 * stationary old page. Back moves and fades the outgoing page toward the
 * end, revealing the destination already drawn beneath it. The underlying
 * page never fades, so there is no blank handoff between the two pages.
 * Start and end follow the layout direction; the tablet sidebar stays
 * outside the moving pane. Reduced motion changes pages at once.
 *
 * Parameters: Telegram 13.1.1, commit 3de37c8cfb039452be7398909461da6288babf15,
 * ActionBarLayout.java:1821-1921 and its DecelerateInterpolator(1.5f).
 * Only the numerical motion specification is used here.
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
        const val DURATION_MILLIS = 150

        val travel = 48.dp
        private val easing = Easing { fraction -> 1f - (1f - fraction) * (1f - fraction) * (1f - fraction) }

        val None = NavMotion({ EnterTransition.None }, { ExitTransition.None }, { EnterTransition.None }, { ExitTransition.None })

        fun pageSlide(travelPx: Int): NavMotion {
            val slide = tween<IntOffset>(DURATION_MILLIS, easing = easing)
            val distance = { fullSlide: Int -> fullSlide.sign * travelPx }
            val appear = fadeIn(tween(DURATION_MILLIS, easing = easing))
            val disappear = fadeOut(tween(DURATION_MILLIS, easing = easing))
            return NavMotion(
                enter = { slideIntoContainer(SlideDirection.Start, slide, distance) + appear },
                exit = { ExitTransition.None },
                popEnter = { EnterTransition.None },
                popExit = { slideOutOfContainer(SlideDirection.End, slide, distance) + disappear },
            )
        }
    }
}

@Composable
fun rememberNavMotion(): NavMotion {
    val reduceMotion = rememberReduceMotion()
    val travelPx = with(LocalDensity.current) { NavMotion.travel.roundToPx() }
    return remember(reduceMotion, travelPx) { if (reduceMotion) NavMotion.None else NavMotion.pageSlide(travelPx) }
}
