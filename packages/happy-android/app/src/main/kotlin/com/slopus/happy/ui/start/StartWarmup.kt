package com.slopus.happy.ui.start

import android.app.Activity
import android.content.res.Configuration
import android.os.Build
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * What the first screen draws with, made off the main thread before it
 * shows: Grain Gradient's programs and its grain at the window's size
 * ([GrainCache]), and Liquid Metal's program and field; before Android 13,
 * the sky's frame 0 at the window's size in the theme's palette
 * ([ShaderStills]). Each is waited for by the frame that first needs it, so
 * without this the first screen would come late; made on the main thread
 * as the screen composed, they held its first frames (and the Happy Cloud
 * welcome's, which has a gradient of its own). Asked for once the app knows
 * the first screen is Start.
 */
object StartWarmup {
    fun warm(activity: Activity) {
        // Start fills the window, edge to edge.
        val bounds = activity.windowManager.currentWindowMetricsBounds()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            val dark = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            ShaderStills.warmSky(bounds, if (dark) StartSpec.darkPalette else StartSpec.lightPalette)
            return
        }
        GrainCache.warm(bounds)
        val resources = activity.resources
        CoroutineScope(Dispatchers.Default).launch {
            LiquidMetalProgram.get()
            LiquidMetalField.load(resources)
        }
    }

    private fun android.view.WindowManager.currentWindowMetricsBounds(): IntSize = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        currentWindowMetrics.bounds.let { IntSize(it.width(), it.height()) }
    } else {
        @Suppress("DEPRECATION")
        android.util.DisplayMetrics().also { defaultDisplay.getRealMetrics(it) }.let { IntSize(it.widthPixels, it.heightPixels) }
    }
}
