package com.slopus.happy.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.lang.management.ManagementFactory

/**
 * What the watchers of every session (avatars, git status, projects, the
 * composer's mirrors) read on each change. A large Happy CLI account (471
 * sessions, 12 MB of metadata) ran out of memory while they each read
 * whole rows at once; their reads hold only the columns they use, so what
 * they allocate is a small part of a whole read.
 */
@RunWith(AndroidJUnit4::class)
class SessionWatcherReadsTest {
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private val threads = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean

    @Before
    fun setUp() {
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
        // A large account: 400 sessions with 30 KB of metadata each, a tenth with an avatar.
        val metadata = """{"path":"/repo","notes":"${"x".repeat(30_000)}"}"""
        store.upsertSessions(
            (0 until 400).map { i ->
                SessionRecord(
                    "s$i", 1, 0, i.toLong(), false, 0, metadata, i.toLong(), null, 0, "key",
                    projectId = if (i % 2 == 0) " p${i % 3} " else null,
                    avatarJson = if (i % 10 == 0) """{"ref":"r$i","preview":"p","version":1}""" else null,
                )
            },
        )
    }

    @After
    fun tearDown() = database.close()

    private fun <T> allocated(read: () -> T): Pair<T, Long> {
        val id = Thread.currentThread().id
        val before = threads.getThreadAllocatedBytes(id)
        val value = read()
        return value to threads.getThreadAllocatedBytes(id) - before
    }

    @Test
    fun theWatchersReadTheirColumnsAndAFractionOfWhatAWholeReadAllocates() {
        store.sessions()
        val (rows, whole) = allocated { store.sessions() }
        assertEquals(400, rows.size)
        // The measure sees the metadata: a whole read makes every row's 30 KB.
        assertTrue("a whole read allocates the metadata: $whole", whole > 400L * 30_000)

        val (avatars, avatarBytes) = allocated { store.sessionAvatarJsons() }
        val (ids, idBytes) = allocated { store.sessionIds() }
        val (projects, projectBytes) = allocated { store.sessionProjectIds() }
        val (versions, versionBytes) = allocated { store.sessionMetadataVersions() }
        for ((name, bytes) in listOf("avatars" to avatarBytes, "ids" to idBytes, "projects" to projectBytes, "versions" to versionBytes)) {
            assertTrue("$name allocates $bytes of a whole read's $whole", bytes < whole / 20)
        }

        assertEquals(400, avatars.size)
        assertEquals(40, avatars.values.count { it != null })
        assertEquals("""{"ref":"r10","preview":"p","version":1}""", avatars["s10"])
        assertEquals(400, ids.size)
        assertEquals(setOf("p0", "p1", "p2"), projects)
        assertEquals(399L, versions["s399"])
    }
}
