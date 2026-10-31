package com.slopus.happy.agent

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** A bot's or project's picture is read over the tunnel once, then from memory, and on the next start from disk. */
class AgentPicturesTest {
    @get:Rule val folder = TemporaryFolder()

    @Test
    fun aPictureReadOnceComesFromDiskOnTheNextStartWithNoNetwork() = runBlocking {
        val directory = folder.newFolder("c1.pictures")
        val asked = mutableListOf<String>()
        val online = AgentPictures("c1", directory) { path -> asked += path; byteArrayOf(1, 2, 3) }
        assertArrayEquals(byteArrayOf(1, 2, 3), online.read("/v0/bots/b1/avatar", "th1"))
        assertArrayEquals(byteArrayOf(1, 2, 3), online.read("/v0/bots/b1/avatar", "th1"))
        assertEquals(listOf("/v0/bots/b1/avatar"), asked)

        val offline = AgentPictures("c1", directory) { error("no network") }
        assertArrayEquals(byteArrayOf(1, 2, 3), offline.read("/v0/bots/b1/avatar", "th1"))
        // A changed picture has a new ThumbHash: not the kept one.
        val changed = AgentPictures("c1", directory) { byteArrayOf(9) }
        assertArrayEquals(byteArrayOf(9), changed.read("/v0/bots/b1/avatar", "th2"))
    }
}
