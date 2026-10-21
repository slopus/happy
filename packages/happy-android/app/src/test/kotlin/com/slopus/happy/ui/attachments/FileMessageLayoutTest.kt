package com.slopus.happy.ui.attachments

import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.ToolTags
import com.slopus.happy.ui.chat.MessageView
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicInteger

/**
 * Image attachments in the chat (FileView.tsx in ToolView's inline
 * container): size, the decrypted picture, the error badge, the name.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FileMessageLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val png: ByteArray = ByteArrayOutputStream().also {
        Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }.compress(Bitmap.CompressFormat.PNG, 100, it)
    }.toByteArray()

    private class FakeAttachments(val bytes: ByteArray?) : SessionAttachments {
        val loads = AtomicInteger()
        override fun cached(ref: String): ByteArray? = null
        override suspend fun load(ref: String): ByteArray? {
            loads.incrementAndGet()
            return bytes
        }
    }

    private fun input(json: String): JsonElement = Json.parseToJsonElement(json)

    private fun show(input: JsonElement, attachments: SessionAttachments?) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalSessionAttachments provides attachments) { FileMessageView(input) }
        }
    }

    @Test
    fun displaySizeFollowsFileView() {
        fun size(w: Double, h: Double) = fileImageDisplaySize(FileToolInput.Image(w, h, null))
        assertEquals(280.dp to 210.dp, size(4032.0, 3024.0))
        assertEquals(200.dp to 100.dp, size(200.0, 100.0))
        // Tall: the height stops at 360 and the width follows the aspect.
        assertEquals(108.dp to 360.dp, size(300.0, 1000.0))
        // No dimensions: 4:3 at the full width.
        assertEquals(280.dp to 210.dp, fileImageDisplaySize(null))
        assertEquals(280.dp to 210.dp, size(0.0, 0.0))
    }

    @Test
    fun inputFollowsTheSchema() {
        assertEquals(
            FileToolInput("r", "a.jpg", 12.0, FileToolInput.Image(640.0, 480.0, "th")),
            FileToolInput.parse(input("""{"ref":"r","name":"a.jpg","size":12,"image":{"width":640,"height":480,"thumbhash":"th"}}""")),
        )
        assertEquals(FileToolInput("r", "a.jpg", null, null), FileToolInput.parse(input("""{"ref":"r","name":"a.jpg"}""")))
        listOf(
            """{"name":"a.jpg"}""",
            """{"ref":"r"}""",
            """{"ref":"r","name":"a","size":"12"}""",
            """{"ref":"r","name":"a","image":{"width":1}}""",
            """{"ref":"r","name":"a","image":{"width":1,"height":1,"thumbhash":5}}""",
            "[]",
        ).forEach { assertNull(it, FileToolInput.parse(input(it))) }
    }

    @Test
    fun theDecryptedPictureShowsAtItsSize() {
        val attachments = FakeAttachments(png)
        show(input("""{"ref":"sessions/s1/attachments/a.enc","name":"photo.jpg","size":12,"image":{"width":4032,"height":3024}}"""), attachments)
        rule.waitUntilAtLeastOneExists(hasContentDescription("photo.jpg"), 5_000)

        val row = rule.node(FileMessageTags.ROW).getUnclippedBoundsInRoot()
        val image = rule.node(FileMessageTags.IMAGE).getUnclippedBoundsInRoot()
        // 8 row margin + 12 padding in, 1 + 8 down.
        assertBox("image", image, 20.dp, 9.dp, 280.dp, 210.dp)
        val name = rule.node(FileMessageTags.NAME).getUnclippedBoundsInRoot()
        assertEquals(image.bottom + 4.dp, name.top)
        assertEquals(20.dp, name.left)
        assertEquals(0.dp, row.top)
        assertEquals(name.bottom + 9.dp, row.bottom)
        rule.node(FileMessageTags.NAME).assertTextEquals("photo.jpg")
        rule.node(FileMessageTags.ERROR).assertDoesNotExist()
        assertEquals(1, attachments.loads.get())
    }

    @Test
    fun aFailedLoadShowsTheBadge() {
        show(input("""{"ref":"r","name":"photo.jpg"}"""), FakeAttachments(null))
        rule.waitUntilAtLeastOneExists(hasTestTag(FileMessageTags.ERROR), 5_000)
        val image = rule.node(FileMessageTags.IMAGE).getUnclippedBoundsInRoot()
        val badge = rule.node(FileMessageTags.ERROR).getUnclippedBoundsInRoot()
        assertBox("badge", badge, image.right - 4.dp - 24.dp, image.top + 4.dp, 24.dp, 24.dp)
    }

    @Test
    fun undecodableBytesShowTheBadge() {
        show(input("""{"ref":"r2","name":"photo.jpg"}"""), FakeAttachments(byteArrayOf(1, 2, 3)))
        rule.waitUntilAtLeastOneExists(hasTestTag(FileMessageTags.ERROR), 5_000)
    }

    @Test
    fun fileToolRowsAreAttachmentsNotToolRows() {
        val tool = ToolCall(
            name = "file",
            state = ToolState.Completed,
            input = input("""{"ref":"r","name":"photo.jpg"}"""),
            createdAt = 0,
            description = "Attached file: photo.jpg",
        )
        rule.setHappyContent {
            CompositionLocalProvider(LocalSessionAttachments provides FakeAttachments(png)) {
                MessageView(ChatRow.Tool(ChatMessage.ToolCallMessage("t", 0, tool)), userMessageBubblePalette("gray", dark = false), MessageCallbacks())
            }
        }
        rule.node(FileMessageTags.ROW).assertExists()
        rule.node(ToolTags.INLINE).assertDoesNotExist()
        rule.node(ToolTags.COMPACT).assertDoesNotExist()
    }
}
