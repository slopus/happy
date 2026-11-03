package com.slopus.happy.diff

import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.diff.MarkdownDiff.Entry
import com.slopus.happy.diff.MarkdownDiff.Row
import com.slopus.happy.diff.MarkdownDiff.WordChange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** desktop fdd502ce `markdownDiffModel.ts` and `markdownDiffTree.ts`: blocks aligned, paired, diffed by word, long runs folded. */
class MarkdownDiffTest {
    private fun kinds(diff: MarkdownDiff) = diff.blocks.map { it::class.simpleName }

    @Test fun `the same document is no change and folds nothing`() {
        val doc = "# Title\n\nOne.\n\nTwo.\n\nThree.\n\nFour."
        val diff = MarkdownDiff.compute(doc, doc)
        assertFalse(diff.changed)
        assertTrue(diff.blocks.all { it is Entry.Same })
        assertTrue(MarkdownDiff.rows(diff).all { it is Row.Block })
    }

    @Test fun `space that doesn't show is no change`() {
        assertFalse(MarkdownDiff.compute("Hello   world.", "Hello world.").changed)
    }

    @Test fun `an edited paragraph is diffed word by word`() {
        val diff = MarkdownDiff.compute("The quick brown fox jumps.", "The quick red fox jumps.")
        val changed = diff.blocks.single() as Entry.Changed
        assertEquals(listOf("brown"), changed.spans.filter { it.change == WordChange.Deleted }.map { it.span.text })
        assertEquals(listOf("red"), changed.spans.filter { it.change == WordChange.Inserted }.map { it.span.text })
        assertEquals("The quick red fox jumps.", changed.spans.filter { it.change != WordChange.Deleted }.joinToString("") { it.span.text })
    }

    @Test fun `a paragraph rewritten past the pairing threshold is a removal and an addition`() {
        val diff = MarkdownDiff.compute("Alpha beta gamma delta.", "Something else entirely here.")
        assertEquals(listOf("Removed", "Added"), kinds(diff))
    }

    @Test fun `blocks of different kinds never pair`() {
        val diff = MarkdownDiff.compute("Install the app", "# Install the app")
        assertEquals(listOf("Removed", "Added"), kinds(diff))
    }

    @Test fun `a list is aligned item by item`() {
        val diff = MarkdownDiff.compute("- one\n- two\n- three", "- one\n- two\n- two and a half\n- three")
        assertEquals(listOf("Same", "Same", "Added", "Same"), kinds(diff))
        val added = (diff.blocks[2] as Entry.Added).block as MarkdownBlock.BulletList
        assertEquals("two and a half", added.items.single().spans.joinToString("") { it.text })
    }

    @Test fun `similarity is Dice over words`() {
        val a = MarkdownBlock.Text(listOf(com.slopus.happy.chat.markdown.MarkdownSpan(emptySet(), "a b c d")))
        val b = MarkdownBlock.Text(listOf(com.slopus.happy.chat.markdown.MarkdownSpan(emptySet(), "a b x y")))
        assertEquals(0.5, MarkdownDiff.similarity(a, b), 1e-9)
        assertEquals(1.0, MarkdownDiff.similarity(a, a), 1e-9)
    }

    @Test fun `a long unchanged run folds past two blocks of context and opens when expanded`() {
        val old = (1..8).joinToString("\n\n") { "Paragraph $it." }
        val new = old.replace("Paragraph 8.", "Paragraph eight.")
        val diff = MarkdownDiff.compute(old, new)
        val rows = MarkdownDiff.rows(diff)
        // Seven unchanged before the change: the last two stay as context, five fold.
        assertEquals(Row.Fold(0, 5), rows.first())
        assertEquals(listOf(5, 6), rows.filterIsInstance<Row.Block>().dropLast(1).map { it.index })
        val open = MarkdownDiff.rows(diff, expanded = setOf(0))
        assertEquals(diff.blocks.size, open.size)
        assertTrue(open.all { it is Row.Block })
    }

    @Test fun `a run between changes folds only what lies past both contexts, and never a single block`() {
        val old = (1..7).joinToString("\n\n") { "Paragraph $it." }
        val five = MarkdownDiff.compute(old, old.replace("Paragraph 1.", "Paragraph one.").replace("Paragraph 7.", "Paragraph seven."))
        // Five unchanged between: two each side leave one, which shows rather than folds.
        assertTrue(MarkdownDiff.rows(five).none { it is Row.Fold })
        val longer = (1..8).joinToString("\n\n") { "Paragraph $it." }
        val six = MarkdownDiff.compute(longer, longer.replace("Paragraph 1.", "Paragraph one.").replace("Paragraph 8.", "Paragraph eight."))
        assertEquals(listOf(Row.Fold(3, 2)), MarkdownDiff.rows(six).filterIsInstance<Row.Fold>())
    }
}
