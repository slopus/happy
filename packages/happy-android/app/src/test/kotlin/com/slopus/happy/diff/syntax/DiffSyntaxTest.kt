package com.slopus.happy.diff.syntax

import com.slopus.happy.diff.BuildOptions
import com.slopus.happy.diff.DiffBuilder
import com.slopus.happy.diff.DiffLineType
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.SyntaxRun
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** happy-app components/diff/syntax: plan.spec.ts and code.spec.ts. */
class DiffSyntaxTest {
    private val patch = listOf(
        "--- a/sample.ts", "+++ b/sample.ts", "@@ -1,3 +1,3 @@",
        " /* comment", "    still comment */", "-const count = 1;", "+const count = 2;",
        "@@ -20,1 +20,1 @@", "-const hidden = true;", "+const hidden = false;",
    ).joinToString("\n")

    @Before
    fun clear() = DiffBuilder.clearCache()

    @Test
    fun plansOnlyHunksOnScreenButWhole() {
        val file = DiffBuilder.fromPatch(patch).files[0]
        val plan = DiffSyntax.plan(file, listOf(file.rows[2]))
        assertEquals(1, plan.size)
        assertEquals(4, plan[0].input.lines.size)
        assertEquals("/* comment", plan[0].input.lines[0].first)
    }

    @Test
    fun overlaysColoursWithoutTouchingTextOrEmphasis() {
        val file = DiffBuilder.fromPatch(patch).files[0]
        val plan = DiffSyntax.plan(file, file.rows)
        val outcomes = plan.associate { it.input to DiffSyntax.tokenize(it.input) }
        val next = DiffSyntax.apply(file.rows, plan, outcomes)
        assertNotSame(file.rows, next)
        assertSame(file.rows[0], next[0])
        for (i in next.indices) {
            val row = next[i] as? DiffRow.Line ?: continue
            val original = file.rows[i] as DiffRow.Line
            assertEquals(row.text, row.spans.joinToString("") { it.text })
            fun expanded(row: DiffRow.Line) = row.spans.flatMap { span -> List(span.text.length) { span.emphasis } }
            assertEquals(expanded(original), expanded(row))
        }
        // The block comment's second line is coloured as a comment: the hunk kept its context.
        assertEquals(SpanKind.Comment, (next[2] as DiffRow.Line).spans.first().kind)
    }

    @Test
    fun leavesUnknownHugeAndColouredRowsAlone() {
        val file = DiffBuilder.fromPatch(patch).files[0]
        assertEquals(emptyList<DiffSyntax.Hunk>(), DiffSyntax.plan(file.copy(language = null), file.rows))
        val coloured = DiffBuilder.fromPatch(patch, BuildOptions(highlighter = PrismHighlighter)).files[0]
        assertEquals(emptyList<DiffSyntax.Hunk>(), DiffSyntax.plan(coloured, coloured.rows))
        val huge = DiffBuilder.fromPatch("--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1 @@\n+${"x".repeat(2001)}").files[0]
        assertEquals(emptyList<DiffSyntax.Hunk>(), DiffSyntax.plan(huge, huge.rows))
        assertSame(file.rows, DiffSyntax.apply(file.rows, DiffSyntax.plan(file, file.rows), emptyMap()))
    }

    @Test
    fun codeBlocksArePlannedWithinLimits() {
        val first = DiffSyntax.planCode("echo \"\$HOME\"\n", "bash")!!
        assertEquals(first, DiffSyntax.planCode("echo \"\$HOME\"\n", "bash"))
        assertTrue(first != DiffSyntax.planCode("echo \"\$HOME\"\n", "shell-session"))
        assertTrue(first.lines.all { it.second == DiffLineType.Ctx })
        for ((code, language) in listOf(
            "" to "bash", "echo hi" to null, "x".repeat(DiffSyntax.MAX_LINE + 1) to "bash",
            "\n".repeat(DiffSyntax.MAX_LINES) to "bash", "x".repeat(DiffSyntax.MAX_CHARACTERS + 1) to "bash",
        )) {
            assertNull(DiffSyntax.planCode(code, language))
        }
    }

    @Test
    fun codeSpansKeepTheTextExactly() {
        val code = "# comment\r\nprintf \"%s\\n\" \"🙂\"  \r\n\r\n"
        val input = DiffSyntax.planCode(code, "bash")!!
        val spans = DiffSyntax.codeSpans(input, DiffSyntax.tokenize(input))!!
        assertEquals(code, spans.joinToString("") { it.text })
        assertTrue(spans.any { it.kind != SpanKind.Plain })

        val heredoc = DiffSyntax.planCode("cat <<EOF\nhello \$USER\nEOF\n", "bash")!!
        val result = DiffSyntax.tokenize(heredoc)
        assertTrue(result.runs[1].any { it.kind == SpanKind.Str })
        assertEquals("cat <<EOF\nhello \$USER\nEOF\n", DiffSyntax.codeSpans(heredoc, result)!!.joinToString("") { it.text })
    }

    @Test
    fun shellSessionColoursCommandsNotOutput() {
        val input = DiffSyntax.planCode("\$ echo \"hello\"\nhello\nif 123 true\n", "shell-session")!!
        val result = DiffSyntax.tokenize(input)
        assertTrue(result.runs[0].any { it.kind == SpanKind.Str })
        assertTrue(result.runs.drop(1).flatten().all { it.kind == SpanKind.Plain })

        val plain = DiffSyntax.planCode("ordinary output\n", "shell-session")!!
        assertNull(DiffSyntax.codeSpans(plain, DiffSyntax.tokenize(plain)))
        assertNull(DiffSyntax.codeSpans(plain, null))
        val lines = List(DiffSyntax.MAX_CODE_SPANS) { "x" to DiffLineType.Ctx }
        val many = DiffSyntax.Result(DiffSyntax.Status.Highlighted, lines.map { listOf(SyntaxRun(SpanKind.Keyword, 1)) })
        assertNull(DiffSyntax.codeSpans(DiffSyntax.Input("bash", lines), many))
    }

    @Test(timeout = 60_000)
    fun serviceCachesResults() = runBlocking {
        val service = SyntaxService()
        val input = DiffSyntax.Input("typescript", listOf("const x = 1;" to DiffLineType.Add))
        assertNull(service.peek(input))
        val result = service.highlight(input)
        assertEquals(DiffSyntax.Status.Highlighted, result.status)
        assertSame(result, service.peek(input))
        assertEquals(DiffSyntax.Status.Unsupported, service.highlight(DiffSyntax.Input("cobol", listOf("x" to DiffLineType.Ctx))).status)
    }
}
