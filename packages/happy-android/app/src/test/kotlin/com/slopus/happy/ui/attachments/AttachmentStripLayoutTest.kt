package com.slopus.happy.ui.attachments

import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.MAX_NORMALIZED_FILE_SIZE
import com.slopus.happy.attachments.NormalizedImage
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException

/**
 * AgentInputAttachmentStrip.tsx's layout, AgentInput's add button, and
 * useImagePicker.ts's limits and alerts.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class AttachmentStripLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun preview(id: String) = AttachmentPreview(id, "file:///missing/$id.jpg", 10, 10, "image/jpeg", 100, "$id.jpg")

    @Test
    fun thumbnailsAndTheirRemoveButtons() {
        val images = mutableStateListOf(preview("a"), preview("b"))
        rule.setHappyContent { AttachmentStrip(images, onRemove = { id -> images.removeAll { it.id == id } }) }

        val strip = rule.node(AttachmentStripTags.STRIP).getUnclippedBoundsInRoot()
        val thumbs = rule.onAllNodesWithTag(AttachmentStripTags.THUMB, useUnmergedTree = true).fetchSemanticsNodes().map { it.boundsInRoot }
        val density = rule.density
        val first = with(density) { thumbs[0].let { androidx.compose.ui.unit.DpRect(it.left.toDp(), it.top.toDp(), it.right.toDp(), it.bottom.toDp()) } }
        val second = with(density) { thumbs[1].let { androidx.compose.ui.unit.DpRect(it.left.toDp(), it.top.toDp(), it.right.toDp(), it.bottom.toDp()) } }
        // 8 margin + 4 padding in; 6 above for the remove buttons that stick out.
        assertBox("first", first, 12.dp, 6.dp, 64.dp, 64.dp)
        assertBox("second", second, 12.dp + 64.dp + 8.dp, 6.dp, 64.dp, 64.dp)
        // 6 below the thumbnails, then the 8 margin.
        assertEquals(6.dp + 64.dp + 6.dp + 8.dp, strip.bottom - strip.top)

        val remove = rule.onAllNodesWithTag(AttachmentStripTags.REMOVE, useUnmergedTree = true).onFirst()
        assertBox("remove", remove.getUnclippedBoundsInRoot(), 12.dp + 64.dp - 18.dp + 6.dp, 0.dp, 18.dp, 18.dp)
        remove.performClick()
        rule.waitForIdle()
        assertEquals(listOf("b"), images.map { it.id })
    }

    @Test
    fun noImagesNoStrip() {
        rule.setHappyContent { AttachmentStrip(emptyList(), onRemove = {}) }
        rule.node(AttachmentStripTags.STRIP).assertDoesNotExist()
    }

    @Test
    fun theAddButton() {
        var clicks = 0
        rule.setHappyContent { AddImageButton(attached = false, onClick = { clicks++ }) }
        val add = rule.node(AttachmentStripTags.ADD)
        assertEquals(32.dp, add.getUnclippedBoundsInRoot().let { it.bottom - it.top })
        // 8 + 16 + 8.
        assertEquals(32.dp, add.getUnclippedBoundsInRoot().let { it.right - it.left })
        add.performClick()
        assertEquals(1, clicks)
    }

    private val text = ImagePickerText(
        ok = "OK", cancel = "Cancel", limitTitle = "Image Limit Reached", limitMessage = "You can attach up to 20 images per message.",
        tooLargeTitle = "File Too Large", tooLargeMessage = { name, mb -> "\"$name\" exceeds the ${mb}MB limit and was not added." },
        uploadFailedTitle = "Upload Failed", uploadFailedOne = "One image could not be uploaded and was not sent.",
        nothingToPasteTitle = "Nothing to Paste", nothingToPasteMessage = "Copy an image first, then try again.",
        attachTitle = "Add Image", paste = "Paste from Clipboard", library = "Photo Library",
    )

    private fun state(size: (String?) -> Long = { 1000 }) = ImageAttachmentsState(
        normalize = { source ->
            if (source.name == "broken") throw IOException("Not an image")
            NormalizedImage(File.createTempFile("normalized", ".jpg"), 640, 480, size(source.name), "${source.name}.jpg")
        },
        text = text,
    )

    private fun source(name: String) = ImageSource(name) { error("not read") }

    @Test
    fun twentyAtMost() = runBlocking {
        val state = state()
        state.add((1..25).map { source("i$it") })
        assertEquals(20, state.images.size)
        assertEquals("i1.jpg", state.images.first().name)
        assertEquals(640, state.images.first().width)
        assertTrue(state.images.first().uri.startsWith("file:"))
        assertNull(state.alert)
        assertEquals(false, state.checkRoom())
        assertEquals("Image Limit Reached", state.alert!!.title)
        assertEquals("You can attach up to 20 images per message.", state.alert!!.message)
        state.remove(state.images.first().id)
        state.dismissAlert()
        assertEquals(true, state.checkRoom())
    }

    @Test
    fun tooLargeAndBrokenImagesAreLeftOut() = runBlocking {
        val state = state(size = { if (it == "huge") MAX_NORMALIZED_FILE_SIZE + 1L else MAX_NORMALIZED_FILE_SIZE.toLong() })
        state.add(listOf(source("huge")))
        assertTrue(state.images.isEmpty())
        assertEquals("File Too Large", state.alert!!.title)
        assertEquals("\"huge\" exceeds the 10MB limit and was not added.", state.alert!!.message)

        state.add(listOf(source("broken"), source("fits")))
        assertEquals(listOf("fits.jpg"), state.images.map { it.name })
        assertEquals("Upload Failed", state.alert!!.title)
    }

    @Test
    fun theChooserOffersPasteAndLibrary() {
        val state = state()
        var pasted = 0
        var picked = 0
        state.choose(onPaste = { pasted++ }, onPick = { picked++ })
        val alert = state.alert!!
        assertEquals("Add Image", alert.title)
        assertEquals(listOf("Paste from Clipboard", "Photo Library", "Cancel"), alert.buttons.map { it.text })
        alert.buttons[0].onClick()
        alert.buttons[1].onClick()
        assertEquals(1 to 1, pasted to picked)
        state.nothingToPaste()
        assertEquals("Nothing to Paste", state.alert!!.title)
    }
}
