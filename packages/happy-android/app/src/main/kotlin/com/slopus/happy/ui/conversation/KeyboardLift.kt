package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imeAnimationSource
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset
import com.slopus.happy.ui.components.GlassTravel
import kotlin.math.min

/**
 * The keyboard as Telegram's AdjustPanLayoutHelper moves a chat for it
 * (`ui/ActionBar/AdjustPanLayoutHelper.java`, its WindowInsetsAnimation
 * callback): while the keyboard animates, the dock and the transcript move
 * with it by an offset each frame, and the layout takes the keyboard's
 * height once, at whichever end of the animation it is lower, so as a hide
 * starts and as a show ends. Nothing is measured on the frames between.
 * Without an animation (Android before 11, or animations off) the keyboard
 * is in the layout at once and [lift] stays 0.
 */
@Stable
class KeyboardLift internal constructor(
    private val now: WindowInsets,
    private val from: WindowInsets,
    private val to: WindowInsets,
    private val navigation: WindowInsets,
    private val density: Density,
) {
    private fun above(insets: WindowInsets) = (insets.getBottom(density) - navigation.getBottom(density)).coerceAtLeast(0)

    /** The keyboard's height over the navigation bar that the layout is given, in pixels. Read where it lays out or places, not where it composes. */
    val rest: Int get() = min(above(from), above(to))

    /** How far above [rest] the keyboard is this frame, in pixels. Read only where things are placed or drawn. */
    val lift: Int get() = (above(now) - rest).coerceAtLeast(0)

    /**
     * What is placed [aboveKeyboard] travels with it: up by the keyboard's
     * height over the navigation bar this frame, between where its animation
     * started and where it ends. The glass over the transcript blurs the band
     * the whole way passes under it once ([GlassTravel]). Read where it draws.
     */
    val travel: GlassTravel = object : GlassTravel {
        override val now: Int get() = above(this@KeyboardLift.now)
        override val from: Int get() = above(this@KeyboardLift.from)
        override val to: Int get() = above(this@KeyboardLift.to)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun rememberKeyboardLift(): KeyboardLift {
    val now = WindowInsets.ime
    val from = WindowInsets.imeAnimationSource
    val to = WindowInsets.imeAnimationTarget
    val navigation = WindowInsets.navigationBars
    val density = LocalDensity.current
    return remember(now, from, to, navigation, density) { KeyboardLift(now, from, to, navigation, density) }
}

/**
 * Placed [KeyboardLift.lift] higher ([share] of it: half for what sits
 * centred between the bar and the dock). A placement only, so what is
 * glass here still knows where it is. The transcript and the dock ride
 * together, each in a layer of its own, so a frame moves two layers: the
 * dock's glass shows the same content as the frame before and isn't blurred
 * again, and only the bar's is.
 */
fun Modifier.riding(keyboard: KeyboardLift, share: Float = 1f): Modifier =
    offset { IntOffset(0, -(keyboard.lift * share).toInt()) }

/**
 * Placed above the keyboard: [KeyboardLift.rest] and [KeyboardLift.lift]
 * higher, read where it is placed, so the keyboard settling moves it and
 * lays nothing out, for what doesn't need the room above the keyboard to
 * measure (the dock's fade, the jump button).
 */
fun Modifier.aboveKeyboard(keyboard: KeyboardLift): Modifier =
    offset { IntOffset(0, -(keyboard.rest + keyboard.lift)) }

/**
 * [bottom] and the keyboard's [KeyboardLift.rest] of room kept under this,
 * read where it is laid out: the keyboard settling measures it again and
 * composes nothing.
 */
fun Modifier.keyboardPadding(keyboard: KeyboardLift, bottom: Dp = 0.dp): Modifier = layout { measurable, constraints ->
    val room = bottom.roundToPx() + keyboard.rest
    val placeable = measurable.measure(constraints.offset(vertical = -room))
    layout(placeable.width, constraints.constrainHeight(placeable.height + room)) { placeable.place(0, 0) }
}

/**
 * The padding of a list placed [aboveKeyboard] at its whole height: the
 * keyboard's [KeyboardLift.rest] goes over its top, which is then that far
 * above the screen, so its oldest end still rests under the bar. The list
 * keeps its height and its rows where the keyboard comes and goes: none
 * is composed or placed again as it settles, and those it uncovers are
 * already there. Read as the list lays out.
 */
@Stable
class KeyboardPadding(private val top: Dp, private val bottom: Dp, private val keyboard: KeyboardLift, private val density: Density) : PaddingValues {
    override fun calculateTopPadding(): Dp = top + with(density) { keyboard.rest.toDp() }
    override fun calculateBottomPadding(): Dp = bottom
    override fun calculateLeftPadding(layoutDirection: LayoutDirection): Dp = 0.dp
    override fun calculateRightPadding(layoutDirection: LayoutDirection): Dp = 0.dp
}
