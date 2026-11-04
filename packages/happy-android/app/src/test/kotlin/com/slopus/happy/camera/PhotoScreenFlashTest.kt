package com.slopus.happy.camera

import androidx.activity.ComponentActivity
import androidx.camera.core.ImageCapture
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PhotoScreenFlashTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun aRenderedFlashCompletesOnceThenRestoresTheOriginalWindowBrightness() {
        rule.mainClock.autoAdvance = false
        val window = rule.activity.window
        window.attributes = window.attributes.apply { screenBrightness = 0.37f }
        lateinit var flash: PhotoScreenFlash
        var completed = 0
        rule.setContent { val scope = rememberCoroutineScope(); flash = remember { PhotoScreenFlash(window, scope) } }
        rule.runOnIdle { flash.apply(System.currentTimeMillis() + 3000, ImageCapture.ScreenFlashListener { completed++ }) }
        assertEquals(1f, window.attributes.screenBrightness)
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(150)
        rule.runOnIdle { assertEquals(1, completed); flash.clear() }
        rule.mainClock.advanceTimeBy(850)
        rule.runOnIdle {
            assertEquals(0f, flash.alpha)
            assertEquals(0.37f, window.attributes.screenBrightness)
            flash.reset()
            assertEquals(1, completed)
        }
    }

    @Test fun closingBeforeTheFirstFrameRestoresBrightnessAndCannotRelightLater() {
        rule.mainClock.autoAdvance = false
        val window = rule.activity.window
        window.attributes = window.attributes.apply { screenBrightness = -1f }
        lateinit var flash: PhotoScreenFlash
        var completed = 0
        rule.setContent { val scope = rememberCoroutineScope(); flash = remember { PhotoScreenFlash(window, scope) } }
        rule.runOnIdle {
            flash.apply(System.currentTimeMillis() + 3000, ImageCapture.ScreenFlashListener { completed++ })
            flash.reset()
            assertEquals(1, completed)
            assertEquals(-1f, window.attributes.screenBrightness)
            assertEquals(0f, flash.alpha)
        }
        rule.mainClock.advanceTimeBy(2000)
        rule.runOnIdle {
            flash.clear(); flash.reset()
            assertEquals(1, completed)
            assertEquals(0f, flash.alpha)
            assertEquals(-1f, window.attributes.screenBrightness)
        }
    }
}