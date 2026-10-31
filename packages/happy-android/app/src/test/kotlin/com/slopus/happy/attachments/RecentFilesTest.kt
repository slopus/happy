package com.slopus.happy.attachments

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RecentFilesTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private var clock = 1_000L
    private val recent = RecentFiles(context) { clock }

    private fun file(name: String) = PickedMedia("file:///sdcard/$name", PickedKind.File, name, "application/pdf", 10)

    @Test fun `files sent from here are listed newest first, once each, at most 30`() {
        recent.clear()
        recent.remember(listOf(file("a.pdf"), file("b.pdf")))
        clock = 2_000
        recent.remember(listOf(file("a.pdf")))
        assertEquals(listOf("a.pdf", "b.pdf"), recent.list().map { it.name })
        assertEquals(2_000L, recent.list().first().sentAt)
        recent.remember((1..40).map { file("$it.pdf") })
        assertEquals(RecentFiles.MAX, recent.list().size)
        assertEquals("1.pdf", recent.list().first().name)
    }

    @Test fun `a file whose read grant is gone drops out, and clearing forgets all`() {
        recent.clear()
        recent.remember(listOf(PickedMedia("content://docs/gone", PickedKind.File, "gone.pdf", "application/pdf", 1), file("kept.pdf")))
        assertEquals(listOf("gone.pdf", "kept.pdf"), recent.list().map { it.name })
        context.contentResolver.releasePersistableUriPermission(android.net.Uri.parse("content://docs/gone"), android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        assertEquals(listOf("kept.pdf"), recent.list().map { it.name })
        recent.clear()
        assertTrue(recent.list().isEmpty())
    }
}
