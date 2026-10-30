package com.slopus.happy.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Only this app's own media directory, and only names it made itself. */
class MediaFilesTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test fun `a name keeps its leaf and takes its type's extension`() {
        assertEquals("repro.mp4", MediaFiles.safeName("repro.mp4", "video/mp4"))
        assertEquals("repro.mp4", MediaFiles.safeName("/var/tmp/repro.mov", "video/mp4"))
        assertEquals("notes.pdf", MediaFiles.safeName("notes", "application/pdf"))
        assertEquals("shot.png", MediaFiles.safeName("shot.png", "image/png; charset=binary"))
        // A type this build doesn't know keeps the name's own extension, else none at all.
        assertEquals("archive.rar", MediaFiles.safeName("archive.rar", "application/x-rar"))
        assertEquals("thing.bin", MediaFiles.safeName("thing", "application/x-rar"))
    }

    @Test fun `a name that could walk out of the directory can't`() {
        assertEquals("passwd.bin", MediaFiles.safeName("../../../etc/passwd", "application/octet-stream"))
        assertEquals("evil.bin", MediaFiles.safeName("..\\\\windows\\\\evil", "application/octet-stream"))
        assertEquals("attachment.txt", MediaFiles.safeName("../", "text/plain"))
        assertEquals("a b.txt", MediaFiles.safeName("  a\t\tb\n", "text/plain"))
    }

    @Test fun `bytes land under the shared directory alone, and replace what was there`() {
        val cache = folder.newFolder()
        val item = MediaItem("video", "../../escape.mp4", "video/mp4")
        val file = MediaFiles.stage(cache, "call-1/../..", item, byteArrayOf(1, 2, 3))
        assertTrue(file.canonicalPath.startsWith(File(cache, MediaFiles.DIRECTORY).canonicalPath))
        assertEquals("escape.mp4", file.name)
        assertEquals(3, file.length())
        MediaFiles.stage(cache, "call-1/../..", item, byteArrayOf(9))
        assertEquals(1, file.length())
    }

    @Test fun `each item has its own place, so two of a name don't collide`() {
        val cache = folder.newFolder()
        val first = MediaFiles.stage(cache, "call-1/0", MediaItem("file", "notes.txt", "text/plain"), byteArrayOf(1))
        val second = MediaFiles.stage(cache, "call-2/0", MediaItem("file", "notes.txt", "text/plain"), byteArrayOf(2, 2))
        assertEquals(first.name, second.name)
        assertTrue(first.canonicalPath != second.canonicalPath)
        assertEquals(1, first.length())
        assertEquals(2, second.length())
    }
}
