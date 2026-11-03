package com.slopus.happy.media

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Media kept on the phone for good (iOS `MediaStore`, `PartialFile`): a
 * file arrives a range at a time with holes, its record outlives the app,
 * and once whole it becomes the complete file under its ID's hash.
 */
class MediaStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private fun bytes(n: Int, from: Int = 0) = ByteArray(n) { (from + it).toByte() }

    @Test
    fun aPartialFileKeepsItsRangesAndHolesAcrossARelaunch() {
        val dir = folder.newFolder()
        val data = File(dir, "a.part")
        val meta = File(dir, "a.part.meta")
        PartialFile(data, meta).apply {
            setTotal(100)
            write(bytes(10), 0)
            write(bytes(10, 50), 50)
            write(bytes(5, 10), 10)
            close()
        }
        val again = PartialFile(data, meta)
        assertEquals(100L, again.total)
        assertEquals(25L, again.downloaded)
        assertEquals(listOf(ByteSpan(0, 15), ByteSpan(50, 60)), again.held)
        assertEquals(listOf(ByteSpan(15, 50), ByteSpan(60, 100)), again.missing(ByteSpan(0, 100)))
        assertEquals(5L, again.contiguous(10, 100))
        assertArrayEquals(bytes(5, 10), again.read(ByteSpan(10, 15)))
        assertNull(again.read(ByteSpan(10, 20)))
        assertFalse(again.isComplete)
    }

    @Test
    fun aRecordThatDoesNotParseOrALengthThatChangesStartsOver() {
        val dir = folder.newFolder()
        val data = File(dir, "b.part")
        val meta = File(dir, "b.part.meta")
        PartialFile(data, meta).apply { setTotal(10); write(bytes(4), 0); close() }
        meta.writeText("{not json")
        val broken = PartialFile(data, meta)
        assertEquals(0L, broken.downloaded)
        assertFalse(data.exists())

        broken.setTotal(10)
        broken.write(bytes(4), 0)
        broken.setTotal(12)
        assertEquals("the file changed: what was kept goes", 0L, broken.downloaded)
    }

    @Test
    fun aWholePartialFileBecomesTheCompleteOneAndClearMediaEmptiesIt() {
        val store = MediaStore(File(folder.root, "media"))
        val id = "tool/a1/tc1/0"
        store.partial(id).apply { setTotal(6); write(bytes(3), 0); write(bytes(3, 3), 3) }
        assertTrue(store.hasPartial(id))
        store.finish(id)
        assertTrue(store.isComplete(id))
        assertEquals(MediaStore.name(id), store.completeFile(id).name)
        assertEquals(32, MediaStore.name(id).length)
        assertArrayEquals(bytes(2, 2), store.read(id, ByteSpan(2, 4)))
        assertFalse(store.hasPartial(id))

        store.keep("sent/1", bytes(8))
        assertEquals(14L, store.usage())
        store.removeAll()
        assertFalse(store.isComplete(id))
        assertEquals(0L, store.usage())
    }

    @Test
    fun theBadgeSaysTelegramsSizes() {
        assertEquals("840 B", MediaSizeText.size(840))
        assertEquals("12 KB", MediaSizeText.size(12 * 1024))
        assertEquals("8.4 MB", MediaSizeText.size((8.4 * 1024 * 1024).toLong()))
        assertEquals("2 MB", MediaSizeText.size(2L * 1024 * 1024))
        assertEquals("1.2 / 8.4 MB", MediaSizeText.progress((1.2 * 1024 * 1024).toLong(), (8.4 * 1024 * 1024).toLong()))
        assertEquals("0.4 / 8.4 MB", MediaSizeText.progress(400 * 1024, (8.4 * 1024 * 1024).toLong()))
        assertEquals("8.4 MB", MediaSizeText.text(DownloadPhase.Paused(0, (8.4 * 1024 * 1024).toLong())))
        assertNull(MediaSizeText.text(DownloadPhase.Remote(null)))
    }

    @Test
    fun automaticDownloadTakesPhotosAndSmallFilesButNotVideos() {
        val rules = MediaAutoDownload()
        assertTrue(rules.allows(MediaAutoDownload.Kind.Photos, null))
        assertTrue(rules.allows(MediaAutoDownload.Kind.Photos, 10 * MediaAutoDownload.MEGABYTE))
        assertFalse(rules.allows(MediaAutoDownload.Kind.Photos, 11 * MediaAutoDownload.MEGABYTE))
        assertFalse(rules.allows(MediaAutoDownload.Kind.Videos, 1))
        assertFalse(rules.allows(MediaAutoDownload.Kind.Files, null))
        assertTrue(rules.allows(MediaAutoDownload.Kind.Files, 1000))
        assertEquals(ContentRange(0, 1023, 4096), ContentRange.parse("bytes 0-1023/4096"))
        assertEquals(ContentRange(5, 9, null), ContentRange.parse("bytes 5-9/*"))
    }
}
