package com.slopus.happy.ui.files

import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.model.GitFileStatus
import com.slopus.happy.model.GitStatusParser
import com.slopus.happy.sync.BashResult
import com.slopus.happy.sync.GitFacts
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import com.slopus.happy.sync.GitState
import com.slopus.happy.sync.ReadFileResult
import com.slopus.happy.sync.SessionFileCache
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * AllFilesDiffView's legacy fetching and HappyAgentDiffView's snapshot
 * over a scripted session: which shell commands run, how results become
 * list items, what is fetched again.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionChangesTest {
    private class FakeOps : SessionFileOps {
        val commands = ArrayList<String>()
        var status = ""
        var numstat = ""
        val files = HashMap<String, String>()
        var state: GitState? = null
        val reads = ArrayList<String>()

        override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long): BashResult {
            commands += command
            return when {
                command == GitStatusParser.STATUS_COMMAND -> BashResult(true, stdout = status, exitCode = 0)
                command == GitStatusParser.NUMSTAT_COMMAND -> BashResult(true, stdout = numstat, exitCode = 0)
                command.contains(" diff HEAD ") -> BashResult(true, stdout = "@@ -1 +1 @@\n-a\n+b\n", exitCode = 0)
                command.contains(" show HEAD:") -> BashResult(true, stdout = "AAAA\nBBBB\n", exitCode = 0)
                else -> BashResult(false, error = "no")
            }
        }

        override suspend fun readFile(sessionId: String, path: String): ReadFileResult =
            files[path]?.let { ReadFileResult(true, Base64.getEncoder().encodeToString(it.toByteArray())) } ?: ReadFileResult(false, error = "missing")

        override suspend fun gitState(sessionId: String): GitState = state ?: error("no state")

        override suspend fun readGitFile(sessionId: String, base: String, file: GitFile): GitFileContent {
            reads += file.path
            return GitFileContent.Text("old\n", "new\n")
        }
    }

    @Test
    fun legacyFetchesEveryFileOnce() = runTest(StandardTestDispatcher()) {
        val ops = FakeOps().apply {
            status = "# branch.head main\n1 .M N... 100644 100644 100644 abc def src/a.kt\n? new.txt\n1 .M N... 100644 100644 100644 abc def logo.png\n"
            numstat = "1\t1\tsrc/a.kt\n---STAGED---\n"
            files["/repo/new.txt"] = "one\ntwo\n"
            files["/repo/logo.png"] = "png"
        }
        val changes = LegacyChanges(this as TestScope, ops, "s", "/repo")
        changes.refresh()
        advanceUntilIdle()
        val state = changes.state.value
        assertTrue(state.loadedOnce)
        val items = state.items.associateBy { it.path }
        assertEquals(listOf("logo.png", "new.txt", "src/a.kt"), state.items.map { it.path })
        assertEquals(DiffSource.Patch("@@ -1 +1 @@\n-a\n+b\n"), items.getValue("src/a.kt").source)
        assertEquals(FileChangeKind.Added, items.getValue("new.txt").kind)
        // Untracked files count their own lines.
        assertEquals(2, items.getValue("new.txt").additions)
        assertEquals(DiffSource.Contents("new.txt", "", "one\ntwo\n"), items.getValue("new.txt").source)
        val image = items.getValue("logo.png").image!!
        assertEquals("data:image/png;base64,AAAABBBB", image.before)
        assertTrue(image.after!!.startsWith("data:image/png;base64,"))
        assertTrue(ops.commands.any { it == "git -c core.quotepath=false diff HEAD --no-ext-diff -- \"src/a.kt\"" })

        // Nothing changed: nothing fetched again. Whitespace refetches the patch.
        val before = ops.commands.size
        changes.refresh()
        advanceUntilIdle()
        assertEquals(before + 2, ops.commands.size)
        changes.setIgnoreWhitespace(true)
        advanceUntilIdle()
        assertTrue(ops.commands.last().contains(" -w ") || ops.commands.any { it.contains("-w -- \"src/a.kt\"") })
        changes.expandContext("src/a.kt")
        advanceUntilIdle()
        assertTrue(ops.commands.any { it.contains("-U${GitStatusParser.FULL_FILE_CONTEXT}") })
    }

    @Test
    fun legacyOutsideTheRootIsAnError() = runTest(StandardTestDispatcher()) {
        val ops = FakeOps().apply { status = "1 .M N... 100644 100644 100644 abc def ../x.kt\n" }
        val changes = LegacyChanges(this as TestScope, ops, "s", "/repo")
        changes.refresh()
        advanceUntilIdle()
        assertEquals("File is outside the session root.", changes.state.value.items.single().error)
    }

    @Test
    fun notARepositoryHasNoFiles() = runTest(StandardTestDispatcher()) {
        val ops = object : SessionFileOps by FakeOps() {
            override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long) = BashResult(true, exitCode = 128)
        }
        val changes = LegacyChanges(this as TestScope, ops, "s", "/repo")
        changes.refresh()
        advanceUntilIdle()
        assertEquals(emptyList<GitFileStatus>(), changes.state.value.files)
    }

    @Test
    fun agentReadsExpandedFilesOnly() = runTest(StandardTestDispatcher()) {
        val files = listOf(
            GitFile("a.kt", status = "modified", staged = false, unstaged = true, binary = false, insertions = 3, deletions = 1),
            GitFile("b.kt", status = "untracked", staged = false, unstaged = true, binary = false),
        )
        val ops = FakeOps().apply {
            state = GitState(GitFacts("main", false, null, null, 0, 0), "ready", "a".repeat(40), 2, 3, 1, true, false, files, false, 0.0)
        }
        val changes = AgentChanges(this as TestScope, ops, "s", supported = true)
        changes.refresh()
        advanceUntilIdle()
        val items = changes.state.value.items("File is empty")
        assertEquals(listOf(FileChangeKind.Modified, FileChangeKind.Added), items.map { it.kind })
        assertEquals(3, items[0].additions)
        assertNull(items[0].source)
        assertTrue(ops.reads.isEmpty())
        changes.requestContent("a.kt")
        advanceUntilIdle()
        assertEquals(listOf("a.kt"), ops.reads)
        val source = changes.state.value.items("File is empty")[0].source as DiffSource.Contents
        assertEquals("old\n" to "new\n", source.oldText to source.newText)
        assertEquals(AgentChanges.NATIVE_DIFF_BUDGET, source.diffBudget)
        changes.expandContext("a.kt")
        assertEquals(GitStatusParser.FULL_FILE_CONTEXT, (changes.state.value.items("")[0].source as DiffSource.Contents).contextLines)
        assertEquals(2, changes.state.value.fileCount)
    }

    @Test
    fun agentFailureIsAMessage() = runTest(StandardTestDispatcher()) {
        val changes = AgentChanges(this as TestScope, FakeOps(), "s", supported = true)
        changes.refresh()
        advanceUntilIdle()
        assertEquals(AgentChanges.Load.Error("no state"), changes.state.value.load)
    }

    @Test
    fun legacyShowsTheCachedListWhileGitRuns() = runTest(StandardTestDispatcher()) {
        val ops = FakeOps().apply {
            status = "1 .M N... 100644 100644 100644 abc def src/a.kt\n"
            numstat = "1\t1\tsrc/a.kt\n---STAGED---\n"
        }
        val cache = SessionFileCache()
        val first = LegacyChanges(this as TestScope, ops, "s", "/repo", cache, "m:/repo")
        assertNull(first.state.value.files)
        first.refresh()
        advanceUntilIdle()
        assertEquals(listOf("src/a.kt"), cache.statusFiles("m:/repo")?.files?.unstagedFiles?.map { it.fullPath })

        // Back again: the list is there before git answers, its diffs fetch at once.
        ops.status = "1 .M N... 100644 100644 100644 abc def src/a.kt\n1 .M N... 100644 100644 100644 abc def src/b.kt\n"
        val again = LegacyChanges(this, ops, "s", "/repo", cache, "m:/repo")
        assertEquals(listOf("src/a.kt"), again.state.value.files?.map { it.fullPath })
        again.refresh()
        advanceUntilIdle()
        assertEquals(listOf("src/a.kt", "src/b.kt"), again.state.value.items.map { it.path })
        assertEquals(2, cache.statusFiles("m:/repo")?.files?.unstagedFiles?.size)
        // Another checkout starts empty.
        assertNull(LegacyChanges(this, ops, "s", "/other", cache, "m:/other").state.value.files)
    }

    @Test
    fun fileViewerShowsTheCachedCopyThenTheFetch() = runTest(StandardTestDispatcher()) {
        var diff = "@@ -1 +1 @@\n-a\n+b\n"
        var read = ReadFileResult(true, Base64.getEncoder().encodeToString("b\n".toByteArray()))
        val ops = object : SessionFileOps by FakeOps() {
            override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long) = BashResult(true, stdout = diff, exitCode = 0)
            override suspend fun readFile(sessionId: String, path: String) = read
        }
        val cache = SessionFileCache()
        assertEquals(
            listOf(FileLoad.Loaded("b\n", diff)),
            ops.fileLoads(cache, "s", "/repo/a.kt", "/repo", "a.kt").toList(),
        )
        assertEquals("b\n", cache.file("s", "/repo/a.kt")?.content)

        // Committed since: the cached copy first, and file.tsx keeps the diff it had.
        val old = diff
        diff = ""
        read = ReadFileResult(true, Base64.getEncoder().encodeToString("c\n".toByteArray()))
        assertEquals(
            listOf(FileLoad.Loaded("b\n", old), FileLoad.Loaded("c\n", old)),
            ops.fileLoads(cache, "s", "/repo/a.kt", "/repo", "a.kt").toList(),
        )
        assertNull(cache.file("s", "/repo/a.kt")?.diff)

        // A failure shows over the copy and leaves the cache alone.
        read = ReadFileResult(false, error = "gone")
        assertEquals(FileLoad.Failed("gone"), ops.fileLoads(cache, "s", "/repo/a.kt", "/repo", "a.kt").toList().last())
        assertEquals("c\n", cache.file("s", "/repo/a.kt")?.content)
        // Binary by extension caches as binary; a deleted session's files go.
        assertEquals(listOf(FileLoad.Binary), ops.fileLoads(cache, "s", "/repo/logo.png", "/repo", "logo.png").toList())
        assertTrue(cache.file("s", "/repo/logo.png")!!.isBinary)
        cache.forgetSession("s")
        assertNull(cache.file("s", "/repo/a.kt"))
    }
}
