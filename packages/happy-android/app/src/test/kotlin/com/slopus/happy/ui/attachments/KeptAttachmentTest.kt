package com.slopus.happy.ui.attachments

import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.media.DownloadBoard
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.media.NotKept
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.conversation.MediaStatusSpec
import com.slopus.happy.ui.conversation.UploadRingSpec
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * A Happy CLI chat's picture kept on the phone (iOS ba7b68346): one the
 * automatic rules don't take shows the arrow and its size, not the failure
 * mark; a tap reads it, the ring counting, and once here it shows.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class KeptAttachmentTest {
    @get:Rule val rule = createComposeRule()

    private val png = ByteArrayOutputStream().also {
        Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }.compress(Bitmap.CompressFormat.PNG, 100, it)
    }.toByteArray()

    private inner class Kept : SessionAttachments {
        val board = DownloadBoard()
        var requested = false
        val gate = CompletableDeferred<Unit>()
        override fun cached(ref: String): ByteArray? = null
        override suspend fun load(ref: String, size: Long?): ByteArray? {
            if (!requested) {
                board.set(ref, DownloadPhase.Remote(size))
                throw NotKept()
            }
            board.set(ref, DownloadPhase.Downloading(size!! / 3, size))
            gate.await()
            board.set(ref, DownloadPhase.Complete(size))
            return png
        }
        override fun phase(ref: String) = board.phase(ref)
        override fun request(ref: String) {
            requested = true
        }
    }

    private fun shot(name: String) {
        File("build/chat-screens").mkdirs()
        File("build/chat-screens/$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun aPictureTheRulesLeaveWaitsForATapThenIsKept() {
        val kept = Kept()
        val input = Json.parseToJsonElement("""{"ref":"sessions/s/attachments/a.enc","name":"photo.png","size":3250000,"image":{"width":640,"height":480}}""")
        rule.setHappyContent {
            androidx.compose.runtime.CompositionLocalProvider(LocalSessionAttachments provides kept) { FileMessageView(input) }
        }
        rule.waitForIdle()
        rule.onNodeWithTag(MediaStatusSpec.BADGE, useUnmergedTree = true).assertExists()
        assertEquals("waiting is no failure", 0, rule.onAllNodesWithTag(FileMessageTags.ERROR).fetchSemanticsNodes().size)
        shot("legacy-download-arrow")

        rule.onAllNodesWithContentDescription("Download", useUnmergedTree = true)[0].performClick()
        rule.waitForIdle()
        assertEquals(1, rule.onAllNodesWithTag(UploadRingSpec.TAG, useUnmergedTree = true).fetchSemanticsNodes().size)
        shot("legacy-download-progress")
        kept.gate.complete(Unit)
        rule.mainClock.advanceTimeBy(2_000)
        rule.waitForIdle()
        assertEquals("filled and gone", 0, rule.onAllNodesWithTag(UploadRingSpec.TAG, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithTag(MediaStatusSpec.BADGE, useUnmergedTree = true).fetchSemanticsNodes().size)
    }
}
