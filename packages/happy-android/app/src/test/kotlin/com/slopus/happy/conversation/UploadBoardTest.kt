package com.slopus.happy.conversation

import com.slopus.happy.connection.BodyProgress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The pieces behind the upload rings (iOS `UploadProgressBoard`, `UploadRanges`, the transports' chunked writes). */
class UploadBoardTest {
    @Test fun `a body is written a chunk at a time and each chunk is told`() {
        val body = ByteArray(BodyProgress.CHUNK * 2 + 10)
        val told = ArrayList<Int>()
        val chunks = ArrayList<Int>()
        BodyProgress { _, sent -> told += sent }.write(body) { chunks += it.size }
        assertEquals(listOf(BodyProgress.CHUNK, BodyProgress.CHUNK, 10), chunks)
        assertEquals(listOf(BodyProgress.CHUNK, BodyProgress.CHUNK * 2, body.size), told)
    }

    @Test fun `each picture's share is how much of its base64 is written`() {
        val a = "A".repeat(100)
        val b = "B".repeat(100)
        val body = """{"text":"hi","content":[{"data":"$a"},{"data":"$b"}]}""".toByteArray()
        val ranges = UploadRanges(body, listOf(a, b))
        val start = String(body).indexOf(a)
        assertEquals(listOf(0f, 0f), ranges.shares(start))
        assertEquals(listOf(0.5f, 0f), ranges.shares(start + 50))
        assertEquals(listOf(1f, 1f), ranges.shares(body.size))
    }

    @Test fun `shares move in steps, and a message's pictures are forgotten together`() {
        val board = UploadBoard()
        board.set(UploadBoard.pictureKey("m", 0), UploadPhase.Uploading(0.3333333f))
        val share = (board.phase("m:1") as UploadPhase.Uploading).share
        assertEquals(0f, share * 512 % 1f, 0.0001f)
        board.set(UploadBoard.pictureKey("m", 1), UploadPhase.Done)
        board.set(UploadBoard.pictureKey("n", 0), UploadPhase.Preparing)
        board.clear("m")
        assertNull(board.phase("m:1"))
        assertNull(board.phase("m:2"))
        assertEquals(UploadPhase.Preparing, board.phase("n:1"))
    }
}
