package com.slopus.happy.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.sync.SessionComposerTest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/**
 * useImagePicker.ts normalizePickedAssetForUpload (3072 long edge, JPEG
 * 0.92) and sync.ts sendMessage's attachment plan.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachmentComposeTest {
    private val dir: File get() = ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir

    private fun png(width: Int, height: Int): ByteArray = ByteArrayOutputStream().also {
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }.compress(Bitmap.CompressFormat.PNG, 100, it)
    }.toByteArray()

    @Test
    fun theLongEdgeStopsAt3072() {
        assertEquals(3072 to 2304, ImageNormalizer.targetSize(4032, 3024))
        assertEquals(2304 to 3072, ImageNormalizer.targetSize(3024, 4032))
        assertEquals(3072 to 3072, ImageNormalizer.targetSize(5000, 5000))
        assertEquals(1000 to 500, ImageNormalizer.targetSize(1000, 500))
        assertEquals(3072 to 1, ImageNormalizer.targetSize(8000, 2))
    }

    @Test
    fun namesBecomeJpeg() {
        assertEquals("IMG_1.jpg", ImageNormalizer.withJpegExtension("IMG_1.HEIC"))
        assertEquals("photo.jpg", ImageNormalizer.withJpegExtension(" photo.png "))
        assertEquals("archive.tar.jpg", ImageNormalizer.withJpegExtension("archive.tar.gz"))
        assertEquals(".hidden.jpg", ImageNormalizer.withJpegExtension(".hidden"))
        assertEquals("image_7.jpg", ImageNormalizer.withJpegExtension(null, now = 7))
        assertEquals("image_7.jpg", ImageNormalizer.withJpegExtension("  ", now = 7))
    }

    @Test
    fun aLargeImageIsScaledAndReEncoded() {
        val bytes = png(4000, 1000)
        val image = ImageNormalizer.normalize({ ByteArrayInputStream(bytes) }, "wide.png", dir)
        assertEquals(3072, image.width)
        assertEquals(768, image.height)
        assertEquals("wide.jpg", image.name)
        assertEquals("image/jpeg", image.mimeType)
        assertEquals(image.file.length(), image.size)
        val written = image.file.readBytes()
        assertTrue(written[0] == 0xFF.toByte() && written[1] == 0xD8.toByte())
        val decoded = BitmapFactory.decodeByteArray(written, 0, written.size)
        assertEquals(3072, decoded.width)
        assertEquals(768, decoded.height)
    }

    @Test
    fun aSmallImageKeepsItsSize() {
        val image = ImageNormalizer.normalize({ ByteArrayInputStream(png(300, 200)) }, null, dir, now = 5)
        assertEquals(300 to 200, image.width to image.height)
        assertEquals("image_5.jpg", image.name)
    }

    @Test
    fun notAnImageFails() {
        assertThrows(IOException::class.java) { ImageNormalizer.normalize({ ByteArrayInputStream(byteArrayOf(1, 2, 3)) }, "x", dir) }
    }

    private fun preview(id: String, mime: String = "image/jpeg", size: Long = 100) = AttachmentPreview(id, "file:///x/$id.jpg", 10, 10, mime, size, "$id.jpg")
    private fun metadata(json: String) = SessionMetadata.parse(json)!!
    /** happy-app's rig fixture with a tighter attachment policy: PNG up to 150 bytes. */
    private val rig = SessionComposerTest.RIG_METADATA_FIXTURE
        .replace(""""maxBytes": 10485760, "mediaTypes": ["image/*"]""", """"maxBytes": 150, "mediaTypes": ["image/png"]""")

    private suspend fun plan(metadata: SessionMetadata?, text: String, attachments: List<AttachmentPreview>, failed: Int = 0): Pair<AttachmentSendPlan, List<String>> {
        val uploaded = mutableListOf<String>()
        val plan = prepareAttachmentSend(metadata, text, attachments) { list ->
            uploaded += list.map { it.id }
            AttachmentUploadResult(list.drop(failed).map { UploadedAttachment("sessions/s/attachments/${it.id}.enc", it.name, it.size, it.width, it.height) }, failed)
        }
        return plan to uploaded
    }

    private fun refs(records: List<JsonObject>) = records.map {
        it["content"]!!.jsonObject["data"]!!.jsonObject["ev"]!!.jsonObject["ref"]!!.jsonPrimitive.content
    }

    @Test
    fun claudeSessionsUploadEverything() = runBlocking {
        val (plan, uploaded) = plan(metadata("""{"path":"/p","host":"h","flavor":"claude"}"""), "look", listOf(preview("a"), preview("b")))
        assertTrue(plan.send)
        assertEquals(listOf("a", "b"), uploaded)
        assertEquals(listOf("sessions/s/attachments/a.enc", "sessions/s/attachments/b.enc"), refs(plan.records))
        assertTrue(plan.notices.isEmpty())

        val none = prepareAttachmentSend(null, "hi", emptyList()) { error("no upload") }
        assertEquals(AttachmentSendPlan(true, emptyList(), emptyList()), none)
    }

    @Test
    fun unsupportedAgentsWarn() = runBlocking {
        val gemini = metadata("""{"path":"/p","host":"h","flavor":"gemini"}""")
        val (withText, uploaded) = plan(gemini, "describe this", listOf(preview("a")))
        assertEquals(AttachmentSendPlan(true, emptyList(), listOf(AttachmentNotice.NotSupported)), withText)
        assertTrue(uploaded.isEmpty())
        val (imageOnly, _) = plan(gemini, "  ", listOf(preview("a")))
        assertEquals(AttachmentSendPlan(false, emptyList(), listOf(AttachmentNotice.NotSupported)), imageOnly)
    }

    @Test
    fun theRigPolicyFilters() = runBlocking {
        val (plan, uploaded) = plan(metadata(rig), "", listOf(preview("ok", "image/png", 100), preview("big", "image/png", 200), preview("jpg", "image/jpeg", 10)))
        assertEquals(listOf("ok"), uploaded)
        assertTrue(plan.send)
        assertEquals(listOf(AttachmentNotice.NotSupported), plan.notices)

        val (nothing, none) = plan(metadata(rig), "", listOf(preview("jpg", "image/jpeg", 10)))
        assertFalse(nothing.send)
        assertTrue(none.isEmpty())
    }

    @Test
    fun failedUploadsAreCounted() = runBlocking {
        val (plan, _) = plan(null, "x", listOf(preview("a"), preview("b"), preview("c")), failed = 2)
        assertEquals(listOf(AttachmentNotice.UploadFailed(2)), plan.notices)
        assertEquals(1, plan.records.size)
    }
}
