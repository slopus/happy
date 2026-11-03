package com.slopus.happy.conversation

import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.safeAttachmentName
import org.junit.Assert.assertEquals
import org.junit.Test

class WorkspaceUploadsTest {
    private val mib = 1024L * 1024
    private fun preview(name: String, type: String, size: Long) = AttachmentPreview(name, "file:///cache/$name", 0, 0, type, size, name)

    @Test fun `everything goes into the workspace in order, readable pictures are also drawn`() {
        val (drawn, files) = WorkspaceUploads.split(
            "m1",
            listOf(
                preview("a.jpg", "image/jpeg", mib),
                preview("clip.mp4", "video/mp4", 20 * mib),
                preview("b.heic", "image/heic", mib),
                preview("huge.png", "image/png", 6 * mib),
                preview("notes.pdf", "application/pdf", 10),
            ),
        )
        assertEquals(listOf("a.jpg"), drawn.map { it.name })
        assertEquals(
            listOf(
                ".happy-uploads/m1/0-a.jpg", ".happy-uploads/m1/1-clip.mp4", ".happy-uploads/m1/2-b.heic",
                ".happy-uploads/m1/3-huge.png", ".happy-uploads/m1/4-notes.pdf",
            ),
            files.map { it.path },
        )
        assertEquals("/cache/a.jpg", files[0].file.path)
    }

    @Test fun `drawn pictures stop at 29 MB together, all still go`() {
        val (drawn, files) = WorkspaceUploads.split("m", List(7) { preview("$it.jpg", "image/jpeg", 5 * mib) })
        assertEquals(5, drawn.size)
        assertEquals(7, files.size)
    }

    @Test fun `the message names its files in the shared attachment note`() {
        val picture = listOf(OutgoingFile(java.io.File("a"), "a.jpg", "image/jpeg", 1, ".happy-uploads/m/0-a.jpg"))
        assertEquals(
            "Look\n\nThe user attached 1 image. It was saved on this machine and not loaded into your context; " +
                "open it with your file-reading or image-viewing tool only if you need to see it:\n- ./.happy-uploads/m/0-a.jpg",
            WorkspaceUploads.text("Look", picture),
        )
        val two = picture + OutgoingFile(java.io.File("y"), "y.mp4", "video/mp4", 1, ".happy-uploads/m/1-y.mp4")
        assertEquals(
            "The user attached 2 files. They were saved on this machine and not loaded into your context; " +
                "open them with your file-reading or image-viewing tool only if you need to see them:\n" +
                "- ./.happy-uploads/m/0-a.jpg\n- ./.happy-uploads/m/1-y.mp4",
            WorkspaceUploads.text("", two),
        )
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
