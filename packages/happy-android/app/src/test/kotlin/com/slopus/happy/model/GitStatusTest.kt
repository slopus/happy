package com.slopus.happy.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * gitStatusSync.ts parseGitStatusV2 and the git-parsers it uses: porcelain
 * v2 headers give the branch (none when detached or before the first
 * commit), the upstream and ahead/behind, and the stash; changed, renamed,
 * unmerged and untracked lines are counted as categorizeFileV2 does;
 * numstat counts binary files as 0; quoted paths decode their octal UTF-8
 * (gitPath.test.ts); totals add staged and unstaged.
 */
class GitStatusTest {
    private val escapedCyrillic = "\"\\320\\234\\320\\236\\320\\235\\320\\225\\320\\242\\320\\230\\320\\227\\320\\220\\320\\246\\320\\230\\320\\257.md\""

    @Test fun quotedPathsDecodeAndPlainOnesStay() {
        assertEquals("МОНЕТИЗАЦИЯ.md", decodeGitPath(escapedCyrillic))
        assertEquals("packages/app/index.ts", decodeGitPath("packages/app/index.ts"))
        assertEquals("a\tb\"c\\d", decodeGitPath("\"a\\tb\\\"c\\\\d\""))
        assertEquals(listOf("МОНЕТИЗАЦИЯ.md"), parseStatusSummaryV2("? $escapedCyrillic").notAdded)
        assertEquals("МОНЕТИЗАЦИЯ.md", parseNumStat("3\t1\t$escapedCyrillic").files.single().file)
    }

    @Test fun porcelainV2LinesAreCategorized() {
        val output = """
            # branch.oid 0123abcd
            # branch.head feature/x
            # branch.upstream origin/feature/x
            # branch.ab +2 -1
            # stash 3
            1 M. N... 100644 100644 100644 aaaa bbbb src/staged.ts
            1 .M N... 100644 100644 100644 aaaa bbbb src/edited.ts
            1 A. N... 000000 100644 100644 0000 bbbb src/new.ts
            1 .D N... 100644 100644 000000 aaaa bbbb src/gone.ts
            2 R. N... 100644 100644 100644 aaaa bbbb R100 src/to.ts	src/from.ts
            u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts
            ? notes.txt
            ! build/out.js
        """.trimIndent()
        val summary = parseStatusSummaryV2(output)
        assertEquals(6, summary.files.size)
        // parseRenameCopy reads the field before the tab as `from`; the counts don't care which side is which.
        val rename = summary.files.single { it.from != null }
        assertEquals(setOf("src/to.ts", "src/from.ts"), setOf(rename.path, rename.from))
        assertEquals(listOf("src/staged.ts", "src/new.ts", rename.path, "src/conflict.ts"), summary.staged)
        assertEquals(listOf("src/staged.ts", "src/edited.ts"), summary.modified)
        assertEquals(listOf("src/new.ts"), summary.created)
        assertEquals(listOf("src/gone.ts"), summary.deleted)
        assertEquals(listOf(rename.path), summary.renamed)
        assertEquals(listOf("src/conflict.ts"), summary.conflicted)
        assertEquals(listOf("notes.txt"), summary.notAdded)
        assertEquals(listOf("build/out.js"), summary.ignored)
        assertEquals(GitBranchInfo("0123abcd", "feature/x", "origin/feature/x", 2, 1), summary.branch)
        assertEquals(3, summary.stashCount)
    }

    @Test fun numstatCountsBinaryFilesAsNothing() {
        val diff = parseNumStat("10\t2\ta.ts\n-\t-\timage.png\n\nnot a numstat line\n")
        assertEquals(listOf("a.ts", "image.png"), diff.files.map { it.file })
        assertTrue(diff.files[1].binary)
        assertEquals(10L, diff.insertions)
        assertEquals(2L, diff.deletions)
    }

    @Test fun theStatusAddsStagedAndUnstagedLines() {
        val status = parseGitStatus(
            "# branch.head main\n# branch.upstream origin/main\n1 .M N... 100644 100644 100644 a b x.ts\n? y.ts",
            unstagedNumStat = "4\t1\tx.ts",
            stagedNumStat = "7\t0\tz.ts",
            now = 42,
        )
        assertEquals("main", status.branch)
        assertTrue(status.isDirty)
        assertEquals(1, status.modifiedCount)
        assertEquals(1, status.untrackedCount)
        assertEquals(0, status.stagedCount)
        assertEquals(4L, status.unstagedLinesAdded)
        assertEquals(7L, status.stagedLinesAdded)
        assertEquals(11L, status.linesAdded)
        assertEquals(1L, status.linesRemoved)
        assertEquals(12L, status.linesChanged)
        assertEquals("origin/main", status.upstreamBranch)
        assertEquals("tracking without branch.ab is level", 0, status.aheadCount)
        assertEquals(0, status.behindCount)
        assertEquals(42L, status.lastUpdatedAt)
    }

    @Test fun aDetachedOrUnbornHeadHasNoBranchAndNoTracking() {
        val detached = parseGitStatus("# branch.oid abc\n# branch.head (detached)", "", "", 0)
        assertNull(detached.branch)
        assertFalse(detached.isDirty)
        assertNull(detached.aheadCount)
        assertNull(parseGitStatus("# branch.head (initial)", "", "", 0).branch)
    }

    @Test fun theCheckoutKeyNeedsAMachineAndAPath() {
        assertEquals("m1:/repo", gitStatusKey("m1", "/repo"))
        assertNull(gitStatusKey(null, "/repo"))
        assertNull(gitStatusKey("m1", ""))
    }
}
