package com.slopus.happy.sync

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** iOS b6982bd92, 7c6c5bb2d, a22e5599e: the file viewer's reads kept on the account's disk, bounded. */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionFileCacheTest {
    @get:Rule val temp = TemporaryFolder()

    private fun TestScope.cache(dir: File, maxCount: Int = 32, maxFiles: Int = 256, maxEntryBytes: Int = 4 * 1024 * 1024, maxPendingBytes: Int = 8 * 1024 * 1024, maxPendingChanges: Int = 64) =
        SessionFileCache(dir, maxCount = maxCount, maxFiles = maxFiles, maxEntryBytes = maxEntryBytes, maxPendingBytes = maxPendingBytes, maxPendingChanges = maxPendingChanges, io = StandardTestDispatcher(testScheduler))

    private fun json(dir: File) = dir.listFiles { f -> f.name.endsWith(".json") }.orEmpty().toList()

    @Test fun `a read shows again after a relaunch, from the disk, named by hashes`() = runTest {
        val dir = temp.newFolder()
        val first = cache(dir)
        first.putFile("s1", "/repo/secret-plan.md", "hello", "@@ diff", false, now = 7)
        advanceUntilIdle()
        first.close()
        val names = json(dir).map { it.name }
        assertEquals(1, names.size)
        assertFalse("the name says nothing of the path", names.single().contains("secret"))
        assertTrue("a session's files share a prefix", names.single().startsWith(SessionFileCache.prefix("s1")))

        val again = cache(dir)
        assertNull("memory never touches the disk", again.file("s1", "/repo/secret-plan.md"))
        val kept = again.snapshot("s1", "/repo/secret-plan.md")
        assertEquals(SessionFileCache.File("hello", "@@ diff", false, 7), kept)
        assertEquals("then it is in memory", kept, again.file("s1", "/repo/secret-plan.md"))
        assertNull(again.snapshot("s1", "/repo/other"))
    }

    @Test fun `memory keeps the most recently used`() = runTest {
        val c = SessionFileCache(null, maxCount = 2)
        c.putFile("s", "a", "1", null, false)
        c.putFile("s", "b", "2", null, false)
        c.file("s", "a")
        c.putFile("s", "c", "3", null, false)
        assertEquals("1", c.file("s", "a")?.content)
        assertNull("b was the least recently used", c.file("s", "b"))
        assertEquals(2, c.keptCount)
    }

    @Test fun `a read past an entry is shown but never written, and one on disk past it is removed unread`() = runTest {
        val dir = temp.newFolder()
        val c = cache(dir, maxEntryBytes = 10)
        c.putFile("s", "big", "x".repeat(11), null, false)
        advanceUntilIdle()
        assertEquals("shown", 11, c.file("s", "big")?.content?.length)
        assertTrue("never written", json(dir).isEmpty())
        val planted = File(dir, SessionFileCache.name(SessionFileCache.Key("s", "planted")))
        planted.writeText(SessionFileCache.encode(SessionFileCache.File("y".repeat(40), null, false, 0)))
        assertNull(c.snapshot("s", "planted"))
        assertFalse(planted.exists())
    }

    @Test fun `the disk keeps the most recently used files`() = runTest {
        val dir = temp.newFolder()
        val c = cache(dir, maxFiles = 2)
        for ((i, path) in listOf("a", "b", "c").withIndex()) {
            c.putFile("s", path, path, null, false)
            advanceUntilIdle()
            File(dir, SessionFileCache.name(SessionFileCache.Key("s", path))).setLastModified(1_000_000L * (i + 1))
        }
        c.putFile("s", "d", "d", null, false)
        advanceUntilIdle()
        val left = json(dir).map { it.name }.toSet()
        assertEquals(2, left.size)
        assertFalse(SessionFileCache.name(SessionFileCache.Key("s", "a")) in left)
    }

    @Test fun `a deleted session's files go, waiting writes too`() = runTest {
        val dir = temp.newFolder()
        val c = cache(dir)
        c.putFile("gone", "a", "1", null, false)
        c.putFile("kept", "a", "2", null, false)
        advanceUntilIdle()
        c.putFile("gone", "b", "3", null, false)
        c.forgetSession("gone")
        advanceUntilIdle()
        assertNull(c.file("gone", "a"))
        assertNull(c.snapshot("gone", "b"))
        assertEquals(listOf(SessionFileCache.name(SessionFileCache.Key("kept", "a"))), json(dir).map { it.name })
    }

    @Test fun `waiting writes are one per file, and an older one gives way as a removal past the budget`() = runTest {
        val dir = temp.newFolder()
        val c = cache(dir, maxPendingBytes = 10)
        c.putFile("s", "a", "old", null, false)
        advanceUntilIdle()
        c.putFile("s", "a", "1234", null, false)
        c.putFile("s", "b", "1234567890", null, false)
        // A read sees what was asked before it: a's newer copy gave way, so no older one comes back.
        assertEquals("1234", c.file("s", "a")?.content)
        advanceUntilIdle()
        val again = cache(dir)
        assertNull("a's waiting write became its removal", again.snapshot("s", "a"))
        assertEquals("1234567890", again.snapshot("s", "b")?.content)
    }

    @Test fun `past the waiting changes the directory is emptied before what comes next`() = runTest {
        val dir = temp.newFolder()
        val c = cache(dir, maxPendingChanges = 2)
        c.putFile("s", "x", "x", null, false)
        advanceUntilIdle()
        c.putFile("s", "a", "a", null, false)
        c.putFile("s", "b", "b", null, false)
        c.putFile("s", "c", "c", null, false)
        c.putFile("s", "d", "d", null, false)
        advanceUntilIdle()
        val left = json(dir).map { it.name }.toSet()
        assertFalse(SessionFileCache.name(SessionFileCache.Key("s", "x")) in left)
        assertTrue(SessionFileCache.name(SessionFileCache.Key("s", "d")) in left)
    }

    @Test fun `once closed nothing is shown or written`() = runTest {
        val dir = temp.newFolder()
        val c = cache(dir)
        c.putFile("s", "a", "1", null, false)
        c.close()
        assertEquals("what was asked before close is written", 1, json(dir).size)
        c.putFile("s", "b", "2", null, false)
        advanceUntilIdle()
        assertNull(c.file("s", "a"))
        assertNull(c.snapshot("s", "a"))
        assertEquals(1, json(dir).size)
    }
}
