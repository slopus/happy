package com.slopus.happy.ui.files

import com.slopus.happy.model.GitFileStatus
import com.slopus.happy.model.GitFileStatusKind
import com.slopus.happy.model.GitStatusParser
import com.slopus.happy.model.GitStatusParser.FULL_FILE_CONTEXT
import com.slopus.happy.model.decodeGitPath
import com.slopus.happy.model.parseNumStat
import com.slopus.happy.model.parseStatusSummaryV2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * happy-app's git-parsers/gitPath.test.ts, utils/gitDiffCommand.spec.ts,
 * utils/imageFiles.spec.ts and sessionFileLinks.test.ts's
 * resolveSessionFilePath case, plus gitStatusFiles.ts's file list.
 */
class GitStatusFilesTest {
    private val escapedCyrillic = "\"\\320\\234\\320\\236\\320\\235\\320\\225\\320\\242\\320\\230\\320\\227\\320\\220\\320\\246\\320\\230\\320\\257.md\""

    @Test
    fun decodesQuotedUtf8OctalPaths() {
        assertEquals("МОНЕТИЗАЦИЯ.md", decodeGitPath(escapedCyrillic))
        assertEquals("packages/app/index.ts", decodeGitPath("packages/app/index.ts"))
        assertEquals(listOf("МОНЕТИЗАЦИЯ.md"), parseStatusSummaryV2("? $escapedCyrillic").notAdded)
        assertEquals("МОНЕТИЗАЦИЯ.md", parseNumStat("3\t1\t$escapedCyrillic").files.single().file)
        assertEquals("a\"b\tc", decodeGitPath("\"a\\\"b\\tc\""))
    }

    @Test
    fun parsesTheFileList() {
        val status = """
            # branch.oid 1234567
            # branch.head main
            1 M. N... 100644 100644 100644 abc123 def456 src/staged.ts
            1 .M N... 100644 100644 100644 abc123 def456 src/unstaged.ts
            1 MM N... 100644 100644 100644 abc123 def456 src/both.ts
            2 R. N... 100644 100644 100644 abc123 def456 R100 src/new.ts	src/old.ts
            1 .D N... 100644 100644 000000 abc123 def456 gone.ts
            ? notes/todo.md
        """.trimIndent()
        val numstat = "1\t2\tsrc/unstaged.ts\n3\t0\tsrc/both.ts\n0\t0\tgone.ts\n---STAGED---\n5\t1\tsrc/staged.ts\n2\t2\tsrc/both.ts\n-\t-\tsrc/new.ts\n"
        val files = GitStatusParser.parseFiles(status, numstat)
        assertEquals("main", files.branch)
        // parseStatusV2's RENAME_COPY_REGEX reads the field after the tab as the
        // path and the one before it as `from`, so the entry is keyed by the
        // second field even though git prints the new path first.
        assertEquals(listOf("src/staged.ts", "src/both.ts", "src/old.ts"), files.stagedFiles.map { it.fullPath })
        assertEquals(listOf("src/unstaged.ts", "src/both.ts", "gone.ts", "notes/todo.md"), files.unstagedFiles.map { it.fullPath })
        val staged = files.stagedFiles[0]
        assertEquals(GitFileStatus("staged.ts", "src", "src/staged.ts", GitFileStatusKind.Modified, true, 5, 1), staged)
        // A file with both kinds counts each side separately.
        assertEquals(2 to 2, files.stagedFiles[1].let { it.linesAdded to it.linesRemoved })
        assertEquals(3 to 0, files.unstagedFiles[1].let { it.linesAdded to it.linesRemoved })
        val renamed = files.stagedFiles[2]
        assertEquals(GitFileStatusKind.Renamed, renamed.status)
        assertEquals("src/new.ts", renamed.oldPath)
        assertEquals(GitFileStatusKind.Deleted, files.unstagedFiles[2].status)
        val untracked = files.unstagedFiles[3]
        assertEquals(GitFileStatus("todo.md", "notes", "notes/todo.md", GitFileStatusKind.Untracked, false, 0, 0), untracked)
        assertNull(GitStatusParser.parseFiles("# branch.head (detached)", "").branch)
    }

    @Test
    fun quotesShellPaths() {
        assertEquals("\"src/app.ts\"", GitStatusParser.quoteShellPath("src/app.ts"))
        assertEquals("\"src/say \\\"hi\\\".ts\"", GitStatusParser.quoteShellPath("src/say \"hi\".ts"))
        assertEquals("\"src/back\\\\slash.ts\"", GitStatusParser.quoteShellPath("src/back\\slash.ts"))
        assertEquals("\"src/\\\$HOME.ts\"", GitStatusParser.quoteShellPath("src/\$HOME.ts"))
        assertEquals("\"src/\\`whoami\\`.ts\"", GitStatusParser.quoteShellPath("src/`whoami`.ts"))
    }

    @Test
    fun buildsDiffCommands() {
        assertEquals("git -c core.quotepath=false diff HEAD --no-ext-diff -- \"src/app.ts\"", GitStatusParser.diffCommand("src/app.ts"))
        assertTrue(GitStatusParser.diffCommand("src/app.ts", contextLines = 25).contains("-U25"))
        assertTrue(GitStatusParser.diffCommand("src/app.ts", contextLines = FULL_FILE_CONTEXT).contains("-U$FULL_FILE_CONTEXT"))
        assertTrue(GitStatusParser.diffCommand("src/app.ts", contextLines = 0).contains("-U0"))
        assertTrue(GitStatusParser.diffCommand("src/app.ts", ignoreWhitespace = true).contains(" -w "))
        assertFalse(GitStatusParser.diffCommand("src/app.ts").contains("-w"))
        val both = GitStatusParser.diffCommand("src/app.ts", contextLines = 10, ignoreWhitespace = true)
        assertTrue(both.contains("-U10") && both.contains("-w") && both.endsWith("-- \"src/app.ts\""))
        assertEquals("git -c core.quotepath=false show HEAD:\"assets/logo.png\" | base64", GitStatusParser.showBase64Command("assets/logo.png"))
    }

    @Test
    fun imageFiles() {
        assertEquals("image/png", ImageFiles.mimeType("assets/logo.png"))
        assertEquals("image/jpeg", ImageFiles.mimeType("a/b/photo.JPG"))
        assertEquals("image/gif", ImageFiles.mimeType("anim.gif"))
        assertEquals("image/webp", ImageFiles.mimeType("hero.webp"))
        assertNull(ImageFiles.mimeType("icons/close.svg"))
        assertNull(ImageFiles.mimeType("Makefile"))
        assertNull(ImageFiles.mimeType("src/png"))
        assertNull(ImageFiles.mimeType("archive.png.bak"))
        assertTrue(ImageFiles.isImage("a.png"))
        assertFalse(ImageFiles.isImage("a.ts"))
        assertEquals("data:image/png;base64,AAAA", ImageFiles.dataUri("logo.png", "AAAA"))
        assertEquals("data:image/png;base64,AAAABBBB", ImageFiles.dataUri("logo.png", "AAAA\nBBBB\n"))
        assertNull(ImageFiles.dataUri("logo.png", ""))
        assertNull(ImageFiles.dataUri("logo.png", "\n  \n"))
        assertNull(ImageFiles.dataUri("notes.txt", "AAAA"))
    }

    @Test
    fun resolvesSessionPaths() {
        val root = "/Users/kirilldubovitskiy/projects/happy"
        assertEquals(
            SessionFileLink("packages/happy-app/README.md", "$root/packages/happy-app/README.md", "packages/happy-app/README.md", true, null, null),
            SessionFilePaths.resolve("packages/happy-app/README.md", root),
        )
        val absolute = SessionFilePaths.resolve("$root/packages/happy-cli/src/codex/runCodex.ts:594", root)!!
        assertEquals("packages/happy-cli/src/codex/runCodex.ts", absolute.relativePath)
        assertEquals(594, absolute.line)
        val outside = SessionFilePaths.resolve("/etc/hosts", root)!!
        assertFalse(outside.withinSessionRoot)
        assertNull(outside.relativePath)
        assertEquals("$root/b.ts", SessionFilePaths.resolve("./a/../b.ts", root)!!.absolutePath)
        assertEquals("/Users/kirilldubovitskiy/x.ts", SessionFilePaths.resolve("~/x.ts", root)!!.absolutePath)
        assertNull(SessionFilePaths.resolve("relative.ts", null))
    }

    @Test
    fun fileViewerLanguagesAndBinaries() {
        assertEquals("typescript", fileLanguage("a/b.tsx"))
        assertEquals("kotlin", fileLanguage("Main.kt"))
        assertNull(fileLanguage("Makefile"))
        assertTrue(isBinaryPath("logo.PNG"))
        assertTrue(isBinaryPath("icon.svg"))
        assertFalse(isBinaryPath("src/a.ts"))
        assertFalse(isBinaryPath("Makefile"))
    }

    @Test
    fun countsBlobLines() {
        assertEquals(0, countLines(""))
        assertEquals(1, countLines("a"))
        assertEquals(1, countLines("a\n"))
        assertEquals(2, countLines("a\nb"))
    }
}
