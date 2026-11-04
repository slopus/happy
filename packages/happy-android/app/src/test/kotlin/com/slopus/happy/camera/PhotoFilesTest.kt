package com.slopus.happy.camera

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PhotoFilesTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun closingDeletesAbandonedCapturesAndKeepsThePhotoGivenToTheDraft() {
        val files = PhotoFiles(temporary.root)
        val abandoned = files.allocate()
        File(abandoned, "capture.jpg").writeText("raw")
        val used = files.allocate()
        val photo = File(used, "photo.jpg").apply { writeText("normalized") }
        assertTrue(files.transfer(used))
        files.close()
        assertFalse(abandoned.exists())
        assertTrue(photo.isFile)
        assertFalse("Use Photo transfers once", files.transfer(used))
    }

    @Test
    fun aCameraCallbackAfterDisposalCanRemoveItsLateOutput() {
        val files = PhotoFiles(temporary.root)
        val capture = files.allocate()
        files.close()
        capture.mkdirs()
        File(capture, "late.jpg").writeText("finished after cancellation")
        files.discard(capture)
        assertFalse(capture.exists())
        assertFalse(files.holds(capture))
        assertFalse(files.transfer(capture))
    }

    @Test
    fun retakeDiscardsTheOldPhotoAndLetsTheNextCaptureOwnItsFiles() {
        val files = PhotoFiles(temporary.root)
        val capture = files.allocate()
        File(capture, "review.jpg").writeText("retaken")
        files.discard(capture)
        assertFalse(capture.exists())
        assertFalse(files.transfer(capture))
        val next = files.allocate()
        assertTrue(files.holds(next))
        files.close()
    }

    @Test
    fun cleanupDoesNotTouchATransferredPhotoOrAnUnownedDirectory() {
        val files = PhotoFiles(temporary.root)
        val used = files.allocate()
        val photo = File(used, "photo.jpg").apply { writeText("sent to draft") }
        val other = temporary.newFolder("other")
        val unrelated = File(other, "keep").apply { writeText("unowned") }
        assertTrue(files.transfer(used))
        files.discard(used)
        files.discard(other)
        files.close()
        assertTrue(photo.isFile)
        assertTrue(unrelated.isFile)
    }

    @Test(expected = IllegalStateException::class)
    fun aDisposedCameraCannotAllocateMoreFiles() {
        val files = PhotoFiles(temporary.root)
        files.close()
        files.allocate()
    }
}
