package com.slopus.happy.documents

/**
 * A document's Markdown, as the daemon projects it: iOS's
 * `DocumentMarkdown`, a port of happy-agent's `blocksToMarkdown.ts`. Used
 * to copy a document as Markdown and to check that opening and editing
 * never changes what the daemon reads.
 *
 * The daemon also parses each block's inline Markdown back and drops
 * emphasis that would not survive; this keeps every format, which matches
 * the daemon for everything the editor writes.
 */
object DocumentMarkdown {
    fun markdown(blocks: List<DocumentBlock>): String {
        val text = serialize(blocks, "", HashSet())
        return if (text.isEmpty()) "" else text + "\n"
    }

    /** What the Markdown leaves out: underline, colors, alignment, toggles, nesting. */
    fun omitted(blocks: List<DocumentBlock>): Set<String> = HashSet<String>().also { serialize(blocks, "", it) }

    private fun serialize(blocks: List<DocumentBlock>, indent: String, omitted: MutableSet<String>): String {
        val chunks = ArrayList<Pair<String, String>>()
        var number = 0
        for (block in blocks) {
            number = if (block.type == "numberedListItem") number + 1 else 0
            if (block.content is DocumentBlock.Content.Unsupported) continue
            recordProps(block, omitted)
            val lines = ownMarkdown(block, number, omitted)
            val continuation = indent + " ".repeat(markerWidth(block, number))
            var text = lines.mapIndexed { i, line -> (if (i == 0) indent else continuation) + line }.joinToString("\n")
            if (block.children.isNotEmpty()) {
                if (block.type in DocumentSchema.listTypes) {
                    val gap = if (block.children[0].type in DocumentSchema.listTypes) "\n" else "\n\n"
                    text += gap + serialize(block.children, continuation, omitted)
                } else {
                    omitted += "nesting"
                    text += "\n\n" + serialize(block.children, indent, omitted)
                }
            }
            chunks += text to block.type
        }
        val out = StringBuilder()
        chunks.forEachIndexed { index, (text, type) ->
            if (index > 0) {
                val previous = chunks[index - 1].second
                val sameList = type in DocumentSchema.listTypes && (previous == type || (bulletLike(previous) && bulletLike(type)))
                out.append(if (sameList) "\n" else "\n\n")
            }
            out.append(text)
        }
        return out.toString()
    }

    private fun bulletLike(type: String) = type == "bulletListItem" || type == "checkListItem" || type == "toggleListItem"

    private fun markerWidth(block: DocumentBlock, number: Int): Int = when {
        block.type == "numberedListItem" -> "$number. ".length
        block.type in DocumentSchema.listTypes -> 2
        else -> 0
    }

    private class Context(val table: Boolean, val singleLine: Boolean)

    private fun ownMarkdown(block: DocumentBlock, number: Int, omitted: MutableSet<String>): List<String> {
        val props = block.props
        fun lines(singleLine: Boolean = false) = inline(block.runs, Context(false, singleLine), omitted).split("\n")
        return when (block.type) {
            "heading" -> {
                val level = block.level.coerceIn(1, 6)
                var text = lines(true).firstOrNull().orEmpty()
                Regex("(\\s)#(#*)$").find(text)?.let { m ->
                    text = text.substring(0, m.range.first) + m.value.take(1) + "\\" + m.value.drop(1) + text.substring(m.range.last + 1)
                }
                listOf("#".repeat(level) + (if (text.isEmpty()) "" else " $text"))
            }
            "bulletListItem", "toggleListItem" -> prefixed("- ", lines())
            "numberedListItem" -> prefixed("$number. ", lines())
            "checkListItem" -> prefixed("- [${if (block.checked) "x" else " "}] ", lines())
            "quote" -> lines().map { if (it.isEmpty()) ">" else "> $it" }
            "codeBlock" -> {
                val code = block.plainText
                val fence = "`".repeat(maxOf(3, longestRun(code, '`') + 1))
                val language = block.language
                listOf(fence + (if (language == "text") "" else language)) + code.split("\n") + fence
            }
            "divider" -> listOf("---")
            "image" -> {
                val name = props["name"]?.stringValue?.takeIf { it.isNotEmpty() } ?: props["caption"]?.stringValue ?: ""
                listOf("![${escapeText(name, Context(false, true), true)}](${destination(props["url"]?.stringValue ?: "")})")
            }
            "file", "audio", "video" -> {
                val url = props["url"]?.stringValue ?: ""
                val name = props["name"]?.stringValue?.takeIf { it.isNotEmpty() } ?: url
                if (url.isEmpty()) listOf(escapeLine(escapeText(name, Context(false, true), false)))
                else listOf("[${escapeText(name, Context(false, true), true)}](${destination(url)})")
            }
            "table" -> {
                val rows = (block.content as? DocumentBlock.Content.Table)?.rows ?: return emptyList()
                val first = rows.firstOrNull() ?: return emptyList()
                val width = maxOf(1, rows.maxOfOrNull { it.size } ?: 0)
                fun render(row: List<List<DocumentRun>>): String {
                    val cells = (0 until width).map { i -> if (i < row.size) inline(row[i], Context(true, true), omitted) else "" }
                    return "| " + cells.joinToString(" | ") + " |"
                }
                listOf(render(first), "| " + List(width) { "---" }.joinToString(" | ") + " |") + rows.drop(1).map(::render)
            }
            else -> lines()
        }
    }

    private fun prefixed(marker: String, lines: List<String>) = lines.mapIndexed { i, line -> if (i == 0) marker + line else line }

    private sealed class Node {
        class Text(val value: String, val styles: Set<String>) : Node()
        class Link(val href: String, val content: List<Pair<String, Set<String>>>) : Node()
    }

    private fun inline(runs: List<DocumentRun>, context: Context, omitted: MutableSet<String>): String =
        escapeLines(render(normalize(runs, context, omitted), context), context)

    private fun normalize(runs: List<DocumentRun>, context: Context, omitted: MutableSet<String>): List<Node> {
        fun kept(run: DocumentRun): Pair<String, Set<String>> {
            if (run.marks["underline"] != null) omitted += "underline"
            run.marks["textColor"]?.get("stringValue")?.stringValue?.let { if (it != "default") omitted += "text colors" }
            run.marks["backgroundColor"]?.get("stringValue")?.stringValue?.let { if (it != "default") omitted += "highlights" }
            val styles = listOf("bold", "italic", "strike", "code").filter { run.marks[it] != null }.toSet()
            return (if (context.singleLine) run.text.replace("\n", " ") else run.text) to styles
        }
        val nodes = ArrayList<Node>()
        for (run in runs) {
            if (run.text.isEmpty()) continue
            val text = kept(run)
            val href = run.marks["link"]?.get("href")?.stringValue
            if (href != null) {
                val last = nodes.lastOrNull()
                if (last is Node.Link && last.href == href) nodes[nodes.size - 1] = Node.Link(href, last.content + text)
                else nodes += Node.Link(href, listOf(text))
            } else {
                nodes += Node.Text(text.first, text.second)
            }
        }
        return sharedWhitespace(nodes.map { node ->
            if (node is Node.Link) Node.Link(node.href, sharedWhitespaceTexts(node.content.filter { it.first.isNotEmpty() })) else node
        })
    }

    private fun isBlank(s: String) = s.isBlank()

    private val shareable = setOf("bold", "italic", "strike")

    private fun sharedWhitespace(nodes: List<Node>): List<Node> = nodes.mapIndexed { index, node ->
        if (node !is Node.Text || !isBlank(node.value)) return@mapIndexed node
        fun styles(other: Node?) = (other as? Node.Text)?.styles ?: emptySet()
        val before = styles(nodes.getOrNull(index - 1))
        val after = styles(nodes.getOrNull(index + 1))
        Node.Text(node.value, before intersect after intersect shareable)
    }

    private fun sharedWhitespaceTexts(texts: List<Pair<String, Set<String>>>) = texts.mapIndexed { index, item ->
        if (!isBlank(item.first)) return@mapIndexed item
        val before = texts.getOrNull(index - 1)?.second ?: emptySet()
        val after = texts.getOrNull(index + 1)?.second ?: emptySet()
        item.first to (before intersect after intersect shareable)
    }

    private val delimiters = mapOf("bold" to "**", "italic" to "*", "strike" to "~~")

    private fun render(nodes: List<Node>, context: Context): String {
        val out = StringBuilder()
        var open = ArrayList<String>()
        fun close(keep: List<String>) {
            var shared = 0
            while (shared < open.size && open[shared] in keep) shared++
            for (style in open.subList(shared, open.size).asReversed()) out.append(delimiters.getValue(style))
            open = ArrayList(open.subList(0, shared))
        }
        fun text(value: String, marks: Set<String>, inLink: Boolean) {
            val styles = listOf("bold", "italic", "strike").filter { it in marks }
            val leading = value.takeWhile { it.isWhitespace() }
            val trailing = if (value.length > leading.length) value.takeLastWhile { it.isWhitespace() } else ""
            val core = value.substring(leading.length, value.length - trailing.length)
            if (core.isEmpty()) {
                close(styles)
                out.append(escapeText(value, context, inLink))
                return
            }
            close(styles)
            out.append(escapeText(leading, context, inLink))
            for (style in styles) if (style !in open) { out.append(delimiters.getValue(style)); open += style }
            out.append(if ("code" in marks) codeSpan(core) else escapeText(core, context, inLink))
            if (trailing.isNotEmpty()) {
                close(emptyList())
                out.append(escapeText(trailing, context, inLink))
            }
        }
        for (node in nodes) {
            when (node) {
                is Node.Text -> text(node.value, node.styles, false)
                is Node.Link -> {
                    close(emptyList())
                    out.append('[')
                    for ((value, marks) in node.content) text(value, marks, true)
                    close(emptyList())
                    out.append("](").append(destination(node.href)).append(')')
                }
            }
        }
        close(emptyList())
        return out.toString()
    }

    private fun codeSpan(text: String): String {
        val fence = "`".repeat(longestRun(text, '`') + 1)
        val pad = if (text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && !isBlank(text))) " " else ""
        return fence + pad + text + pad + fence
    }

    private fun longestRun(text: String, char: Char): Int {
        var longest = 0
        var run = 0
        for (c in text) {
            run = if (c == char) run + 1 else 0
            longest = maxOf(longest, run)
        }
        return longest
    }

    /** A link destination as markdown-it's `normalizeLink` would give it back. */
    internal fun destination(href: String): String {
        if (href.isEmpty()) return ""
        val url = normalizeLink(href)
        if (url.any { it.isWhitespace() || it in "<>()" }) {
            return "<" + url.replace("<", "%3C").replace(">", "%3E").replace("\n", "%0A") + ">"
        }
        return url.replace("\\", "\\\\")
    }

    private const val KEEP = ";/?:@&=+$,-_.!~*'()#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    /** mdurl's `encode`: percent-encodes what is not URL-safe, keeping existing escapes. */
    internal fun normalizeLink(href: String): String {
        val out = StringBuilder()
        var i = 0
        fun hex(c: Char) = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'
        while (i < href.length) {
            val c = href[i]
            if (c == '%' && i + 2 < href.length && hex(href[i + 1]) && hex(href[i + 2])) {
                out.append(href, i, i + 3)
                i += 3
                continue
            }
            if (c in KEEP) {
                out.append(c)
                i++
                continue
            }
            val cp = href.codePointAt(i)
            for (byte in String(Character.toChars(cp)).toByteArray(Charsets.UTF_8)) out.append(String.format("%%%02X", byte.toInt() and 0xFF))
            i += Character.charCount(cp)
        }
        return out.toString()
    }

    private const val PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    private val entityPattern = Regex("^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});")

    /** Escapes only what Markdown would read as inline syntax (`escapeText`). */
    private fun escapeText(text: String, context: Context, inLink: Boolean): String {
        val chars = text
        val out = StringBuilder()
        fun space(c: Char?) = c?.isWhitespace() ?: false
        fun word(c: Char?) = c?.let { it.isLetter() || it.isDigit() } ?: false
        for (index in chars.indices) {
            val char = chars[index]
            val before = chars.getOrNull(index - 1)
            val after = chars.getOrNull(index + 1)
            val escape = when (char) {
                '\\' -> after == null || after == '\n' || after in PUNCTUATION
                '`', '[' -> true
                ']' -> inLink
                '*' -> !(space(before) && space(after))
                '_' -> !((word(before) && word(after)) || (space(before) && space(after)))
                '~' -> before == '~' || after == '~'
                '<' -> after?.let { it.code < 128 && (it.isLetter() || it in "/!?") } ?: false
                '&' -> entityPattern.containsMatchIn(chars.substring(index))
                '|' -> context.table
                else -> false
            }
            if (escape) out.append('\\')
            out.append(char)
        }
        return out.toString()
    }

    private fun escapeLines(markdown: String, context: Context): String {
        val lines = markdown.split("\n")
        return lines.mapIndexed { index, line -> escapeLine(line) + (if (index < lines.size - 1) "\\" else "") }
            .joinToString(if (context.singleLine) " " else "\n")
    }

    private val headingStart = Regex("^#{1,6}(\\s|$)")
    private val bulletStart = Regex("^[-+](\\s|$)")
    private val ruleLine = Regex("^[-=]+\\s*$")
    private val orderedStart = Regex("^\\d{1,9}[.)](\\s|$)")

    /** Keeps a line from starting block syntax, and keeps its outer whitespace. */
    private fun escapeLine(line: String): String {
        if (line.isEmpty()) return line
        val indent = line.takeWhile { it == ' ' || it == '\t' }
        var rest = line.substring(indent.length)
        if (headingStart.containsMatchIn(rest) || rest.startsWith(">") || bulletStart.containsMatchIn(rest) || ruleLine.containsMatchIn(rest) || rest.startsWith("~~~")) {
            rest = "\\" + rest
        } else if (orderedStart.containsMatchIn(rest)) {
            val digits = rest.takeWhile { it.isDigit() }
            rest = digits + "\\" + rest.substring(digits.length)
        }
        var out = if (indent.isEmpty()) rest else entity(indent[0]) + indent.substring(1) + rest
        val last = out.lastOrNull()
        if (last != null && (last == ' ' || last == '\t') && out.any { it != ' ' && it != '\t' }) out = out.dropLast(1) + entity(last)
        return out
    }

    private fun entity(c: Char) = if (c == '\t') "&#9;" else "&#32;"

    private fun recordProps(block: DocumentBlock, omitted: MutableSet<String>) {
        block.props["textColor"]?.stringValue?.let { if (it != "default") omitted += "text colors" }
        block.props["backgroundColor"]?.stringValue?.let { if (it != "default") omitted += "highlights" }
        block.props["textAlignment"]?.stringValue?.let { if (it != "left") omitted += "alignment" }
        if (block.type == "toggleListItem" || block.props["isToggleable"]?.boolValue == true) omitted += "toggles"
    }
}
