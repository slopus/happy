package com.slopus.happy.attachments

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachmentStagingTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val dir = File(context.cacheDir, "staging-test").apply { deleteRecursively(); mkdirs() }
    private val png = ByteArrayOutputStream().also { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    private val bytes = mapOf(
        "content://p/photo" to png,
        "content://p/clip" to ByteArray(300) { it.toByte() },
        "content://p/doc" to "hello".toByteArray(),
        "content://p/fake-photo" to "not a picture".toByteArray(),
    )
    private val staging = AttachmentStaging(dir) { pick -> ByteArrayInputStream(bytes[pick.uri] ?: throw IOException("gone")) }

    @Test fun `photos are normalized, videos and files copied as they are, in order`() {
        val staged = staging.stage(
            listOf(
                PickedMedia("content://p/clip", PickedKind.Video, "clip.mp4", "video/mp4", 300),
                PickedMedia("content://p/photo", PickedKind.Photo, "photo.png", "image/png", png.size.toLong()),
                PickedMedia("content://p/doc", PickedKind.File, "a:b.txt", "text/plain", 5),
            ),
            AttachAccepts.Agent,
        )
        assertTrue(staged.problems.isEmpty())
        assertEquals(listOf("video/mp4", "image/jpeg", "text/plain"), staged.attachments.map { it.mimeType })
        assertEquals(listOf(300L, null, 5L), staged.attachments.map { if (it.mimeType == "image/jpeg") null else it.size })
        assertEquals(40, staged.attachments[1].width)
        val doc = File(Uri.parse(staged.attachments[2].uri).path!!)
        assertEquals("hello", doc.readText())
        assertEquals("a_b.txt", doc.name)
        assertEquals("a:b.txt", staged.attachments[2].name)
    }

    @Test fun `too large and unreadable picks are left out and said`() {
        val small = AttachAccepts.Agent.copy(maxFileBytes = 100)
        val staged = staging.stage(
            listOf(
                PickedMedia("content://p/clip", PickedKind.Video, "clip.mp4", "video/mp4", 0),
                PickedMedia("content://p/doc", PickedKind.File, "big.bin", "application/octet-stream", 5_000),
                PickedMedia("content://p/missing", PickedKind.File, "gone.txt", "text/plain", 1),
                PickedMedia("content://p/doc", PickedKind.File, "ok.txt", "text/plain", 5),
            ),
            small,
        )
        assertEquals(listOf("ok.txt"), staged.attachments.map { it.name })
        assertEquals(
            listOf(StagingProblem.TooLarge("clip.mp4", 0), StagingProblem.TooLarge("big.bin", 0), StagingProblem.Unreadable("gone.txt")),
            staged.problems,
        )
        // The cut-off copy left nothing behind.
        assertEquals(1, dir.walkTopDown().count { it.isFile })
    }

    @Test fun `a photo Android can't decode goes as the file it is`() {
        val staged = staging.stage(listOf(PickedMedia("content://p/fake-photo", PickedKind.Photo, "x.heic", "image/heic", 13)), AttachAccepts.Agent)
        assertEquals("image/heic", staged.attachments.single().mimeType)
        assertEquals(13, staged.attachments.single().size)
    }
}
