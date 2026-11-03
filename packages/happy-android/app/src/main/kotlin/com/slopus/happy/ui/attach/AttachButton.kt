package com.slopus.happy.ui.attach

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.ui.unit.toSize

/**
 * The + an [AttachSheet] grows out of and goes back into ([AttachMorph]).
 * The sheet draws [glyph] on the growing glass, and the button itself is
 * hidden from the moment the morph takes it until the sheet has gone
 * (iOS `AttachSheetController.take`).
 */
@Stable
class AttachButton internal constructor(internal val glyph: @Composable () -> Unit) {
    internal var coordinates: LayoutCoordinates? = null
    internal var hidden by mutableStateOf(false)

    /** Where the button is on the screen, if it is laid out. */
    internal fun screenBounds(): Rect? = coordinates?.takeIf { it.isAttached }?.let { Rect(it.positionOnScreen(), it.size.toSize()) }
}

/** An [AttachButton] that draws [glyph], the button's own icon as it is at rest. */
@Composable
fun rememberAttachButton(glyph: @Composable () -> Unit): AttachButton {
    val current by rememberUpdatedState(glyph)
    return remember { AttachButton { current() } }
}

/** Marks the + for [button]: where it is, and hidden while the sheet has it. */
fun Modifier.attachButton(button: AttachButton): Modifier =
    onPlaced { button.coordinates = it }.graphicsLayer { alpha = if (button.hidden) 0f else 1f }
