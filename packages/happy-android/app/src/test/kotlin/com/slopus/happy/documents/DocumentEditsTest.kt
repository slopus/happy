package com.slopus.happy.documents

import com.slopus.happy.documents.yjs.YAny
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Enter, Backspace, Tab and Markdown shortcuts as BlockNote makes them (iOS's `DocumentEditsTests`). */
class DocumentEditsTest {
    private fun line(type: String, text: String, depth: Int = 0, id: String? = null, props: Map<String, YAny> = emptyMap()) =
        DocumentLine(DocumentBlock(id ?: text, type, props, DocumentBlock.Content.Inline(if (text.isEmpty()) emptyList() else listOf(DocumentRun(text)))), depth)

    private fun mark(name: String) = mapOf<String, YAny>(name to YAny.Object(emptyList()))

    private fun <T> List<T>.replacing(range: IntRange, with: List<T>) = subList(0, range.first) + with + subList(range.last + 1, size)

    @Test
    fun enterSplitsAndCarriesTheListType() {
        val lines = listOf(line("checkListItem", "Buy milk", props = mapOf("checked" to YAny.Bool(true))))
        val result = DocumentEdits.enter(lines, 0, 3, newID = "n")!!
        assertEquals(0..0, result.range)
        assertEquals(listOf("Buy", " milk"), result.lines.map { it.block.plainText })
        assertEquals(listOf("checkListItem", "checkListItem"), result.lines.map { it.block.type })
        assertEquals("the first half keeps the block", "Buy milk", result.lines[0].id)
        assertEquals("n", result.lines[1].id)
        assertEquals("a new task starts open", false, result.lines[1].block.checked)
        assertEquals(1, result.caretLine)
    }

    @Test
    fun enterAfterAHeadingStartsAParagraph() {
        val lines = listOf(line("heading", "Title", props = mapOf("level" to YAny.Number(2.0))))
        val result = DocumentEdits.enter(lines, 0, 5, newID = "n")!!
        assertEquals(listOf("heading", "paragraph"), result.lines.map { it.block.type })
        assertEquals(emptyMap<String, YAny>(), result.lines[1].block.props)
    }

    @Test
    fun enterAtTheStartPutsTheNewLineAbove() {
        val result = DocumentEdits.enter(listOf(line("paragraph", "Text")), 0, 0, newID = "n")!!
        assertTrue(result.range.isEmpty())
        assertEquals(0, result.range.first)
        assertEquals(listOf("n"), result.lines.map { it.id })
        assertEquals(1, result.caretLine)
    }

    @Test
    fun enterInAnEmptyItemLiftsItOut() {
        val nested = listOf(line("bulletListItem", "a"), line("paragraph", "", depth = 1, id = "e"))
        assertEquals(0, DocumentEdits.enter(nested, 1, 0)?.lines?.first()?.depth)
        val lifted = DocumentEdits.enter(listOf(line("bulletListItem", "", id = "e")), 0, 0)!!
        assertEquals(listOf("paragraph"), lifted.lines.map { it.block.type })
        assertEquals("e", lifted.lines[0].id)
    }

    @Test
    fun backspaceAtTheStartUnformatsThenJoins() {
        val lines = listOf(line("paragraph", "One"), line("bulletListItem", "Two"))
        val unformatted = DocumentEdits.backspaceAtStart(lines, 1)!!
        assertEquals(listOf("paragraph"), unformatted.lines.map { it.block.type })
        val after = lines.replacing(unformatted.range, unformatted.lines)
        val joined = DocumentEdits.backspaceAtStart(after, 1)!!
        assertEquals(0..1, joined.range)
        assertEquals(listOf("OneTwo"), joined.lines.map { it.block.plainText })
        assertEquals("One", joined.lines[0].id)
        assertEquals(3, joined.caretOffset)
    }

    @Test
    fun indentTakesChildrenAlongAndOutdentAdoptsSiblings() {
        val lines = listOf(line("bulletListItem", "a"), line("bulletListItem", "b"), line("bulletListItem", "c", depth = 1), line("bulletListItem", "d"))
        val indented = DocumentEdits.indent(lines, 1..1, caret = 0)!!
        assertEquals(1..2, indented.range)
        assertEquals(listOf(1, 2), indented.lines.map { it.depth })
        assertNull("nothing above to go under", DocumentEdits.indent(lines, 0..0, caret = 0))
        val flat = listOf(line("bulletListItem", "a"), line("bulletListItem", "b", depth = 1), line("bulletListItem", "c", depth = 1))
        val outdented = DocumentEdits.outdent(flat, 1..1, caret = 0)!!
        assertEquals(1..1, outdented.range)
        val all = flat.replacing(outdented.range, outdented.lines)
        assertEquals("c is now b's child", listOf(0, 0, 1), all.map { it.depth })
        val tree = DocumentEditor.tree(all)
        assertEquals(listOf("a", "b"), tree.map { it.id })
        assertEquals(listOf("c"), tree[1].children.map { it.id })
    }

    @Test
    fun marksToggleOverARange() {
        val runs = listOf(DocumentRun("hello world"))
        val bold = DocumentEdits.toggling(runs, "bold", 0, 5)
        assertEquals(listOf(DocumentRun("hello", mark("bold")), DocumentRun(" world")), bold)
        assertTrue(DocumentEdits.has(bold, "bold", 1, 3))
        assertFalse(DocumentEdits.has(bold, "bold", 3, 7))
        assertEquals(runs, DocumentEdits.toggling(bold, "bold", 0, 5))
        assertEquals("code drops the other marks", listOf(DocumentRun("hello world", mark("code"))), DocumentEdits.toggling(bold, "code", 0, 11))
    }

    @Test
    fun typingAfterALinkDoesNotExtendIt() {
        val link = mapOf<String, YAny>("link" to YAny.Object(listOf("href" to YAny.Str("https://happy.engineering"))))
        val runs = listOf(DocumentRun("see "), DocumentRun("here", link))
        assertEquals(listOf(DocumentRun("see "), DocumentRun("here", link), DocumentRun("!")), DocumentEdits.typing(runs, "!", 8, 8))
        assertEquals(listOf(DocumentRun("see "), DocumentRun("heere", link)), DocumentEdits.typing(runs, "e", 6, 6))
    }

    @Test
    fun blockShortcuts() {
        fun shortcut(text: String, type: String = "paragraph") = DocumentShortcuts.block(line(type, text), text.length)
        fun type(type: String, remove: Int, props: Map<String, YAny> = emptyMap()) = DocumentShortcuts.Block.Type(type, props, remove)
        assertEquals(type("heading", 2, mapOf("level" to YAny.Number(1.0))), shortcut("# "))
        assertEquals(type("heading", 4, mapOf("level" to YAny.Number(3.0))), shortcut("### "))
        assertEquals(type("heading", 3, mapOf("level" to YAny.Number(2.0))), shortcut("## ", "heading"))
        assertEquals(type("bulletListItem", 2), shortcut("- "))
        assertEquals(type("bulletListItem", 2), shortcut("* "))
        assertEquals(type("numberedListItem", 3), shortcut("1. "))
        assertEquals(type("numberedListItem", 3, mapOf("start" to YAny.Number(4.0))), shortcut("4. "))
        assertEquals(type("checkListItem", 3, mapOf("checked" to YAny.Bool(false))), shortcut("[] "))
        assertEquals(type("checkListItem", 4, mapOf("checked" to YAny.Bool(false))), shortcut("[ ] "))
        assertEquals(type("checkListItem", 4, mapOf("checked" to YAny.Bool(true))), shortcut("[x] "))
        assertEquals(type("quote", 2), shortcut("> "))
        assertEquals(type("codeBlock", 9, mapOf("language" to YAny.Str("swift"))), shortcut("```swift "))
        assertEquals(DocumentShortcuts.Block.Divider, shortcut("---"))
        assertNull(shortcut("a - "))
        assertNull(shortcut("- ", "bulletListItem"))
        assertNull(shortcut("#hashtag "))
        assertNull(shortcut("- ", "codeBlock"))
    }

    @Test
    fun inlineShortcutsCloseAsTyped() {
        fun close(text: String) = DocumentShortcuts.inline(listOf(DocumentRun(text)), text.length)
        assertEquals(listOf(DocumentRun("make "), DocumentRun("this", mark("bold"))), close("make **this**")?.runs)
        assertEquals(9, close("make **this**")?.caret)
        assertEquals(listOf(DocumentRun("an "), DocumentRun("idea", mark("italic"))), close("an *idea*")?.runs)
        assertEquals(listOf(DocumentRun("old", mark("strike"))), close("~~old~~")?.runs)
        assertEquals(listOf(DocumentRun("run "), DocumentRun("ls", mark("code"))), close("run `ls`")?.runs)
        assertNull("spaces inside the delimiters", close("2 * 3 *"))
        assertNull(close("**"))
        assertNull("an underscore inside a word", close("snake_case_"))
        assertNull("half a bold is not an italic", close("**bold*"))
    }

    @Test
    fun flatTextOffsets() {
        val lines = listOf(line("paragraph", "ab"), DocumentLine(DocumentBlock("d", "divider", content = DocumentBlock.Content.None)), line("paragraph", "c\nd"))
        val starts = DocumentText.starts(lines)
        assertArrayEquals(intArrayOf(0, 3, 5, 9), starts)
        assertEquals("c\u2028d", DocumentText.paragraph(lines[2]))
        assertEquals(0, DocumentText.locate(0, starts).first)
        assertEquals(2, DocumentText.locate(2, starts).second)
        assertEquals(1, DocumentText.locate(3, starts).first)
        assertEquals(2, DocumentText.locate(7, starts).first)
        assertEquals(2, DocumentText.locate(7, starts).second)
        assertEquals("clamped to the last line's end", 3, DocumentText.locate(99, starts).second)
    }
}
