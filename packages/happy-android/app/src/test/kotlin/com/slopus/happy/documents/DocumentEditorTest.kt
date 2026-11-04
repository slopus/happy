package com.slopus.happy.documents

import com.slopus.happy.documents.DocumentFixtures.bytes
import com.slopus.happy.documents.DocumentFixtures.document
import com.slopus.happy.documents.DocumentFixtures.editor
import com.slopus.happy.documents.DocumentFixtures.fixture
import com.slopus.happy.documents.DocumentFixtures.replay
import com.slopus.happy.documents.DocumentFixtures.string
import com.slopus.happy.documents.yjs.YAny
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Editing writes the Yjs structure BlockNote reads, only the difference, and
 * concurrent edits from other replicas merge without losing either (iOS's
 * `DocumentEditorTests`).
 */
class DocumentEditorTest {
    private val bold = mapOf<String, YAny>("bold" to YAny.Object(emptyList()))

    @Test
    fun openingAndWritingBackChangesNothing() {
        for (f in DocumentFixtures.documents) {
            val name = string(f["name"])!!
            val (editor, box) = editor(bytes(f["update"]))
            val markdown = DocumentMarkdown.markdown(editor.blocks)
            editor.reconcile(editor.blocks)
            for (line in editor.lines) if (line.block.isInline) editor.setRuns(line.id, line.block.runs)
            editor.replaceLines(editor.lines.indices, editor.lines)
            assertEquals(name, 0, box.updates.size)
            assertEquals(name, markdown, DocumentMarkdown.markdown(editor.blocks))
            assertEquals(name, string(f["markdown"]), DocumentMarkdown.markdown(editor.blocks))
        }
    }

    @Test
    fun typingWritesOnlyTheNewText() {
        val base = fixture("desktop-short")
        val (editor, box) = editor(base)
        val line = editor.lines[1]
        val runs = line.block.runs.toMutableList()
        runs[0] = runs[0].copy(text = "Really, " + runs[0].text)
        editor.setRuns(line.id, runs)
        assertEquals(1, box.updates.size)
        assertTrue("one insert, not the paragraph again", box.updates[0].size < 40)
        assertEquals("Really, Two pa", editor.lines[1].block.plainText.take(14))
        assertEquals(editor.blocks, replay(base, box.updates))
        assertEquals(1..1, box.changes.last().range)
        assertEquals(true, box.changes.last().local)
    }

    @Test
    fun formattingARangeSetsFormatsOnly() {
        val base = fixture("desktop-short")
        val (editor, box) = editor(base)
        val line = editor.lines[1]
        val text = line.block.plainText
        val runs = listOf(DocumentRun(text.take(3), bold), DocumentRun(text.drop(3)))
        editor.setRuns(line.id, runs)
        assertEquals(runs, editor.lines[1].block.runs)
        assertEquals(text, editor.lines[1].block.plainText)
        assertEquals(editor.blocks, replay(base, box.updates))
        assertTrue(DocumentMarkdown.markdown(editor.blocks).contains("**Two** paragraphs"))
        // And off again.
        editor.setRuns(line.id, listOf(DocumentRun(text)))
        assertEquals(listOf(DocumentRun(text)), editor.lines[1].block.runs)
        assertEquals(editor.blocks, replay(base, box.updates))
    }

    @Test
    fun hardBreaksBecomeHardBreakElements() {
        val base = fixture("desktop-short")
        val (editor, box) = editor(base)
        val id = editor.lines[1].id
        editor.setRuns(id, listOf(DocumentRun("Line one\nline two")))
        assertEquals(listOf(DocumentRun("Line one\nline two")), editor.lines[1].block.runs)
        assertTrue(DocumentMarkdown.markdown(editor.blocks).contains("Line one\\\nline two"))
        editor.setRuns(id, listOf(DocumentRun("Line oneline two")))
        assertEquals("Line oneline two", editor.lines[1].block.plainText)
        assertEquals(editor.blocks, replay(base, box.updates))
    }

    @Test
    fun splittingJoiningAndRetypingBlocks() {
        val base = fixture("desktop-short")
        val (editor, box) = editor(base)
        val line = editor.lines[1]
        // Enter after "Two paragraphs".
        val head = line.copy(block = line.block.copy(content = DocumentBlock.Content.Inline(listOf(DocumentRun("Two paragraphs")))))
        val tail = DocumentLine(DocumentBlock("new-block", "paragraph", content = DocumentBlock.Content.Inline(listOf(DocumentRun(line.block.plainText.drop(14))))))
        editor.replaceLines(1..1, listOf(head, tail))
        assertEquals(listOf(line.id, "new-block"), editor.lines.map { it.id }.subList(1, 3))
        assertEquals(editor.blocks, replay(base, box.updates))
        // A heading, then a check item ticked.
        editor.setType("new-block", "heading", mapOf("level" to YAny.Number(2.0)))
        assertEquals("heading", editor.line("new-block")?.block?.type)
        assertEquals(2, editor.line("new-block")?.block?.level)
        editor.setType("new-block", "checkListItem")
        editor.toggleChecked("new-block")
        assertEquals(true, editor.line("new-block")?.block?.checked)
        // Backspace at its start joins it onto the line above.
        val index = editor.lineIndex("new-block")!!
        val above = editor.lines[index - 1]
        val joined = above.copy(block = above.block.copy(content = DocumentBlock.Content.Inline(above.block.runs + editor.lines[index].block.runs)))
        editor.replaceLines((index - 1)..index, listOf(joined))
        assertNull(editor.line("new-block"))
        assertEquals(line.block.plainText, editor.lines[1].block.plainText)
        assertEquals(editor.blocks, replay(base, box.updates))
    }

    @Test
    fun indentingMakesAChildAndOutdentingBringsItBack() {
        val base = fixture("desktop-short")
        val (editor, box) = editor(base)
        val items = editor.lines.indices.filter { editor.lines[it].block.type == "numberedListItem" }
        assertEquals(3, items.size)
        val second = editor.lines[items[1]].copy(depth = 1)
        editor.replaceLines(items[1]..items[1], listOf(second))
        assertEquals(editor.lines[items[2]].id, editor.blocks.last { it.type == "numberedListItem" }.id)
        val parent = editor.blocks.first { it.id == editor.lines[items[0]].id }
        assertEquals(listOf(second.id), parent.children.map { it.id })
        assertTrue(DocumentMarkdown.markdown(editor.blocks).contains("1. Files open inside Happy\n   1. Markdown renders\n2. Chat links"))
        editor.replaceLines(items[1]..items[1], listOf(second.copy(depth = 0)))
        assertEquals(string(document("desktop-short")["markdown"]), DocumentMarkdown.markdown(editor.blocks))
        assertEquals(editor.blocks, replay(base, box.updates))
    }

    @Test
    fun remoteEditsArriveAsTheLinesTheyChange() {
        val base = fixture("desktop-short")
        val (mine, myBox) = editor(base, client = 10)
        val (theirs, theirBox) = editor(base, client = 20)
        // Both type in the same paragraph at once.
        val id = mine.lines[1].id
        mine.setRuns(id, listOf(DocumentRun("Mine. ")) + mine.lines[1].block.runs)
        theirs.setRuns(id, theirs.lines[1].block.runs + DocumentRun(" Theirs."))
        myBox.changes.clear()
        theirBox.updates.forEach(mine::applyRemote)
        myBox.updates.forEach(theirs::applyRemote)
        assertEquals(theirs.blocks, mine.blocks)
        assertTrue(mine.lines[1].block.plainText.startsWith("Mine. Two"))
        assertTrue(mine.lines[1].block.plainText.endsWith("dragged to. Theirs."))
        assertEquals(listOf(1..1), myBox.changes.map { it.range })
        assertEquals(false, myBox.changes.first().local)
    }

    @Test
    fun concurrentStructureEditsConverge() {
        val base = fixture("blocks")
        val (a, boxA) = editor(base, client = 1)
        val (b, boxB) = editor(base, client = 2)
        // A deletes the third line; B types in it and ticks a box elsewhere.
        a.replaceLines(2..2, emptyList())
        b.setRuns(b.lines[2].id, listOf(DocumentRun("Third, edited")))
        val check = b.lines.first { it.block.type == "checkListItem" }.id
        b.toggleChecked(check)
        // A turns the first heading into a quote while B renames it.
        a.setType(a.lines[0].id, "quote")
        b.setRuns(b.lines[0].id, listOf(DocumentRun("Renamed")))
        boxB.updates.forEach(a::applyRemote)
        boxA.updates.forEach(b::applyRemote)
        assertEquals(b.blocks, a.blocks)
        val before = DocumentEditor.flatten(replay(base, emptyList())).first { it.id == check }.block.checked
        assertEquals(!before, a.line(check)?.block?.checked)
    }

    @Test
    fun unsupportedBlocksAreNeverWrittenOver() {
        val base = fixture("outside-model")
        val (editor, box) = editor(base)
        val unsupported = DocumentBlock.Content.Unsupported("futureBlock")
        assertEquals(unsupported, editor.lines.last().block.content)
        val lines = editor.lines.toMutableList()
        lines[0] = lines[0].copy(block = lines[0].block.copy(content = DocumentBlock.Content.Inline(listOf(DocumentRun("Kept, edited")))))
        editor.replaceLines(lines.indices, lines)
        assertEquals(unsupported, editor.lines.last().block.content)
        assertEquals(unsupported, replay(base, box.updates).last().content)
    }
}
