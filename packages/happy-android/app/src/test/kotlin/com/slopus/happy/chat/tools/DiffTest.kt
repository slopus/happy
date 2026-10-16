package com.slopus.happy.chat.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ports of buildDiff.spec.ts / layout.spec.ts cases the chat relies on. */
class DiffTest {
    private fun lines(file: DiffFile) = file.rows.filterIsInstance<DiffRow.Line>()

    @Test
    fun contentsDiffKeepsThreeLinesOfContext() {
        val old = (1..20).joinToString("\n") { "line $it" }
        val new = old.replace("line 10", "line ten")
        val file = buildDiffFromContents("a.txt", old, new)
        val rows = lines(file)
        assertEquals(8, rows.size)
        assertEquals(listOf(7, 8, 9), rows.take(3).map { it.oldNo })
        assertEquals(DiffLineType.Del to "line 10", rows[3].type to rows[3].text)
        assertEquals(DiffLineType.Add to "line ten", rows[4].type to rows[4].text)
        assertEquals(10, rows[4].newNo)
        assertEquals(1 to 1, file.additions to file.deletions)
        val hunk = file.rows.first() as DiffRow.Hunk
        assertEquals("@@ -7,7 +7,7 @@", hunk.text)
        assertEquals(6, hunk.hidden)
    }

    @Test
    fun aNewFileIsAllAdditions() {
        val file = buildDiffFromContents("a.kt", "", "a\nb\n")
        assertEquals(FileChangeKind.Added, file.kind)
        assertEquals(listOf(DiffLineType.Add, DiffLineType.Add), lines(file).map { it.type })
        assertEquals(2, file.maxLineNo)
    }

    @Test
    fun identicalTextsSayNoChanges() {
        val file = buildDiffFromContents("a", "same", "same")
        assertEquals(listOf<DiffRow>(DiffRow.Message("empty", binary = false)), file.rows)
    }

    @Test
    fun lineDiffIsMinimal() {
        val ops = lineDiff(listOf("a", "b", "c", "d"), listOf("a", "x", "c", "d", "e"))
        assertEquals(
            listOf(DiffLineType.Ctx, DiffLineType.Del, DiffLineType.Add, DiffLineType.Ctx, DiffLineType.Ctx, DiffLineType.Add),
            ops,
        )
        assertEquals(2 to 1, countContentStats("a\nb\nc\nd", "a\nx\nc\nd\ne"))
    }

    @Test
    fun unifiedPatchWithGitHeaders() {
        val patch = """
            diff --git a/src/app.ts b/src/app.ts
            index 1..2 100644
            --- a/src/app.ts
            +++ b/src/app.ts
            @@ -1,3 +1,3 @@ function main
             one
            -two
            +2
             three
            \ No newline at end of file
        """.trimIndent()
        val files = buildDiffFromPatch(patch)
        assertEquals(1, files.size)
        val file = files[0]
        assertEquals("src/app.ts", file.path)
        assertEquals("function main", (file.rows[0] as DiffRow.Hunk).section)
        assertEquals(4, lines(file).size)
        assertEquals(1 to 1, countPatchStats(patch))
    }

    @Test
    fun aBareHunkGetsHeaders() {
        val patch = materializeUnifiedDiffPatch("@@ -0,0 +1 @@\n+x", "b.ts", "add")
        val file = buildDiffFromPatch(patch).single()
        assertEquals(FileChangeKind.Added, file.kind)
        assertEquals("b.ts", file.path)
    }

    @Test
    fun collapseNeverCutsAChangeRun() {
        val rows = (0 until 100).map { DiffRow.Line("$it", if (it in 78..85) DiffLineType.Add else DiffLineType.Ctx, null, it, "x") }
        val (visible, hidden) = selectVisibleRows(rows, showHunkHeaders = true, expanded = false, collapseAfter = 80)
        assertEquals(86, visible.size)
        assertEquals(14, hidden)
        assertTrue(selectVisibleRows(rows, true, expanded = true, collapseAfter = 80).second == 0)
    }
}
