package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import android.media.MediaDataSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** A recording's tap spins its play glyph until its first range is here, then plays (iOS 42121e99e `VideoOpening`). */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class VideoOpeningTest {
    @get:Rule val rule = createComposeRule()

    private val ref = MediaRef("tc1", 0, MediaItem(kind = "video", name = "clip.mp4", mimeType = "video/mp4", size = 1000.0))
    private val source = object : MediaDataSource() {
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int) = -1
        override fun getSize() = 1000L
        override fun close() = Unit
    }

    @Test fun `it spins until the first range is here, then plays once`() {
        val scope = TestScope(StandardTestDispatcher())
        val gate = CompletableDeferred<Unit>()
        val opening = VideoOpening(scope, { source }, { gate.await() })
        var played = 0
        opening.open("k", ref) { played++ }
        scope.advanceUntilIdle()
        assertTrue(opening.isStarting("k"))
        assertEquals(0, played)
        gate.complete(Unit)
        scope.advanceUntilIdle()
        assertNull(opening.starting)
        assertEquals(1, played)
    }

    @Test fun `a second tap while it spins gives up, and another recording takes over`() {
        val scope = TestScope(StandardTestDispatcher())
        val gate = CompletableDeferred<Unit>()
        val opening = VideoOpening(scope, { source }, { gate.await() })
        val played = ArrayList<String>()
        opening.open("k", ref) { played += "k" }
        scope.advanceUntilIdle()
        opening.open("k", ref) { played += "k" }
        assertNull(opening.starting)
        opening.open("a", ref) { played += "a" }
        opening.open("b", ref) { played += "b" }
        assertTrue(opening.isStarting("b"))
        assertFalse(opening.isStarting("a"))
        gate.complete(Unit)
        scope.advanceUntilIdle()
        assertEquals(listOf("b"), played)
    }

    @Test fun `with nothing to read in ranges it plays at once`() {
        val scope = TestScope(StandardTestDispatcher())
        val opening = VideoOpening(scope, { null }, { error("not read") })
        var played = false
        opening.open("k", ref) { played = true }
        assertTrue(played)
        assertNull(opening.starting)
    }

    @Test fun `the ring is a small spinner while it starts`() {
        assertEquals(MediaRingState.Starting, MediaRingState.of(DownloadPhase.Remote(1000), video = true, starting = true))
        assertEquals(MediaRingState.Play, MediaRingState.of(DownloadPhase.Remote(1000), video = true))
        // Only a recording starts.
        assertEquals(MediaRingState.Download, MediaRingState.of(DownloadPhase.Remote(1000), video = false, starting = true))
        rule.setHappyContent {
            Box(Modifier.size(200.dp)) { MediaStatus("k", DownloadPhase.Remote(1000), video = true, duration = "0:05", starting = true) {} }
        }
        rule.waitForIdle()
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "video-starting.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
