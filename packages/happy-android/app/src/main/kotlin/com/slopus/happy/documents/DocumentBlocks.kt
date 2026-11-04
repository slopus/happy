package com.slopus.happy.documents

import com.slopus.happy.documents.yjs.YAny
import com.slopus.happy.documents.yjs.YDoc
import com.slopus.happy.documents.yjs.YType

/**
 * A document Surface's content as blocks: what BlockNote 0.51's
 * `docToBlocks` reads from the Yjs fragment, kept as values the editor
 * draws and compares. The Yjs document stays the authority; these are
 * rebuilt from it. iOS's `DocumentBlock`.
 */
data class DocumentBlock(
    val id: String,
    /** The content element's name: `paragraph`, `heading`, `checkListItem`… */
    val type: String,
    /** The content element's attributes as stored (`level`, `checked`, …). */
    val props: Map<String, YAny> = emptyMap(),
    val content: Content,
    val children: List<DocumentBlock> = emptyList(),
) {
    sealed class Content {
        /** Text with formats. A hard break, and a code block's newline, is "\n". */
        data class Inline(val runs: List<DocumentRun>) : Content()
        /** A block with no text (divider, image, file…). */
        data object None : Content()
        /** A table's cells, row by row, each cell's text. */
        data class Table(val rows: List<List<List<DocumentRun>>>) : Content()
        /** Something outside BlockNote's model, kept and never written over. */
        data class Unsupported(val reason: String) : Content()
    }

    val runs: List<DocumentRun> get() = (content as? Content.Inline)?.runs ?: emptyList()
    val plainText: String get() = runs.joinToString("") { it.text }
    val level: Int get() = (props["level"]?.numberValue ?: 1.0).toInt()
    val checked: Boolean get() = props["checked"]?.boolValue ?: false
    val language: String get() = props["language"]?.stringValue ?: "text"
    val isInline: Boolean get() = content is Content.Inline
}

/**
 * A run of text with the formats over it, as y-prosemirror stores marks:
 * `bold: {}`, `link: {href}`, `textColor: {stringValue}`.
 */
data class DocumentRun(val text: String, val marks: Map<String, YAny> = emptyMap())

/** What the editor knows of BlockNote 0.51.4's default schema. */
object DocumentSchema {
    const val FRAGMENT = "document"
    const val THREADS = "threads"

    /** Block types whose content is inline text. */
    val inlineTypes = setOf("paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "codeBlock")
    /** Block types with no content. */
    val emptyTypes = setOf("divider", "image", "video", "audio", "file", "pageBreak")
    val listTypes = setOf("bulletListItem", "numberedListItem", "checkListItem", "toggleListItem")

    /** Each type's attributes and defaults, in the order the schema declares them. */
    fun defaults(type: String): List<Pair<String, YAny>> {
        val colors = listOf("backgroundColor" to YAny.Str("default"), "textColor" to YAny.Str("default"), "textAlignment" to YAny.Str("left"))
        return when (type) {
            "paragraph", "bulletListItem", "toggleListItem" -> colors
            "numberedListItem" -> colors + ("start" to YAny.Undefined)
            "heading" -> colors + listOf("level" to YAny.Number(1.0), "isToggleable" to YAny.Bool(false))
            "checkListItem" -> colors + ("checked" to YAny.Bool(false))
            "quote" -> listOf("backgroundColor" to YAny.Str("default"), "textColor" to YAny.Str("default"))
            "codeBlock" -> listOf("language" to YAny.Str("text"))
            "image", "video" -> listOf(
                "textAlignment" to YAny.Str("left"), "backgroundColor" to YAny.Str("default"), "name" to YAny.Str(""), "url" to YAny.Str(""),
                "caption" to YAny.Str(""), "showPreview" to YAny.Bool(true), "previewWidth" to YAny.Undefined,
            )
            "audio" -> listOf("backgroundColor" to YAny.Str("default"), "name" to YAny.Str(""), "url" to YAny.Str(""), "caption" to YAny.Str(""), "showPreview" to YAny.Bool(true))
            "file" -> listOf("backgroundColor" to YAny.Str("default"), "name" to YAny.Str(""), "url" to YAny.Str(""), "caption" to YAny.Str(""))
            else -> emptyList()
        }
    }

    /** The marks Markdown and the toolbar know; others are kept as they are. */
    val booleanMarks = setOf("bold", "italic", "underline", "strike", "code")
}

/** Reads blocks out of a document (`yXmlFragmentToBlocks`). */
object DocumentReader {
    fun blocks(doc: YDoc): List<DocumentBlock> {
        val group = doc.getXmlFragment(DocumentSchema.FRAGMENT).children.firstOrNull { it.nodeName == "blockGroup" } ?: return emptyList()
        return blocks(group)
    }

    fun blocks(group: YType): List<DocumentBlock> =
        group.children.mapNotNull { container -> if (container.nodeName == "blockContainer") block(container) else null }

    fun block(container: YType): DocumentBlock {
        val id = container.attribute("id")?.stringValue ?: ""
        val parts = container.children
        val element = parts.firstOrNull()
        val type = element?.nodeName ?: return DocumentBlock(id, "", content = DocumentBlock.Content.Unsupported("empty"))
        val children = parts.drop(1).firstOrNull { it.nodeName == "blockGroup" }?.let(::blocks) ?: emptyList()
        val content = when {
            type in DocumentSchema.inlineTypes -> inline(element) ?: DocumentBlock.Content.Unsupported(type)
            type in DocumentSchema.emptyTypes -> if (element.children.isEmpty() && element.length == 0) DocumentBlock.Content.None else DocumentBlock.Content.Unsupported(type)
            type == "table" -> table(element)
            else -> DocumentBlock.Content.Unsupported(type)
        }
        return DocumentBlock(id, type, element.attributes, content, children)
    }

    /** Text and hard breaks; null when the element holds something else. */
    internal fun inline(element: YType): DocumentBlock.Content.Inline? {
        val runs = ArrayList<DocumentRun>()
        for (child in element.children) {
            if (child.isText) {
                for (op in child.toDelta()) {
                    val text = (op.insert as? YType.DeltaOp.Insert.Text)?.text ?: return null
                    append(runs, DocumentRun(text, op.attributes))
                }
            } else if (child.nodeName == "hardBreak") {
                append(runs, DocumentRun("\n", runs.lastOrNull()?.marks ?: emptyMap()))
            } else {
                return null
            }
        }
        return DocumentBlock.Content.Inline(runs)
    }

    /** Joins a run onto the last one when their formats match. */
    fun append(runs: MutableList<DocumentRun>, run: DocumentRun) {
        if (run.text.isEmpty()) return
        val last = runs.lastOrNull()
        if (last != null && last.marks == run.marks) runs[runs.size - 1] = last.copy(text = last.text + run.text)
        else runs += run
    }

    internal fun table(element: YType): DocumentBlock.Content.Table {
        val rows = ArrayList<List<List<DocumentRun>>>()
        for (row in element.children) {
            if (row.nodeName != "tableRow") continue
            val cells = ArrayList<List<DocumentRun>>()
            for (cell in row.children) {
                if (cell.nodeName != "tableCell" && cell.nodeName != "tableHeader") continue
                val runs = ArrayList<DocumentRun>()
                for (paragraph in cell.children) {
                    val more = inline(paragraph) ?: continue
                    if (runs.isNotEmpty()) append(runs, DocumentRun("\n"))
                    for (run in more.runs) append(runs, run)
                }
                cells += runs
            }
            rows += cells
        }
        return DocumentBlock.Content.Table(rows)
    }
}

/**
 * The editor's lines as one flat text, the way the text view holds them:
 * each line a paragraph ending in "\n", a hard break inside one as U+2028
 * (so a paragraph is always exactly one block), and a block without text
 * as one U+FFFC. Offsets inside a line are the same UTF-16 offsets
 * [DocumentCaret] counts.
 */
object DocumentText {
    const val LINE_BREAK = '\u2028'
    const val OBJECT = '\uFFFC'

    fun paragraph(line: DocumentLine): String =
        if (line.block.isInline) line.block.plainText.replace('\n', LINE_BREAK) else OBJECT.toString()

    /** Where each line starts, and where the text ends. */
    fun starts(lines: List<DocumentLine>): IntArray {
        val out = IntArray(lines.size + 1)
        var position = 0
        lines.forEachIndexed { i, line ->
            out[i] = position
            position += line.length + 1
        }
        out[lines.size] = position
        return out
    }

    /** The line an offset falls in, and the offset inside it. */
    fun locate(offset: Int, starts: IntArray): Pair<Int, Int> {
        if (starts.size <= 1) return 0 to 0
        var low = 0
        var high = starts.size - 2
        while (low < high) {
            val mid = (low + high + 1) / 2
            if (starts[mid] <= offset) low = mid else high = mid - 1
        }
        val lineEnd = starts[low + 1] - 1
        return low to minOf(maxOf(0, offset - starts[low]), lineEnd - starts[low])
    }

    /** A paragraph's text back as the block's text. */
    fun blockText(paragraph: String): String = paragraph.replace(LINE_BREAK, '\n')
}
