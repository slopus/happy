package com.slopus.happy.documents

import com.slopus.happy.documents.yjs.YAny

/**
 * The editor's edits as pure functions over lines and runs, the way
 * BlockNote's keyboard handlers make them (`KeyboardShortcutsExtension`:
 * Enter splits, an empty list item lifts out, Backspace at a block's start
 * turns it into a paragraph before joining it to the one above). The
 * screen applies what they return through [DocumentEditor.replaceLines].
 * iOS's `DocumentEdits`.
 */
object DocumentEdits {
    /**
     * A replacement for some lines ([range], end exclusive as `from until to`)
     * and where the caret goes after it: an index into the whole document's
     * lines after the edit, and a UTF-16 offset.
     */
    data class Result(val range: IntRange, val lines: List<DocumentLine>, val caretLine: Int, val caretOffset: Int)

    /** The runs' text between two UTF-16 offsets, formats kept. */
    fun slice(runs: List<DocumentRun>, from: Int, to: Int): List<DocumentRun> {
        val out = ArrayList<DocumentRun>()
        var position = 0
        for (run in runs) {
            val units = run.text.length
            val start = maxOf(from - position, 0)
            val end = minOf(to - position, units)
            if (start < end) DocumentReader.append(out, DocumentRun(run.text.substring(start, end), run.marks))
            position += units
        }
        return out
    }

    fun length(runs: List<DocumentRun>): Int = runs.sumOf { it.text.length }

    fun concat(a: List<DocumentRun>, b: List<DocumentRun>): List<DocumentRun> {
        val out = a.toMutableList()
        for (run in b) DocumentReader.append(out, run)
        return out
    }

    /** Whether every character in [from, to) carries [mark] (the toolbar's lit buttons). */
    fun has(runs: List<DocumentRun>, mark: String, from: Int, to: Int): Boolean {
        val picked = if (from >= to) slice(runs, maxOf(0, from - 1), from) else slice(runs, from, to)
        return picked.isNotEmpty() && picked.all { it.marks[mark] != null }
    }

    /**
     * Sets or clears a mark over [from, to). Inline code takes no other marks
     * with it, as BlockNote's `code` mark excludes them.
     */
    fun setting(runs: List<DocumentRun>, mark: String, value: YAny?, from: Int, to: Int): List<DocumentRun> {
        val total = length(runs)
        val start = maxOf(0, from)
        val end = minOf(total, to)
        if (start >= end) return runs
        val middle = slice(runs, start, end).map { run ->
            if (value != null) {
                val base = if (mark == "code") run.marks.filterKeys { it == "textColor" || it == "backgroundColor" } else run.marks
                run.copy(marks = base + (mark to value))
            } else {
                run.copy(marks = run.marks - mark)
            }
        }
        return concat(concat(slice(runs, 0, start), middle), slice(runs, end, total))
    }

    fun toggling(runs: List<DocumentRun>, mark: String, from: Int, to: Int): List<DocumentRun> =
        setting(runs, mark, if (has(runs, mark, from, to)) null else YAny.Object(emptyList()), from, to)

    /**
     * The text typed in place of [from, to), taking the formats a character
     * typed there would: those before it, but never a link's or code's past
     * their end (ProseMirror's non-inclusive marks).
     */
    fun typing(runs: List<DocumentRun>, text: String, from: Int, to: Int, marks: Map<String, YAny>? = null): List<DocumentRun> {
        val total = length(runs)
        val inserted = DocumentRun(text, marks ?: marks(runs, from))
        return concat(concat(slice(runs, 0, from), listOf(inserted)), slice(runs, to, total))
    }

    fun marks(runs: List<DocumentRun>, offset: Int): Map<String, YAny> {
        if (offset <= 0) return slice(runs, 0, 1).firstOrNull()?.marks?.filterKeys { it != "link" && it != "code" } ?: emptyMap()
        val marks = (slice(runs, offset - 1, offset).firstOrNull()?.marks ?: emptyMap()).toMutableMap()
        val after = slice(runs, offset, offset + 1).firstOrNull()?.marks
        for (key in listOf("link", "code")) if (marks[key] != null && after?.get(key) != marks[key]) marks.remove(key)
        return marks
    }

    internal fun fresh(type: String, depth: Int, runs: List<DocumentRun> = emptyList(), id: String = DocumentEditor.newID()) =
        DocumentLine(DocumentBlock(id, type, emptyMap(), DocumentBlock.Content.Inline(runs)), depth)

    private fun DocumentLine.withBlock(change: (DocumentBlock) -> DocumentBlock) = copy(block = change(block))

    /** Enter at [offset] in line [index]. */
    fun enter(lines: List<DocumentLine>, index: Int, offset: Int, newID: String = DocumentEditor.newID()): Result? {
        if (index !in lines.indices) return null
        val line = lines[index]
        if (!line.block.isInline) {
            return Result(index + 1 until index + 1, listOf(fresh("paragraph", line.depth, id = newID)), index + 1, 0)
        }
        val runs = line.block.runs
        val total = length(runs)
        // An empty list item, quote or heading lifts out to a paragraph, then up a level.
        if (total == 0 && line.block.type != "paragraph") {
            val lifted = line.withBlock { it.copy(type = "paragraph", props = DocumentEditor.carriedProps(line.block, "paragraph")) }
            return Result(index until index + 1, listOf(lifted), index, 0)
        }
        if (total == 0 && line.depth > 0) return Result(index until index + 1, listOf(line.copy(depth = line.depth - 1)), index, 0)
        val first = line.withBlock { it.copy(content = DocumentBlock.Content.Inline(slice(runs, 0, offset))) }
        val rest = slice(runs, offset, total)
        val type = if (line.block.type in DocumentSchema.listTypes || line.block.type == "quote") line.block.type else "paragraph"
        val second = fresh(type, line.depth, rest, newID).withBlock {
            it.copy(props = DocumentEditor.carriedProps(line.block, type).filterKeys { key -> key != "checked" && key != "start" })
        }
        // At the very start, the new empty line goes above and the line keeps its ID.
        if (offset == 0 && total > 0) {
            val above = second.withBlock { it.copy(content = DocumentBlock.Content.Inline(emptyList())) }
            return Result(index until index, listOf(above), index + 1, 0)
        }
        return Result(index until index + 1, listOf(first, second), index + 1, 0)
    }

    /** Backspace at the start of line [index]. */
    fun backspaceAtStart(lines: List<DocumentLine>, index: Int): Result? {
        if (index !in lines.indices) return null
        val line = lines[index]
        if (line.block.isInline && line.block.type != "paragraph") {
            val plain = line.withBlock { block ->
                val b = block.copy(type = "paragraph", props = DocumentEditor.carriedProps(line.block, "paragraph"))
                if (line.block.type == "codeBlock") b.copy(content = DocumentBlock.Content.Inline(line.block.runs.map { DocumentRun(it.text) })) else b
            }
            return Result(index until index + 1, listOf(plain), index, 0)
        }
        // Nested, it comes up a level first (`liftListItem`).
        if (line.depth > 0) return outdent(lines, index until index + 1, 0)
        if (index <= 0) return null
        val previous = lines[index - 1]
        // A divider or picture above goes; the line stays.
        if (!previous.block.isInline) return Result(index - 1 until index, emptyList(), index - 1, 0)
        if (!line.block.isInline) return Result(index until index + 1, emptyList(), index - 1, previous.length)
        val code = previous.block.type == "codeBlock"
        val tail = if (code) line.block.runs.map { DocumentRun(it.text) } else line.block.runs
        val joined = previous.withBlock { it.copy(content = DocumentBlock.Content.Inline(concat(previous.block.runs, tail))) }
        // Its children come up a level to stay under the joined line.
        var range = index - 1 until index + 1
        val moved = ArrayList<DocumentLine>()
        var i = index + 1
        while (i < lines.size && lines[i].depth > line.depth) {
            val child = lines[i]
            moved += child.copy(depth = maxOf(joined.depth + 1, child.depth - (line.depth - joined.depth)))
            i++
        }
        if (moved.isNotEmpty()) range = index - 1 until i
        return Result(range, listOf(joined) + moved, index - 1, previous.length)
    }

    /** Tab: a line goes under the one above, as long as there is one at its depth. */
    fun indent(lines: List<DocumentLine>, range: IntRange, caret: Int): Result? {
        val first = range.first
        if (range.isEmpty() || first <= 0 || lines[first - 1].depth < lines[first].depth) return null
        var end = range.last + 1
        while (end < lines.size && lines[end].depth > lines[range.last].depth) end++
        val out = lines.subList(first, end).map { it.copy(depth = it.depth + 1) }
        return Result(first until end, out, first, caret)
    }

    /**
     * Shift-Tab: lines come up a level; the lines after them at their old
     * depth become their children, as ProseMirror's `liftListItem` does.
     */
    fun outdent(lines: List<DocumentLine>, range: IntRange, caret: Int): Result? {
        if (range.isEmpty() || lines.subList(range.first, range.last + 1).none { it.depth > 0 }) return null
        val lastDepth = lines[range.last].depth
        var end = range.last + 1
        while (end < lines.size && lines[end].depth > lastDepth) end++
        val out = lines.subList(range.first, end).map { it.copy(depth = maxOf(0, it.depth - 1)) }
        return Result(range.first until end, out, range.first, caret)
    }

    /** A line made another type, its text kept (the toolbar's block buttons). */
    fun retype(line: DocumentLine, type: String, props: Map<String, YAny> = emptyMap()): DocumentLine {
        var block = line.block.copy(type = type, props = DocumentEditor.carriedProps(line.block, type) + props)
        if (type == "codeBlock" || line.block.type == "codeBlock") block = block.copy(content = DocumentBlock.Content.Inline(listOf(DocumentRun(line.block.plainText))))
        if (!line.block.isInline) block = block.copy(content = DocumentBlock.Content.Inline(emptyList()))
        return line.copy(block = block)
    }

    /** A divider in place of line [index], then an empty paragraph to go on typing in. */
    fun divider(lines: List<DocumentLine>, index: Int): Result {
        val line = lines[index]
        val divider = DocumentLine(DocumentBlock(line.id, "divider", content = DocumentBlock.Content.None), line.depth)
        val following = index + 1 < lines.size && lines[index + 1].block.isInline && lines[index + 1].length == 0
        if (following) return Result(index until index + 1, listOf(divider), index + 1, 0)
        return Result(index until index + 1, listOf(divider, fresh("paragraph", line.depth)), index + 1, 0)
    }
}

/**
 * Markdown typed as Markdown turning into what it means (BlockNote's input
 * rules): `# ` a heading, `- ` a bullet, `1. ` a numbered item, `[] ` a
 * task, `> ` a quote, ```` ``` ```` a code block, `---` a divider, and
 * `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` closing as typed.
 */
object DocumentShortcuts {
    sealed class Block {
        data class Type(val type: String, val props: Map<String, YAny>, val remove: Int) : Block()
        data object Divider : Block()
    }

    private val rules: List<Pair<Regex, (String) -> Pair<String, Map<String, YAny>>>> = listOf(
        Regex("^(#{1,6}) $") to { m -> "heading" to mapOf("level" to YAny.Number(m.count { it == '#' }.toDouble())) },
        Regex("^\\s?[-+*] $") to { _ -> "bulletListItem" to emptyMap() },
        Regex("^\\s?(\\d+)\\. $") to { m ->
            val n = m.filter(Char::isDigit).toIntOrNull() ?: 1
            "numberedListItem" to (if (n == 1) emptyMap() else mapOf("start" to YAny.Number(n.toDouble())))
        },
        Regex("^\\s?\\[\\s*\\] $") to { _ -> "checkListItem" to mapOf("checked" to YAny.Bool(false)) },
        Regex("^\\s?\\[[Xx]\\] $") to { _ -> "checkListItem" to mapOf("checked" to YAny.Bool(true)) },
        Regex("^> $") to { _ -> "quote" to emptyMap() },
        Regex("^```([A-Za-z0-9+#-]*) $") to { m ->
            val language = m.drop(3).dropLast(1)
            "codeBlock" to mapOf("language" to YAny.Str(language.ifEmpty { "text" }))
        },
    )

    /** What the text before the caret makes of a paragraph, right after a character was typed. */
    fun block(line: DocumentLine, caret: Int): Block? {
        if (!line.block.isInline || line.block.type == "codeBlock") return null
        val text = line.block.plainText
        if (caret > text.length) return null
        val before = text.substring(0, caret)
        if (line.block.type == "paragraph" && text == "---" && caret == 3) return Block.Divider
        if (!before.endsWith(" ")) return null
        for ((pattern, make) in rules) {
            val match = pattern.find(before) ?: continue
            val (type, props) = make(match.value)
            // Headings change level in place; other blocks start from a paragraph.
            if (line.block.type != "paragraph" && !(type == "heading" && line.block.type == "heading")) return null
            if (type == line.block.type && type != "heading") return null
            return Block.Type(type, props, before.length)
        }
        return null
    }

    data class Inline(val runs: List<DocumentRun>, val caret: Int)

    private val delimiters = listOf("**" to "bold", "__" to "bold", "~~" to "strike", "*" to "italic", "_" to "italic", "`" to "code")

    /** A closing delimiter just typed at [caret] formats what it closes. */
    fun inline(runs: List<DocumentRun>, caret: Int): Inline? {
        val units = DocumentEdits.slice(runs, 0, caret).joinToString("") { it.text }
        if (units.length != caret) return null
        for ((d, mark) in delimiters) {
            if (caret < 2 * d.length + 1 || !units.regionMatches(caret - d.length, d, 0, d.length)) continue
            // The opening delimiter: the nearest one before, with text between that doesn't start or end in a space.
            var start = caret - d.length - 1
            var open: Int? = null
            while (start - d.length + 1 >= 0) {
                val candidate = start - d.length + 1
                if (units.regionMatches(candidate, d, 0, d.length)) { open = candidate; break }
                start--
            }
            if (open == null) continue
            val innerStart = open + d.length
            val innerEnd = caret - d.length
            if (innerStart >= innerEnd) continue
            if (units[innerStart] == ' ' || units[innerEnd - 1] == ' ') continue
            // `**` isn't two italics, and an `*` inside a word after a letter isn't one either.
            if (d.length == 1 && open > 0 && units[open - 1] == d[0]) continue
            if (d.length == 1 && units[innerEnd - 1] == d[0]) continue
            if (d == "_" && open > 0 && units[open - 1].isLetterOrDigit()) continue
            if (mark != "code" && DocumentEdits.slice(runs, innerStart, innerEnd).any { it.marks["code"] != null }) continue
            val total = DocumentEdits.length(runs)
            var middle = DocumentEdits.setting(DocumentEdits.slice(runs, innerStart, innerEnd), mark, YAny.Object(emptyList()), 0, innerEnd - innerStart)
            if (mark == "code") middle = middle.map { DocumentRun(it.text, it.marks.filterKeys { key -> key == "code" }) }
            val out = DocumentEdits.concat(DocumentEdits.concat(DocumentEdits.slice(runs, 0, open), middle), DocumentEdits.slice(runs, caret, total))
            return Inline(out, caret - 2 * d.length)
        }
        return null
    }
}
