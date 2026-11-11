package com.slopus.happy.ui.chat

import com.slopus.happy.diff.syntax.DiffSyntax
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A code block's texts: chunked, coloured in place only when short, and plain past DiffSyntax's limits. */
class CodeHighlightTest {
    private val colors = LightChatColors

    private fun kotlin(lines: Int) = (0 until lines).joinToString("\n") { "fun f$it(x: Int) = listOf(x, $it) // line $it" }

    @Before
    fun clear() = HighlightCache.clear()

    @Test
    fun chunksHoldFiftyLinesAndJoinBackToTheCode() {
        val code = kotlin(120)
        val chunks = highlightChunks(code, "kotlin", colors, CODE_CHUNK_LINES)
        assertEquals(listOf(50, 50, 20), chunks.map { it.text.lines().size })
        assertEquals(code, chunks.joinToString("\n") { it.text })
        assertEquals(code, plainCode(code).joinToString("\n") { it.text })
        // Neighbours drawn alike share a span: Compose merges a text's spans pairwise.
        assertTrue(chunks.sumOf { it.spanStyles.size } < com.slopus.happy.chat.markdown.tokenizeCode(code, "kotlin").size * 4 / 5)
    }

    @Test
    fun aShortBlockIsReadyALongOneWaitsAndOnePastTheLimitsIsPlain() {
        assertNotNull(HighlightCache.ready(kotlin(CODE_INLINE_LINES), "kotlin", colors))
        assertNull(HighlightCache.ready(kotlin(CODE_INLINE_LINES + 1), "kotlin", colors))
        HighlightCache.get(kotlin(CODE_INLINE_LINES + 1), "kotlin", colors)
        assertNotNull(HighlightCache.ready(kotlin(CODE_INLINE_LINES + 1), "kotlin", colors))
        assertEquals(2, HighlightCache.misses)
        assertTrue(HighlightCache.ready(kotlin(DiffSyntax.MAX_LINES + 1), "kotlin", colors)!!.all { it.spanStyles.isEmpty() })
        assertEquals(2, HighlightCache.misses)
    }
}
