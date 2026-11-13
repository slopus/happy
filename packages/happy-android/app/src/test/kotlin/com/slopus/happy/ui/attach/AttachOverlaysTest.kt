package com.slopus.happy.ui.attach

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachAccepts
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.LocalOverlays
import com.slopus.happy.ui.components.Overlays
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A link clears both the sheet and its full camera, rather than waiting forever on the sheet. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachOverlaysTest {
    @get:Rule val rule = createComposeRule()

    @Test fun clearingTheAttachmentFlowReturnsAfterBothSheetAndCameraHaveGone() {
        val overlays = Overlays()
        var open by mutableStateOf(true)
        lateinit var scope: CoroutineScope
        var photos = 0
        rule.setHappyContent {
            scope = rememberCoroutineScope()
            CompositionLocalProvider(LocalOverlays provides overlays) {
                AttachSheet(open, AttachAccepts(photos = true, videos = false, files = false, maxFileBytes = 10_000_000), "", {}, {}, {},
                    onClosed = { open = false }, onPhoto = { photos++ })
            }
        }
        rule.waitForIdle()
        assertFalse(overlays.isEmpty)
        var returned = false
        rule.runOnIdle { scope.launch { overlays.clear(); returned = true } }
        rule.waitUntil(5000) { returned }
        assertFalse(open)
        assertTrue(overlays.isEmpty)

        rule.runOnIdle { open = true; returned = false }
        rule.onNodeWithText("Open Camera").performClick()
        rule.waitForIdle()
        assertFalse(overlays.isEmpty)
        rule.runOnIdle { scope.launch { overlays.clear(); returned = true } }
        rule.waitUntil(5000) { returned }
        assertFalse(open)
        assertTrue(overlays.isEmpty)
        assertEquals("clearing never adds a photo", 0, photos)
        rule.onNodeWithText("Open Camera").assertDoesNotExist()
    }
}