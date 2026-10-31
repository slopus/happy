package com.slopus.happy.ui.attach

import com.slopus.happy.attachments.AttachAccepts
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.attachments.PickedKind
import com.slopus.happy.attachments.PickedMedia
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachSelectionTest {
    private fun item(n: Int) = PickedMedia("content://media/$n", PickedKind.Photo, "$n.jpg", "image/jpeg")

    @Test fun `picks are numbered in order, and unpicking renumbers the rest`() {
        val selection = AttachSelection(maxItems = 10)
        selection.toggle(item(1))
        selection.toggle(item(2))
        selection.toggle(item(3))
        assertEquals(listOf(1, 2, 3), (1..3).map { selection.number("content://media/$it") })
        selection.toggle(item(1))
        assertEquals(0, selection.number("content://media/1"))
        assertEquals(1, selection.number("content://media/2"))
        assertEquals(2, selection.number("content://media/3"))
        assertEquals(listOf("2.jpg", "3.jpg"), selection.items.map { it.name })
    }

    @Test fun `no more than the room`() {
        val selection = AttachSelection(maxItems = 2)
        assertTrue(selection.toggle(item(1)))
        assertTrue(selection.toggle(item(2)))
        assertFalse(selection.toggle(item(3)))
        assertEquals(2, selection.count)
        // Unpicking still works when full.
        assertTrue(selection.toggle(item(1)))
        assertTrue(selection.pick(item(3)))
        assertTrue(selection.pick(item(3)))
        assertEquals(2, selection.count)
    }

    @Test fun `what each chat takes`() {
        assertEquals(listOf(AttachTabKind.Gallery, AttachTabKind.Files), AttachAccepts.Agent.tabs)
        assertTrue(AttachAccepts.Agent.videos && AttachAccepts.Agent.files)
        assertEquals(50L * 1024 * 1024, AttachAccepts.Agent.maxFileBytes)
        // A relay CLI reads pictures alone: the File tab holds the system picker and paste.
        assertEquals(listOf(AttachTabKind.Gallery, AttachTabKind.Files), AttachAccepts.RelayPictures.tabs)
        assertFalse(AttachAccepts.RelayPictures.videos || AttachAccepts.RelayPictures.files)
        assertEquals(AttachAccepts.RelayPictures, AttachAccepts.relay(null, canUseAttachments = true))
        assertEquals(AttachAccepts.None, AttachAccepts.relay(null, canUseAttachments = false))
        assertTrue(AttachAccepts.None.tabs.isEmpty())
    }

    @Test fun `a file's type and size against what a chat takes`() {
        val accepts = AttachAccepts(photos = true, videos = false, files = true, maxFileBytes = 100, fileTypes = listOf("image/*", "application/pdf"))
        assertTrue(accepts.allowsType("image/heic"))
        assertTrue(accepts.allowsType("application/pdf"))
        assertFalse(accepts.allowsType("application/zip"))
        assertTrue(AttachAccepts.Agent.allowsType("application/zip"))
        assertTrue(accepts.fits(100))
        assertFalse(accepts.fits(101))
        assertTrue("unknown sizes are checked once copied", accepts.fits(0))
    }
}
