package com.slopus.happy.ui.camera

import android.view.KeyEvent
import android.view.Window
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState

/** Scope volume capture to the live camera; preserve every other key and restore the delegate. */
@Composable
internal fun PhotoVolumeKeys(window: Window?, enabled: Boolean, onShutter: () -> Unit) {
    val shutter by rememberUpdatedState(onShutter)
    DisposableEffect(window, enabled) {
        val previous = window?.callback
        val callback = if (previous != null && enabled) object : Window.Callback by previous {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
                    if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) shutter()
                    return true
                }
                return previous.dispatchKeyEvent(event)
            }
        } else null
        if (callback != null) window?.callback = callback
        onDispose { if (callback != null && window?.callback === callback) window.callback = previous }
    }
}