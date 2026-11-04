package com.slopus.happy.documents

import com.slopus.happy.documents.DocumentFixtures.editor
import com.slopus.happy.documents.DocumentFixtures.fixture
import com.slopus.happy.documents.yjs.YAny
import com.slopus.happy.documents.yjs.YDoc
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File
import java.util.Base64

/**
 * Documents this editor wrote, for the real BlockNote and the daemon's
 * Markdown code to read back: with `HAPPY_DOCUMENT_INTEROP=<dir>` set, each
 * case is written there, and
 * `node packages/happy-ios/scripts/generate-document-fixtures.mjs verify <dir>`
 * checks that BlockNote reads the same blocks and the daemon the same
 * Markdown. Without it, the same cases still run against our own reader
 * (iOS's `DocumentInteropTests`).
 */
class DocumentInteropTest {
    private class Case(val name: String, val state: ByteArray, val markdown: String, val blocks: List<DocumentBlock>)

    private val obj = YAny.Object(emptyList())

    private fun inline(vararg runs: DocumentRun) = DocumentBlock.Content.Inline(runs.toList())

    private fun cases(): List<Case> {
        val out = ArrayList<Case>()
        fun run(name: String, fixture: String, edit: (DocumentEditor) -> Unit) {
            val base = if (fixture.isEmpty()) byteArrayOf(0, 0) else fixture(fixture)
            val (editor, box) = editor(base, client = 3_141_592)
            edit(editor)
            assertFalse(name, box.updates.isEmpty())
            val replica = YDoc(1)
            replica.applyUpdate(base)
            box.updates.forEach(replica::applyUpdate)
            val blocks = DocumentReader.blocks(replica)
            assertEquals(name, editor.blocks, blocks)
            out += Case(name, replica.encodeStateAsUpdate(), DocumentMarkdown.markdown(blocks), blocks)
        }
        run("type-in-paragraph", "desktop-short") { e ->
            e.setRuns(e.lines[1].id, listOf(DocumentRun("Typed on a phone. ")) + e.lines[1].block.runs)
        }
        run("bold-italic-strike-code-link", "desktop-short") { e ->
            e.setRuns(e.lines[1].id, listOf(
                DocumentRun("Bold", mapOf("bold" to obj)), DocumentRun(" and "),
                DocumentRun("italic", mapOf("italic" to obj)), DocumentRun(", "),
                DocumentRun("struck", mapOf("strike" to obj)), DocumentRun(", "),
                DocumentRun("code", mapOf("code" to obj)), DocumentRun(" and "),
                DocumentRun("a link", mapOf("link" to YAny.Object(listOf("href" to YAny.Str("https://happy.engineering"))))), DocumentRun("."),
            ))
        }
        run("unformat-keeps-text", "formatting") { e ->
            e.setRuns(e.lines[0].id, listOf(DocumentRun(e.lines[0].block.plainText)))
        }
        run("hard-break", "desktop-short") { e ->
            e.setRuns(e.lines[1].id, listOf(DocumentRun("First line\nsecond line")))
        }
        run("split-into-heading-and-list", "desktop-short") { e ->
            val lines = e.lines.toMutableList()
            lines[1] = lines[1].copy(block = lines[1].block.copy(content = inline(DocumentRun("Two paragraphs"))))
            val heading = DocumentLine(DocumentBlock(DocumentEditor.newID(), "heading", mapOf("level" to YAny.Number(3.0)), inline(DocumentRun("A new heading"))))
            val bullet = DocumentLine(DocumentBlock(DocumentEditor.newID(), "bulletListItem", content = inline(DocumentRun("A bullet"))))
            val nested = DocumentLine(DocumentBlock(DocumentEditor.newID(), "checkListItem", mapOf("checked" to YAny.Bool(true)), inline(DocumentRun("Nested and done"))), depth = 1)
            lines.addAll(2, listOf(heading, bullet, nested))
            e.replaceLines(e.lines.indices, lines)
        }
        run("change-types", "blocks") { e ->
            e.setType(e.lines[0].id, "heading", mapOf("level" to YAny.Number(2.0)))
            e.setType(e.lines[3].id, "quote")
            e.setType(e.lines[5].id, "numberedListItem")
            e.toggleChecked(e.lines.first { it.block.type == "checkListItem" }.id)
            val code = e.lines.first { it.block.type == "codeBlock" }.id
            e.setRuns(code, listOf(DocumentRun("let y = 2\nprint(y)\n")))
            e.setType(e.lines[4].id, "codeBlock", mapOf("language" to YAny.Str("python")))
        }
        run("indent-outdent", "desktop-short") { e ->
            val lines = e.lines.toMutableList()
            val items = lines.indices.filter { lines[it].block.type == "numberedListItem" }
            lines[items[1]] = lines[items[1]].copy(depth = 1)
            lines[items[2]] = lines[items[2]].copy(depth = 2)
            e.replaceLines(e.lines.indices, lines)
            val again = e.lines.toMutableList()
            again[again.lastIndex] = again.last().copy(depth = 1)
            e.replaceLines(e.lines.indices, again)
        }
        run("insert-divider-and-delete-lines", "desktop-readme") { e ->
            val lines = e.lines.toMutableList()
            lines.subList(2, 4).clear()
            lines.add(2, DocumentLine(DocumentBlock(DocumentEditor.newID(), "divider", content = DocumentBlock.Content.None)))
            e.replaceLines(e.lines.indices, lines)
        }
        run("new-document", "") { e ->
            e.replaceLines(e.lines.indices, listOf(
                DocumentLine(DocumentBlock(DocumentEditor.newID(), "heading", mapOf("level" to YAny.Number(1.0)), inline(DocumentRun("Fresh")))),
                DocumentLine(DocumentBlock(DocumentEditor.newID(), "paragraph", content = inline(DocumentRun("Written on Android \uD83D\uDE00 with \u00FCn\u00EFc\u00F6d\u00E9.")))),
            ))
        }
        run("emoji-edits", "escape-25") { e ->
            e.setRuns(e.lines[0].id, listOf(DocumentRun("emoji \uD83D\uDE03 and \u00FCn\u00EFc\u00F6d\u00E9!")))
        }
        return out
    }

    @Test
    fun casesReadBackTheSame() {
        val cases = cases()
        assertEquals(10, cases.size)
        val dir = System.getenv("HAPPY_DOCUMENT_INTEROP") ?: return
        File(dir).mkdirs()
        val json = JsonArray(cases.map { c ->
            JsonObject(mapOf(
                "name" to JsonPrimitive(c.name),
                "state" to JsonPrimitive(Base64.getEncoder().encodeToString(c.state)),
                "markdown" to JsonPrimitive(c.markdown),
                "blocks" to BlockNoteJSON.normalize(JsonArray(c.blocks.map(BlockNoteJSON::block))),
            ))
        })
        File(dir, "editor.json").writeText(Json.encodeToString(JsonArray.serializer(), json))
    }
}
