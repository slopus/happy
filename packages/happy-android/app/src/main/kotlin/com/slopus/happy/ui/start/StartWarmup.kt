package com.slopus.happy.ui.start

import android.app.Activity
import android.os.Build
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * What the first screen draws with, made off the main thread before it
 * shows: Grain Gradient's programs and its grain at the window's size
 * ([GrainCache]), and Liquid Metal's program and field. Made on the main
 * thread as the screen composed, they held its first frames (and the Happy
 * Cloud welcome's, which has a gradient of its own). Asked for once the app
 * knows the first screen is Start.
 */
object StartWarmup {
    fun warm(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        // Start fills the window, edge to edge.
        val bounds = activity.windowManager.currentWindowMetrics.bounds
        GrainCache.warm(IntSize(bounds.width(), bounds.height()))
        val resources = activity.resources
        CoroutineScope(Dispatchers.Default).launch {
            LiquidMetalProgram.get()
            LiquidMetalField.load(resources)
        }
    }
}
