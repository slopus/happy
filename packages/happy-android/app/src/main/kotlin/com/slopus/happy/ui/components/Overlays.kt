package com.slopus.happy.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first

/**
 * What is shown over the stack: menus, sheets, dialogs and popups, each
 * with a way to put it away. A link from outside clears them before it
 * opens its screen (iOS AppCoordinator `clearedForLink`, 78fa78cf9).
 * Otherwise a menu stays open over the pushed screen, or comes back open
 * when Back reveals the page it belongs to.
 */
class Overlays {
    private val shown = mutableStateListOf<Shown>()

    private class Shown(val dismiss: () -> Unit)

    val isEmpty: Boolean get() = shown.isEmpty()

    internal fun add(dismiss: () -> Unit): Any = Shown(dismiss).also { shown += it }

    internal fun remove(entry: Any) {
        shown.remove(entry)
    }

    /**
     * Puts everything shown away and returns once it has gone: once each has
     * left composition, plus the longest exit ([SheetMotion.EXIT_MS]), so
     * the next screen doesn't push while a menu is still fading. Returns at
     * once when nothing is shown.
     */
    suspend fun clear() {
        if (shown.isEmpty()) return
        shown.toList().forEach { it.dismiss() }
        snapshotFlow { shown.isEmpty() }.first { it }
        delay(SheetMotion.EXIT_MS.toLong())
    }
}

/** The app's [Overlays]; null (nothing tracked) outside HappyApp, as in most layout tests. */
val LocalOverlays = staticCompositionLocalOf<Overlays?> { null }

/**
 * Says that an overlay is up while [shown], and how to put it away. Call it
 * beside every menu, sheet, dialog or popup that isn't one of the shared
 * ones ([HappyDropdownMenu], [PageDialog], [PagePopup], [HappyAlert]),
 * which already do.
 */
@Composable
fun TrackOverlay(shown: Boolean, onDismiss: () -> Unit) {
    val overlays = LocalOverlays.current ?: return
    if (!shown) return
    val dismiss by rememberUpdatedState(onDismiss)
    DisposableEffect(overlays) {
        val entry = overlays.add { dismiss() }
        onDispose { overlays.remove(entry) }
    }
}
