package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Overlays: what is up says so, and clear() puts every one away and returns once they have gone. */
@RunWith(AndroidJUnit4::class)
class OverlaysTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun nothingUpClearsAtOnce() = runTest {
        val overlays = Overlays()
        assertTrue(overlays.isEmpty)
        overlays.clear()
        assertTrue(overlays.isEmpty)
    }

    @Test
    fun aMenuADialogAndAnAlertAreEachPutAway() {
        val overlays = Overlays()
        var menu by mutableStateOf(true)
        var dialog by mutableStateOf(true)
        var alert by mutableStateOf(true)
        val dismissed = mutableListOf<String>()
        lateinit var scope: CoroutineScope
        rule.setContent {
            scope = rememberCoroutineScope()
            CompositionLocalProvider(LocalOverlays provides overlays) {
                Box {
                    HappyDropdownMenu(menu, { menu = false; dismissed += "menu" }) { Text("item") }
                    if (dialog) PageDialog({ dialog = false; dismissed += "dialog" }) { Text("dialog") }
                    if (alert) HappyAlert(Alert("Title", buttons = listOf(AlertButton("OK") {}))) { alert = false; dismissed += "alert" }
                }
            }
        }
        rule.waitForIdle()
        assertFalse(overlays.isEmpty)
        var cleared = false
        rule.runOnIdle { scope.launch { overlays.clear(); cleared = true } }
        rule.waitUntil(3_000) { cleared }
        assertEquals(setOf("menu", "dialog", "alert"), dismissed.toSet())
        assertTrue(overlays.isEmpty)
        rule.onNodeWithText("item").assertDoesNotExist()
        rule.onNodeWithText("dialog").assertDoesNotExist()
    }

    @Test
    fun anOverlayClosedByItselfLeavesTheList() {
        val overlays = Overlays()
        var open by mutableStateOf(true)
        rule.setContent {
            CompositionLocalProvider(LocalOverlays provides overlays) {
                TrackOverlay(open) { open = false }
            }
        }
        rule.waitForIdle()
        assertFalse(overlays.isEmpty)
        open = false
        rule.waitForIdle()
        assertTrue(overlays.isEmpty)
    }
}
