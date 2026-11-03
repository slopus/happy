package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import coil3.test.FakeImage
import coil3.test.FakeImageLoaderEngine
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.UploadBoard
import com.slopus.happy.conversation.UploadPhase
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Telegram's ring over each picture of a message still going to the
 * computer (iOS 5ac4296c2): the tile dimmed, a dark disc with the share
 * written as an arc, a cross that takes that picture out; once the
 * computer has the message the rings fill and go. A message read back
 * from history never had one.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UploadRingTest {
    @get:Rule val rule = createComposeRule()

    private val green = 0xFF00C853.toInt()
    private val board = UploadBoard()
    private val removed = ArrayList<Pair<String, Int>>()

    private fun png(): String {
        val bytes = ByteArrayOutputStream().also {
            Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(green) }.compress(Bitmap.CompressFormat.PNG, 100, it)
        }.toByteArray()
        return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
    }

    private fun row(delivery: Delivery, text: String = "Look") = ConversationRow.User("u1:user", "u1", text, parseMarkdown(text), listOf(Block.Image("image/png", png()), Block.Image("image/png", png())), delivery)

    private var shown by mutableStateOf(row(Delivery.Sending))

    private fun show() {
        val loader = ImageLoader.Builder(ApplicationProvider.getApplicationContext())
            .components { add(FakeImageLoaderEngine.Builder().default(FakeImage(width = 400, height = 300, color = green)).build()) }
            .build()
        val actions = ConversationRowActions(
            legacy = MessageCallbacks(),
            onRetryFailure = {},
            loadMedia = { ByteArray(0) },
            uploads = board,
            onRemovePicture = { id, index -> removed += id to index },
        )
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                ProvideWindowLayout { Column { ConversationRowView(shown, userMessageBubblePalette(null, false), actions) } }
            }
        }
    }

    private fun rings() = rule.onAllNodesWithTag(UploadRingSpec.TAG, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun shot(name: String) {
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun eachSendingPictureWearsARingWhoseCrossTakesItOut() {
        board.set(UploadBoard.pictureKey("u1", 0), UploadPhase.Uploading(0.6f))
        board.set(UploadBoard.pictureKey("u1", 1), UploadPhase.Preparing)
        show()
        rule.mainClock.advanceTimeBy(1_000)
        assertEquals(2, rings())
        shot("upload-rings")
        rule.onAllNodesWithContentDescription("Remove picture", useUnmergedTree = true)[1].performClick()
        assertEquals(listOf("u1" to 1), removed)
    }

    @Test
    fun theRingsFillAndGoOnceTheComputerHasIt() {
        board.set(UploadBoard.pictureKey("u1", 0), UploadPhase.Uploading(0.6f))
        show()
        rule.mainClock.advanceTimeBy(500)
        assertEquals(2, rings())
        rule.mainClock.autoAdvance = false
        board.clear("u1")
        shown = row(Delivery.Pending)
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(200)
        assertEquals("still filling", 2, rings())
        rule.mainClock.advanceTimeBy(1_500)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals("gone", 0, rings())
        rule.onAllNodesWithContentDescription("Remove picture", useUnmergedTree = true).fetchSemanticsNodes().let { assertEquals(0, it.size) }
    }

    @Test
    fun picturesAloneComeBackCaptionedAndTheirRingsFillOnInTheBubble() {
        shown = row(Delivery.Sending, text = "")
        board.set(UploadBoard.pictureKey("u1", 0), UploadPhase.Uploading(0.6f))
        show()
        rule.mainClock.advanceTimeBy(500)
        assertEquals(2, rings())
        rule.mainClock.autoAdvance = false
        board.set(UploadBoard.pictureKey("u1", 0), UploadPhase.Done)
        board.set(UploadBoard.pictureKey("u1", 1), UploadPhase.Done)
        shown = row(Delivery.Pending, text = "Attached images.")
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(200)
        assertEquals("still filling in the bubble", 2, rings())
        rule.mainClock.advanceTimeBy(1_500)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals("gone", 0, rings())
    }

    @Test
    fun aMessageFromHistoryHasNoRing() {
        shown = row(Delivery.Sent)
        show()
        rule.waitForIdle()
        assertEquals(0, rings())
    }
}
