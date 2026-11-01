package com.slopus.happy

import android.content.res.Configuration
import android.view.Display
import androidx.activity.ComponentActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.shadows.ShadowDisplay
import org.robolectric.shadows.ShadowDisplayManager
import org.robolectric.shadows.ShadowDisplayManager.ModeBuilder.modeBuilder

/**
 * The window asks for the display's highest refresh rate at its resolution
 * ([MaxRefreshRate], Telegram's setPreferredMaxRefreshRate), as it is
 * created, on a configuration change and when the display changes.
 */
@RunWith(AndroidJUnit4::class)
class MaxRefreshRateTest {
    private fun mode(id: Int, width: Int, height: Int, rate: Float): Display.Mode =
        modeBuilder(id).setWidth(width).setHeight(height).setRefreshRate(rate).build()

    @Test
    fun theHighestRateAtTheCurrentResolutionIsChosen() {
        // The Fold7's outer display: two resolutions, each at 120, 80 and 60 Hz.
        val wide = mode(8, 1080, 2520, 60f)
        val modes = arrayOf(mode(1, 1080, 2520, 120f), mode(2, 1080, 2520, 80f), wide, mode(4, 822, 1918, 144f), mode(5, 822, 1918, 60f))
        assertEquals(120f, MaxRefreshRate.of(wide, modes))
        assertEquals(144f, MaxRefreshRate.of(mode(5, 822, 1918, 60f), modes))
        // Only modes of another resolution: what it runs at.
        assertEquals(90f, MaxRefreshRate.of(mode(9, 100, 100, 90f), arrayOf(mode(1, 1080, 2520, 120f))))
    }

    @Test
    fun theWindowAsksForItAndAgainWhenTheDisplayChanges() {
        val display = Display.DEFAULT_DISPLAY
        val (w, h) = ShadowDisplay.getDefaultDisplay().mode.let { it.physicalWidth to it.physicalHeight }
        ShadowDisplayManager.setSupportedModes(display, mode(1, w, h, 60f), mode(2, w, h, 90f), mode(3, w, h, 120f), mode(6, w + 1, h, 165f))
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).create()
        val activity = controller.get()
        MaxRefreshRate.follow(activity)
        controller.start().resume().visible()
        assertEquals(120f, activity.window.attributes.preferredRefreshRate)

        // An unfold: the display now has other modes, and the request follows it.
        ShadowDisplayManager.setSupportedModes(display, mode(4, w, h, 60f), mode(5, w, h, 144f))
        assertEquals(144f, activity.window.attributes.preferredRefreshRate)

        // A configuration change asks again, as Telegram's onConfigurationChanged does.
        activity.window.attributes = activity.window.attributes.apply { preferredRefreshRate = 0f }
        // (Delivered to the activity, as MainActivity handles its own: Robolectric would recreate this one.)
        activity.onConfigurationChanged(Configuration(activity.resources.configuration).apply { orientation = Configuration.ORIENTATION_LANDSCAPE })
        assertEquals(144f, activity.window.attributes.preferredRefreshRate)
    }
}
