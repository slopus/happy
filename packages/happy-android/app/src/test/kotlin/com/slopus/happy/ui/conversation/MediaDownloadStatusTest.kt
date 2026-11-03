package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import coil3.test.FakeImage
import coil3.test.FakeImageLoaderEngine
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.KeptMedia
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.media.MediaLibrary
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Telegram's download ring and size badge on a kept tile (iOS
 * ba7b68346): a picture the automatic rules don't take shows the arrow
 * and its size; a tap reads it into the phone, and once it is here the
 * picture shows and the ring goes. A recording's ring is its play button,
 * its size beside its length.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MediaDownloadStatusTest {
    @get:Rule val rule = createComposeRule()
    @get:Rule val folder = TemporaryFolder()

    private val green = 0xFF00C853.toInt()
    private val png = ByteArrayOutputStream().also {
        Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(green) }.compress(Bitmap.CompressFormat.PNG, 100, it)
    }.toByteArray()
    private val library by lazy { MediaLibrary(File(folder.root, "media")) }
    private val rules = MutableStateFlow(MediaAutoDownload(photos = MediaAutoDownload.Rule(false, MediaAutoDownload.MEGABYTE)))
    private val kept by lazy {
        KeptMedia(
            library = library,
            agentId = "a1",
            range = { _, span ->
                val end = minOf(span.end, png.size.toLong()).toInt()
                TransportResponse(206, mapOf("Content-Range" to "bytes ${span.start}-${end - 1}/${png.size}"), png.copyOfRange(span.start.toInt(), end))
            },
            rules = rules,
            scope = CoroutineScope(Dispatchers.Unconfined),
        )
    }

    private fun show(ref: MediaRef) {
        val loader = ImageLoader.Builder(ApplicationProvider.getApplicationContext())
            .components { add(FakeImageLoaderEngine.Builder().default(FakeImage(width = 400, height = 300, color = green)).build()) }
            .build()
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                ProvideWindowLayout {
                    Column {
                        ConversationRowView(
                            ConversationRow.Media("m:0", listOf(ref)),
                            userMessageBubblePalette(null, false),
                            ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, loadMedia = { kept.picture(it) }, kept = kept),
                        )
                    }
                }
            }
        }
    }

    private fun shot(name: String) {
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun rings() = rule.onAllNodesWithTag(UploadRingSpec.TAG, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test
    fun aPictureNotTakenByTheRulesWaitsForATapThenIsKept() {
        val ref = MediaRef("tc1", 0, MediaItem("image", "shot.png", "image/png", width = 400.0, height = 300.0, size = png.size.toDouble()))
        show(ref)
        rule.waitUntil(5_000) { kept.phase(ref) is DownloadPhase.Remote }
        rule.waitForIdle()
        assertEquals(1, rings())
        rule.onNodeWithTag(MediaStatusSpec.BADGE, useUnmergedTree = true).assertExists()
        shot("download-ring-arrow")

        rule.onAllNodesWithContentDescription("Download", useUnmergedTree = true)[0].performClick()
        rule.waitUntil(5_000) { kept.phase(ref) is DownloadPhase.Complete }
        rule.mainClock.advanceTimeBy(2_000)
        rule.waitForIdle()
        assertEquals("filled and gone", 0, rings())
        rule.onAllNodesWithTag(MediaStatusSpec.BADGE, useUnmergedTree = true).fetchSemanticsNodes().let { assertEquals("a kept picture says no size", 0, it.size) }
        assertTrue(library.store.isComplete(kept.id(ref)))
        shot("download-ring-kept")
    }

    @Test
    fun aRecordingsRingIsItsPlayButtonWithItsSizeInTheBadge() {
        val ref = MediaRef("tc2", 0, MediaItem("video", "clip.mp4", "video/mp4", width = 640.0, height = 360.0, size = 8.4 * 1024 * 1024))
        show(ref)
        rule.waitUntil(5_000) { kept.phase(ref) != null }
        rule.waitForIdle()
        assertEquals(1, rings())
        rule.onAllNodesWithContentDescription("Video", useUnmergedTree = true).fetchSemanticsNodes().let { assertTrue(it.isNotEmpty()) }
        shot("download-ring-video")
    }
}
