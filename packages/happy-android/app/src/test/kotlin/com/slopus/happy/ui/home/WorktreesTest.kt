package com.slopus.happy.ui.home

import com.slopus.happy.sync.BashResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.random.Random

/** utils/worktree.ts createWorktree over a scripted daemon shell. */
class WorktreesTest {
    private fun shell(vararg answers: BashResult): Pair<MutableList<String>, suspend (String) -> BashResult> {
        val commands = mutableListOf<String>()
        val queue = ArrayDeque(answers.toList())
        return commands to { command -> commands += command; queue.removeFirst() }
    }

    private val ok = BashResult(success = true, exitCode = 0)

    @Test fun checksOutANewBranchUnderTheWorktreeDirectory() = runTest {
        val (commands, bash) = shell(ok, ok)
        val created = createWorktree("/repo", Random(1), bash) as WorktreeOutcome.Created
        assertEquals("/repo/.dev/worktree/${created.branch}", created.path)
        assertEquals(listOf("git rev-parse --git-dir", "git worktree add -b ${created.branch} .dev/worktree/${created.branch}"), commands)
    }

    @Test fun retriesATakenNameWithASuffix() = runTest {
        val taken = BashResult(success = false, stderr = "fatal: a branch named 'x' already exists", exitCode = 128)
        val (_, bash) = shell(ok, taken, taken, ok)
        val created = createWorktree("/repo", Random(1), bash) as WorktreeOutcome.Created
        assertEquals(true, created.branch.endsWith("-3"))
    }

    @Test fun tellsAFailedShellCallFromAFolderThatIsNotARepository() = runTest {
        assertEquals(
            WorktreeOutcome.Failed("Not a Git repository"),
            createWorktree("/tmp", bash = shell(BashResult(success = false, stderr = "fatal", exitCode = 128)).second),
        )
        assertEquals(
            WorktreeOutcome.Failed("Failed to connect to machine"),
            createWorktree("/tmp", bash = shell(BashResult(success = false, exitCode = -1)).second),
        )
    }

    private val wt = "/repo/.dev/worktree/swift-ocean"

    private fun cleanup(
        status: BashResult,
        answer: Boolean,
        path: String? = wt,
        others: List<com.slopus.happy.model.Session> = emptyList(),
    ): Pair<List<Pair<String, String>>, Int> {
        val calls = mutableListOf<Pair<String, String>>()
        var asked = 0
        runTest {
            maybeCleanupWorktree(
                "s1", path, "m1", others,
                bash = { machineId, command, cwd ->
                    assertEquals("m1", machineId)
                    calls += command to cwd
                    if (command.startsWith("git status")) status else ok
                },
                confirm = { asked++; answer },
            )
        }
        return calls to asked
    }

    @Test fun aCleanWorktreeIsRemovedFromTheMainCheckoutWhenConfirmed() {
        val (calls, asked) = cleanup(ok, answer = true)
        assertEquals(1, asked)
        assertEquals(listOf("git status --porcelain" to wt, "git worktree remove $wt --force" to "/repo"), calls)
        assertEquals(listOf("git status --porcelain" to wt), cleanup(ok, answer = false).first)
    }

    @Test fun changesAFailedStatusOrAnotherActiveChatSkipThePrompt() {
        assertEquals(0, cleanup(ok.copy(stdout = " M a.kt\n"), answer = true).second)
        assertEquals(0, cleanup(BashResult(success = false, exitCode = -1), answer = true).second)
        val other = com.slopus.happy.model.HomeModelFixtures.session("s2", com.slopus.happy.model.HomeModelFixtures.metadata(path = wt))
        val (calls, asked) = cleanup(ok, answer = true, others = listOf(other))
        assertEquals(0, asked)
        assertEquals(emptyList<Pair<String, String>>(), calls)
        // Not a Happy worktree: nothing runs.
        assertEquals(emptyList<Pair<String, String>>(), cleanup(ok, answer = true, path = "/repo").first)
    }
}
