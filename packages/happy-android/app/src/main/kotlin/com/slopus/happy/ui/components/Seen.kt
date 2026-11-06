package com.slopus.happy.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onVisibilityChanged
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle

/**
 * Calls [onSeen] once what this modifies is in front of the person: half
 * or more of it on the screen, the page resumed, and nothing up over it
 * ([LocalOverlays]: a [PageDialog] is in the same window, so the page stays
 * resumed under it). Again each time that comes back, and again for a new
 * [key]; the caller counts once.
 */
@Composable
fun Modifier.onSeen(key: Any, onSeen: () -> Unit): Modifier {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var onScreen by remember { mutableStateOf(false) }
    val overlays = LocalOverlays.current
    val uncovered by remember(overlays) { derivedStateOf { overlays?.isEmpty != false } }
    val seen by rememberUpdatedState(onSeen)
    LaunchedEffect(key, lifecycle, onScreen, uncovered) {
        if (onScreen && uncovered) lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { seen() }
    }
    return onVisibilityChanged(minFractionVisible = 0.5f) { onScreen = it }
}
