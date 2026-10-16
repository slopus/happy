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
}
