package com.slopus.happy

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.view.Display
import androidx.activity.ComponentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlin.math.abs

/**
 * The window asks for the display's highest refresh rate at its current
 * resolution, as Telegram's `AndroidUtilities.setPreferredMaxRefreshRate`
 * does for LaunchActivity's window (`messenger/AndroidUtilities.java:2815`,
 * called from `LaunchActivity.onConfigurationChanged`, `:7247`): only
 * `preferredRefreshRate`, no mode id, so the window manager picks the mode
 * of that rate at whatever resolution the display has. Without it some
 * phones run an app at less than their screen can (a Nothing Phone at 90
 * of its 120 Hz).
 *
 * It is the same request Telegram makes: a preferred base rate for the
 * display while the window shows, not a floor, so the system still lowers
 * the rate where its own policy does (idle, battery saver, a low-rate
 * video), and nothing is asked for once the window is gone
 * (research/telegram-chat.md, "Phase 5: the refresh rate").
 *
 * Telegram measures its rate once and asks again on every configuration
 * change; this also asks as the window is created (Telegram's main window
 * otherwise keeps the system's rate until the first one), and when the
 * display itself changes (a fold or an unfold, a resolution chosen in
 * Settings), which may come without one.
 */
object MaxRefreshRate {
    /**
     * The highest refresh rate among [modes] at [current]'s resolution,
     * which a mode of another resolution can't give without changing it.
     */
    fun of(current: Display.Mode, modes: Array<Display.Mode>): Float =
        modes.filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
            .maxOfOrNull { it.refreshRate }
            ?.coerceAtLeast(current.refreshRate)
            ?: current.refreshRate

    /** Asks for [display]'s highest rate for [activity]'s window, if it isn't asked for already. */
    fun request(activity: ComponentActivity, display: Display? = displayOf(activity)) {
        display ?: return
        val rate = of(display.mode, display.supportedModes)
        val window = activity.window
        val params = window.attributes
        // updateViewLayout only on a change: onDisplayChanged comes again each time the rate moves.
        if (abs(params.preferredRefreshRate - rate) <= 0.2f) return
        params.preferredRefreshRate = rate
        window.attributes = params
    }

    /** [request] now, on every configuration change and on every change of the window's display, while [activity] lives. */
    fun follow(activity: ComponentActivity) {
        request(activity)
        activity.addOnConfigurationChangedListener { request(activity) }
        val displays = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayChanged(displayId: Int) {
                val display = displayOf(activity) ?: return
                if (display.displayId == displayId) request(activity, display)
            }
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit
        }
        activity.lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) = displays.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
            override fun onDestroy(owner: LifecycleOwner) = displays.unregisterDisplayListener(listener)
        })
    }

    /** The activity's window manager's display is the one the activity is on, on every API, as Telegram reads it. */
    @Suppress("DEPRECATION")
    private fun displayOf(activity: ComponentActivity): Display? = activity.windowManager.defaultDisplay
}
