package com.slopus.happy.ui.camera

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput

/** Tap/hold competes with pan/pinch; changing zoom or exposure never restarts the active gesture. */
@Composable
internal fun photoGestures(onFocus: (Offset, Boolean) -> Unit, onTransform: (Offset, Float) -> Unit): Modifier {
    val focus by rememberUpdatedState(onFocus)
    val transform by rememberUpdatedState(onTransform)
    return Modifier.pointerInput(Unit) {
        detectTapGestures(onTap = { focus(it, false) }, onLongPress = { focus(it, true) })
    }.pointerInput(Unit) {
        detectTransformGestures { _, pan, zoom, _ -> transform(pan, zoom) }
    }
}