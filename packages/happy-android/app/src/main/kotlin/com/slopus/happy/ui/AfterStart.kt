package com.slopus.happy.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * When the cold start is over (research/cold-start.md): the first frame is drawn
 * and the opening screen has reported itself fully drawn, or a little later if
 * it never does. Work that nothing on the first screen shows (push
 * registration and its Firebase start, notification channels, the paywall's
 * host) waits for it, so it doesn't contend with the first frame for the CPU.
 */
fun interface AfterStart {
    suspend fun await()
}

/** MainActivity's; elsewhere (tests, previews) the start is already over. */
val LocalAfterStart = staticCompositionLocalOf { AfterStart {} }

/**
 * Whether the window's first frame has been drawn. Until it is, glass draws
 * as its tint alone and blurs from the next frame: the blur's offscreen
 * layers cost the first frame about 6 ms of the RenderThread on the Fold
 * (research/cold-start.md). MainActivity holds it off until its first frame
 * is committed; everywhere else (tests, every later screen) it is drawn.
 */
object FirstFrame {
    var drawn by mutableStateOf(true)
        private set

    fun pending() {
        drawn = false
    }

    fun done() {
        drawn = true
    }
}
