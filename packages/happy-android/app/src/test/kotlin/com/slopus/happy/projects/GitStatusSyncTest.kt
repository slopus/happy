package com.slopus.happy.projects

import com.slopus.happy.model.GitStatusCommands
import com.slopus.happy.sync.BashResult
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * gitStatusSync.ts against a fake shell: sessions in one checkout share one
 * status, asked through the session's shell in its directory; a directory
 * that is not a repository has none; a failed status keeps the last one;
 * invalidations coalesce over 300 ms and do nothing for a checkout no
 * refresh registered; the status goes with the last session in it.
 */
class GitStatusSyncTest {
    private val checkouts = mutableMapOf(
        "a" to GitCheckout("m1:/repo", "/repo"),
        "b" to GitCheckout("m1:/repo", "/repo"),
        "c" to GitCheckout("m1:/other", "/other"),
    )
    private val calls = mutableListOf<Triple<String, String, String>>()
    private var repo = true
    private var statusOk = true
    private var unstaged = "3\t1\tx.ts"

    private fun TestScope.sync() = GitStatusSync(
        backgroundScope,
        checkout = { checkouts[it] },
        bash = { id, command, cwd, _ ->
            calls.add(Triple(id, command, cwd))
            when (command) {
                GitStatusCommands.IS_REPO -> if (repo) BashResult(true, "true\n", exitCode = 0) else BashResult(true, "", "fatal", exitCode = 128)
                GitStatusCommands.STATUS -> if (statusOk) BashResult(true, "# branch.head main\n1 .M N... 100644 100644 100644 a b x.ts", exitCode = 0) else BashResult(false, error = "offline")
                GitStatusCommands.UNSTAGED_NUMSTAT -> BashResult(true, unstaged, exitCode = 0)
                else -> BashResult(true, "", exitCode = 0)
            }
        },
        now = { 7 },
    )

    @Test fun sessionsInOneCheckoutShareItsStatus() = runTest {
        val sync = sync()
        sync.refresh("a")
        runCurrent()
        val status = sync.statuses.value["m1:/repo"]!!
        assertEquals("main", status.branch)
        assertEquals(3L, status.linesAdded)
        assertEquals(1L, status.linesRemoved)
        assertEquals(listOf(GitStatusCommands.IS_REPO, GitStatusCommands.STATUS, GitStatusCommands.UNSTAGED_NUMSTAT, GitStatusCommands.STAGED_NUMSTAT), calls.map { it.second })
        assertTrue(calls.all { it.first == "a" && it.third == "/repo" })
        calls.clear()
        sync.refresh("b")
        runCurrent()
        assertEquals("the checkout's refresh asks through the session that registered it", setOf("a"), calls.map { it.first }.toSet())
        assertEquals(setOf("m1:/repo"), sync.statuses.value.keys)
    }

    @Test fun notARepositoryHasNoStatusAndAFailedStatusKeepsTheLast() = runTest {
        val sync = sync()
        sync.refresh("a")
        runCurrent()
        statusOk = false
        unstaged = "9\t9\tx.ts"
        sync.refresh("a")
        runCurrent()
        assertEquals(3L, sync.statuses.value["m1:/repo"]!!.linesAdded)
        repo = false
        sync.refresh("a")
        runCurrent()
        assertNull(sync.statuses.value["m1:/repo"])
    }

    @Test fun invalidationsCoalesceAndNeedARegisteredCheckout() = runTest {
        val sync = sync()
        sync.invalidate("c")
        advanceTimeBy(1_000)
        assertTrue("never refreshed, so nothing to invalidate", calls.isEmpty())

        sync.refresh("c")
        runCurrent()
        calls.clear()
        repeat(3) {
            sync.invalidate("c")
            advanceTimeBy(100)
        }
        assertTrue("still inside the burst", calls.isEmpty())
        advanceTimeBy(301)
        assertEquals("one run for the burst", 1, calls.count { it.second == GitStatusCommands.IS_REPO })
    }

    @Test fun theStatusGoesWithTheLastSessionInTheCheckout() = runTest {
        val sync = sync()
        sync.refresh("a")
        sync.refresh("b")
        runCurrent()
        sync.clearForSession("a")
        assertTrue("b is still there", "m1:/repo" in sync.statuses.value)
        calls.clear()
        sync.refresh("b")
        runCurrent()
        assertTrue("a is gone, so b asks", calls.all { it.first == "b" })
        sync.clearForSession("b")
        assertNull(sync.statuses.value["m1:/repo"])
    }
}
