package com.slopus.happy.ui.camera

import android.view.KeyEvent
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PhotoVolumeKeysTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun volumeReleaseUsesTheCurrentShutterAndLeavingRestoresTheWindowCallback() {
        val window = rule.activity.window
        val original = window.callback
        var delegated = 0
        val previous = object : Window.Callback by original {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean { delegated++; return true }
        }
        window.callback = previous
        var enabled by mutableStateOf(true)
        var ready by mutableStateOf(false)
        var shots = 0
        rule.setContent {
            val readyNow = ready
            PhotoVolumeKeys(window, enabled) { if (readyNow) shots++ }
        }
        rule.runOnIdle { window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_UP)); assertEquals(0, shots); ready = true }
        rule.waitForIdle()
        val callback = window.callback
        rule.runOnIdle {
            window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP))
            assertEquals(0, shots)
            window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_UP))
            assertEquals(1, shots)
            assertSame("readiness changes don't replace the installed delegate", callback, window.callback)
            window.callback.dispatchKeyEvent(KeyEvent.changeFlags(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_DOWN), KeyEvent.FLAG_CANCELED))
            assertEquals(1, shots)
            window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A))
            assertEquals(1, delegated)
            enabled = false
        }
        rule.waitForIdle()
        rule.runOnIdle { assertSame(previous, window.callback); window.callback = original }
    }
}