package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The viewer opens out of the thumbnail it was tapped on and closes back
 * into it (Telegram's PhotoViewer): the picture starts on the tile, filling
 * it as the tile crops it, grows to its place as the black comes, and the
 * tile is hidden meanwhile so the picture isn't there twice. Its frames go
 * under build/conversation-screens.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PictureViewerFlightTest {
    @get:Rule val rule = createComposeRule()

    private val key = "conversation/flight:0"
    private val bytes = ByteArrayOutputStream().also {
        Bitmap.createBitmap(1200, 900, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.BLUE) }.compress(Bitmap.CompressFormat.PNG, 100, it)
    }.toByteArray()
    private var open by mutableStateOf(false)

    @After fun tearDown() {
        ViewerOrigins.Shared.hidden = null
    }

    private fun show() {
        val source = object : ViewerSource {
            override fun cached(key: String) = bytes
            override suspend fun bytes(key: String) = bytes
        }
        rule.setHappyContent {
            Box(Modifier.fillMaxSize()) {
                MediaTile(
                    bytes = bytes,
                    cacheKey = key,
                    contentDescription = "tile",
                    failed = false,
                    onClick = { open = true },
                    modifier = Modifier.offset(40.dp, 420.dp).size(160.dp, 120.dp),
                )
                if (open) PictureViewer(listOf(ViewerItem(key, "flying", width = 1200f, height = 900f)), 0, source) { open = false }
            }
        }
        rule.waitForIdle()
    }

    private fun picture(): DpRect = rule.node(PictureViewerTags.IMAGE).getBoundsInRoot()

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        val bitmap = rule.onNode(isDialog()).captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun near(message: String, expected: Float, actual: Float, tolerance: Float = 3f) =
        assertTrue("$message: expected $expected, was $actual", kotlin.math.abs(expected - actual) <= tolerance)

    @Test fun `it opens out of its thumbnail and closes back into it`() {
        show()
        val tile = rule.node(ConversationMediaTags.TILE).getBoundsInRoot()
        assertTrue("the tile says where it is", ViewerOrigins.Shared[key] != null)
        rule.mainClock.autoAdvance = false
        rule.node(ConversationMediaTags.TILE).performTouchInput { click(center) }
        rule.waitForIdle()
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        assertTrue("open", open)
        assertEquals("the thumbnail is hidden under it", key, ViewerOrigins.Shared.hidden)
        val early = picture()
        shot("viewer-flight-early")
        rule.mainClock.advanceTimeBy(600)
        val rest = picture()
        shot("viewer-flight-rest")
        assertTrue("on its way it is smaller than at rest: ${early.width} < ${rest.width}", early.width < rest.width)
        val tileMiddle = (tile.top.value + tile.bottom.value) / 2
        val earlyMiddle = (early.top.value + early.bottom.value) / 2
        val restMiddle = (rest.top.value + rest.bottom.value) / 2
        assertTrue("it starts nearer the tile than its place: $earlyMiddle", kotlin.math.abs(earlyMiddle - tileMiddle) < kotlin.math.abs(earlyMiddle - restMiddle))
        near("at rest, the screen's width", PHONE_WIDTH_DP, rest.width.value)

        rule.node(PictureViewerTags.CLOSE).performTouchInput { click(center) }
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(150)
        val late = picture()
        shot("viewer-flight-closing")
        assertTrue("on its way back it shrinks: ${late.width} < ${rest.width}", late.width < rest.width)
        assertEquals("still hidden while it lands", key, ViewerOrigins.Shared.hidden)
        rule.mainClock.advanceTimeBy(600)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertTrue("closed", !open)
        assertNull("the thumbnail is back", ViewerOrigins.Shared.hidden)
    }

    @Test fun `a recording has no flight, it fades and its tile stays`() {
        val source = object : ViewerSource {
            override suspend fun bytes(key: String): ByteArray? = null
        }
        rule.setHappyContent {
            Box(Modifier.fillMaxSize()) {
                MediaTile(bytes = null, cacheKey = key, contentDescription = "clip", failed = false, onClick = { open = true }, video = true, modifier = Modifier.offset(40.dp, 420.dp).size(160.dp, 90.dp))
                if (open) PictureViewer(listOf(ViewerItem(key, "clip", isVideo = true)), 0, source) { open = false }
            }
        }
        rule.waitForIdle()
        rule.node(ConversationMediaTags.TILE).performTouchInput { click(center) }
        rule.waitForIdle()
        assertNull(ViewerOrigins.Shared.hidden)
    }

    private companion object {
        const val PHONE_WIDTH_DP = com.slopus.happy.ui.PHONE_WIDTH.toFloat()
    }
}
