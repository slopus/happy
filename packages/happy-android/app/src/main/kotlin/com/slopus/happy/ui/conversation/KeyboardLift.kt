package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imeAnimationSource
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
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

    /** The keyboard's height over the navigation bar that the layout is given, in pixels. Read where it lays out. */
    val rest: Int get() = min(above(from), above(to))

    /** How far above [rest] the keyboard is this frame, in pixels. Read only where things are placed or drawn. */
    val lift: Int get() = (above(now) - rest).coerceAtLeast(0)
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
 * glass here still knows where it is.
 */
fun Modifier.riding(keyboard: KeyboardLift, share: Float = 1f): Modifier =
    offset { IntOffset(0, -(keyboard.lift * share).toInt()) }

/** Drawn [KeyboardLift.lift] higher, without moving its layout: for the transcript, under its own clip and in its glass's recording. */
fun Modifier.lifted(keyboard: KeyboardLift): Modifier =
    graphicsLayer { translationY = -keyboard.lift.toFloat() }
