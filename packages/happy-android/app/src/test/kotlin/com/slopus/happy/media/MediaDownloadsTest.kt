package com.slopus.happy.media

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/**
 * Downloads into the kept store (iOS `MediaDownloads`): a whole file a
 * range at a time, paused and resumed from what was kept (a relaunch too),
 * a player's range fetched first, failures given up on, and at most two
 * automatic downloads at once.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MediaDownloadsTest {
    @get:Rule val folder = TemporaryFolder()

    private val file = ByteArray(2_500_000) { (it % 251).toByte() }
    private val asked = ArrayList<ByteSpan>()
    private var gate: CompletableDeferred<Unit>? = null
    private var failing: Exception? = null
    /** Fetches past this many wait for good: a download stopped mid-way. */
    private var servedBeforeHang = Int.MAX_VALUE
    private var served = 0

    private fun source(total: Long? = file.size.toLong()) = MediaSource(total) { span ->
        gate?.await()
        if (served++ >= servedBeforeHang) CompletableDeferred<Unit>().await()
        failing?.let { throw it }
        synchronized(asked) { asked += span }
        val end = minOf(span.end, file.size.toLong())
        MediaPiece(span.start, file.copyOfRange(span.start.toInt(), end.toInt()), file.size.toLong())
    }

    private fun TestScope.downloads(dir: File = File(folder.root, "media")) =
        MediaDownloads(MediaStore(dir), DownloadBoard(), StandardTestDispatcher(testScheduler), sleep = {})

    @Test
    fun aWholeFileComesAMegabyteAtATimeAndIsKept() = runTest {
        val downloads = downloads()
        val bytes = async { downloads.data("f", source()) }
        advanceUntilIdle()
        assertArrayEquals(file, bytes.await())
        assertEquals(listOf(ByteSpan(0, MediaDownloads.CHUNK), ByteSpan(MediaDownloads.CHUNK, 2 * MediaDownloads.CHUNK), ByteSpan(2 * MediaDownloads.CHUNK, file.size.toLong())), asked)
        assertEquals(DownloadPhase.Complete(file.size.toLong()), downloads.board.phase("f"))
        asked.clear()
        assertArrayEquals("read from the phone, not again", file, downloads.data("f", source()))
        assertTrue(asked.isEmpty())
    }

    @Test
    fun aPausedDownloadResumesFromWhatWasKeptAfterARelaunch() = runTest {
        val dir = File(folder.root, "kept")
        val first = downloads(dir)
        servedBeforeHang = 1
        first.download("f", source())
        advanceUntilIdle()
        // One range landed, the next hangs; the person pauses.
        first.pause("f")
        advanceUntilIdle()
        val paused = first.board.phase("f")
        assertEquals(DownloadPhase.Paused(MediaDownloads.CHUNK, file.size.toLong()), paused)
        first.stop()

        asked.clear()
        servedBeforeHang = Int.MAX_VALUE
        val second = downloads(dir)
        assertTrue(second.phase("f", source()) is DownloadPhase.Paused)
        val bytes = async { second.data("f", source()) }
        advanceUntilIdle()
        assertArrayEquals(file, bytes.await())
        assertTrue("nothing kept is asked again: $asked", asked.none { it.start == 0L })
    }

    @Test
    fun aPlayersRangeIsFetchedFirst() = runTest {
        val downloads = downloads()
        val read = async { downloads.read("v", source(), ByteSpan(2_000_000, 2_000_100)) }
        advanceUntilIdle()
        assertArrayEquals(file.copyOfRange(2_000_000, 2_000_100), read.await())
        assertEquals(ByteSpan(2_000_000, 2_000_000 + MediaDownloads.STREAM_CHUNK), asked.first())
        assertEquals("only what it asked", 1, asked.size)
    }

    @Test
    fun aRefusalFailsAtOnceAndATapTriesAgain() = runTest {
        val downloads = downloads()
        failing = MediaError.Status(404)
        downloads.download("f", source())
        advanceUntilIdle()
        assertTrue(downloads.board.phase("f") is DownloadPhase.Failed)

        failing = IOException("dropped")
        downloads.toggle("f", source())
        advanceUntilIdle()
        assertTrue("three tries, then failed", downloads.board.phase("f") is DownloadPhase.Failed)

        failing = null
        downloads.toggle("f", source())
        advanceUntilIdle()
        assertTrue(downloads.board.phase("f") is DownloadPhase.Complete)
    }

    @Test
    fun atMostTwoAutomaticDownloadsRunAtOnceAndATapGoesPast() = runTest {
        val downloads = downloads()
        gate = CompletableDeferred()
        for (id in listOf("a", "b", "c")) downloads.download(id, source(), MediaDownloads.Priority.Background)
        advanceUntilIdle()
        assertTrue(downloads.isRunning("a") && downloads.isRunning("b"))
        assertTrue("queued", !downloads.isRunning("c"))
        downloads.download("c", source(), MediaDownloads.Priority.User)
        advanceUntilIdle()
        assertTrue("a tap lifts it", downloads.isRunning("c"))
        gate!!.complete(Unit)
        advanceUntilIdle()
        assertTrue(listOf("a", "b", "c").all { downloads.board.phase(it) is DownloadPhase.Complete })
    }
}
