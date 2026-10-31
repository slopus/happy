package com.slopus.happy.conversation

import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.safeAttachmentName
import org.junit.Assert.assertEquals
import org.junit.Test

class WorkspaceUploadsTest {
    private val mib = 1024L * 1024
    private fun preview(name: String, type: String, size: Long) = AttachmentPreview(name, "file:///cache/$name", 0, 0, type, size, name)

    @Test fun `readable pictures go inline, everything else into the workspace, in order`() {
        val (inline, files) = WorkspaceUploads.split(
            "m1",
            listOf(
                preview("a.jpg", "image/jpeg", mib),
                preview("clip.mp4", "video/mp4", 20 * mib),
                preview("b.heic", "image/heic", mib),
                preview("huge.png", "image/png", 6 * mib),
                preview("notes.pdf", "application/pdf", 10),
            ),
        )
        assertEquals(listOf("a.jpg"), inline.map { it.name })
        assertEquals(
            listOf(".happy-uploads/m1/1-clip.mp4", ".happy-uploads/m1/2-b.heic", ".happy-uploads/m1/3-huge.png", ".happy-uploads/m1/4-notes.pdf"),
            files.map { it.path },
        )
        assertEquals("/cache/clip.mp4", files[0].file.path)
    }

    @Test fun `inline pictures stop at 29 MB together`() {
        val (inline, files) = WorkspaceUploads.split("m", List(7) { preview("$it.jpg", "image/jpeg", 5 * mib) })
        assertEquals(5, inline.size)
        assertEquals(2, files.size)
    }

    @Test fun `the message names its files as iOS does`() {
        val one = listOf(OutgoingFile(java.io.File("x"), "x.pdf", "application/pdf", 1, ".happy-uploads/m/0-x.pdf"))
        assertEquals("Look\n\nAttached file:\n- ./.happy-uploads/m/0-x.pdf", WorkspaceUploads.text("Look", one))
        assertEquals("Attached file:\n- ./.happy-uploads/m/0-x.pdf", WorkspaceUploads.text("", one))
        val two = one + OutgoingFile(java.io.File("y"), "y.mp4", "video/mp4", 1, ".happy-uploads/m/1-y.mp4")
        assertEquals("Attached files:\n- ./.happy-uploads/m/0-x.pdf\n- ./.happy-uploads/m/1-y.mp4", WorkspaceUploads.text("", two))
        assertEquals("Look", WorkspaceUploads.text("Look", emptyList()))
    }

    @Test fun `names are made safe for any computer`() {
        assertEquals("report.pdf", safeAttachmentName("../../etc/report.pdf"))
        assertEquals("a_b_c.txt", safeAttachmentName("a:b?c.txt"))
        assertEquals("attachment", safeAttachmentName(" ..  "))
        assertEquals("x.txt", safeAttachmentName("C:\\Users\\me\\x.txt"))
        assertEquals("tab.txt", safeAttachmentName("ta\u0007b.txt"))
        val long = safeAttachmentName("ж".repeat(100))
        assertEquals(60, long.length)
    }
}
