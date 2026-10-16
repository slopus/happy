package com.slopus.happy.chat.markdown

import androidx.compose.runtime.Immutable

// happy-app's components/markdown parser (parseMarkdown.ts,
// parseMarkdownBlock.ts, parseMarkdownSpans.ts): a line-oriented subset of
// markdown, the one the chat renders. Pure Kotlin; rows parse off the main
// thread and hand the blocks to Compose.

enum class SpanStyle { Italic, Bold, Semibold, Code }

@Immutable
data class MarkdownSpan(val styles: Set<SpanStyle>, val text: String, val url: String? = null)

@Immutable
sealed interface MarkdownBlock {
    data class Text(val content: List<MarkdownSpan>) : MarkdownBlock
    data class Header(val level: Int, val content: List<MarkdownSpan>) : MarkdownBlock
    data class ListItem(val depth: Int, val spans: List<MarkdownSpan>)
    data class BulletList(val items: List<ListItem>) : MarkdownBlock
    data class NumberedItem(val number: Int, val depth: Int, val spans: List<MarkdownSpan>)
    data class NumberedList(val items: List<NumberedItem>) : MarkdownBlock
    data class CodeBlock(val language: String?, val content: String) : MarkdownBlock
    data class Mermaid(val content: String) : MarkdownBlock
    data object HorizontalRule : MarkdownBlock
    /** `<options>` the agent offers; tapping one sends it as the next message. */
    data class Options(val items: List<String>) : MarkdownBlock
    data class Table(val headers: List<List<MarkdownSpan>>, val rows: List<List<List<MarkdownSpan>>>) : MarkdownBlock
    data class Image(val alt: String, val url: String) : MarkdownBlock
}

private val SPAN_PATTERN = Regex("""(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))""")
private val URL_PATTERN = Regex("""https?://[^\s<]+""")
private val TRAILING_PUNCTUATION = Regex("""[),.;:!?]$""")
private val TABLE_SEPARATOR = Regex("""^[|\s\-:=]*$""")
private val OPTION = Regex("""<option>(.*?)</option>""")
private val IMAGE = Regex("""^!\[([^\]]*)\]\(([^)]+)\)$""")
private val NUMBERED = Regex("""^(\d+)\.\s+""")
private val BULLET = Regex("""^([-*+])\s+""")
private val HTTP_URL = Regex("^https?://", RegexOption.IGNORE_CASE)

fun isHttpMarkdownLink(url: String): Boolean = HTTP_URL.containsMatchIn(url.trim())

fun parseMarkdown(markdown: String): List<MarkdownBlock> = parseMarkdownBlocks(markdown)

private fun MutableList<MarkdownSpan>.pushTextWithAutoLinks(text: String, styles: Set<SpanStyle>) {
    var lastIndex = 0
    for (match in URL_PATTERN.findAll(text)) {
        val plain = text.substring(lastIndex, match.range.first)
        if (plain.isNotEmpty()) add(MarkdownSpan(styles, plain))
        var url = match.value
        var trailing = ""
        while (TRAILING_PUNCTUATION.containsMatchIn(url)) {
            trailing = url.last() + trailing
            url = url.dropLast(1)
        }
        if (url.isNotEmpty()) add(MarkdownSpan(styles, url, url))
        if (trailing.isNotEmpty()) add(MarkdownSpan(styles, trailing))
        lastIndex = match.range.last + 1
    }
    if (lastIndex < text.length) add(MarkdownSpan(styles, text.substring(lastIndex)))
}

fun parseMarkdownSpans(markdown: String, header: Boolean): List<MarkdownSpan> {
    val spans = ArrayList<MarkdownSpan>()
    var lastIndex = 0
    for (match in SPAN_PATTERN.findAll(markdown)) {
        // JS's global exec never yields an empty match here, but Kotlin's
        // findAll steps past one; an empty match carries nothing either way.
        if (match.value.isEmpty()) continue
        val plain = markdown.substring(lastIndex, match.range.first)
        if (plain.isNotEmpty()) spans.pushTextWithAutoLinks(plain, emptySet())
        val g = match.groups
        when {
            g[1] != null -> spans.pushTextWithAutoLinks(g[2]?.value.orEmpty(), if (header) emptySet() else setOf(SpanStyle.Bold))
            g[3] != null -> spans.pushTextWithAutoLinks(g[4]?.value.orEmpty(), if (header) emptySet() else setOf(SpanStyle.Italic))
            g[5] != null -> {
                val url = g[7]?.value
                if (url != null) spans.add(MarkdownSpan(emptySet(), g[6]!!.value, url))
                else spans.pushTextWithAutoLinks("[${g[6]!!.value}]", emptySet())
            }
            g[8] != null -> spans.add(MarkdownSpan(setOf(SpanStyle.Code), g[9]?.value.orEmpty()))
        }
        lastIndex = match.range.last + 1
    }
    if (lastIndex < markdown.length) spans.pushTextWithAutoLinks(markdown.substring(lastIndex), emptySet())
    return spans
}

/** Splits a pipe row into cells, dropping only the empty cells the outer pipes make. */
private fun splitTableRow(line: String): List<String> {
    var cells = line.trim().split('|').map { it.trim() }
    if (cells.isNotEmpty() && cells.first() == "") cells = cells.drop(1)
    if (cells.isNotEmpty() && cells.last() == "") cells = cells.dropLast(1)
    return cells
}

private fun parseTable(lines: List<String>, startIndex: Int): Pair<MarkdownBlock.Table?, Int> {
    var index = startIndex
    val tableLines = ArrayList<String>()
    // Blank lines between rows are skipped: models often put them there.
    while (index < lines.size) {
        if ('|' in lines[index]) {
            tableLines.add(lines[index])
            index++
        } else if (lines[index].isBlank()) {
            index++
        } else {
            break
        }
    }
    if (tableLines.size < 2) return null to startIndex
    val separator = tableLines[1].trim()
    if (!TABLE_SEPARATOR.matches(separator) || '-' !in separator) return null to startIndex
    val headers = splitTableRow(tableLines[0]).map { parseMarkdownSpans(it, false) }
    if (headers.isEmpty()) return null to startIndex
    val rows = tableLines.drop(2).map { row -> splitTableRow(row).map { parseMarkdownSpans(it, false) } }.filter { it.isNotEmpty() }
    return MarkdownBlock.Table(headers, rows) to index
}

private fun String.indent(): Int = length - trimStart().length

fun parseMarkdownBlocks(markdown: String): List<MarkdownBlock> {
    val blocks = ArrayList<MarkdownBlock>()
    val lines = markdown.split('\n')
    var index = 0
    outer@ while (index < lines.size) {
        val line = lines[index]
        index++

        for (level in 1..6) {
            if (line.startsWith("#".repeat(level) + " ")) {
                blocks.add(MarkdownBlock.Header(level, parseMarkdownSpans(line.substring(level + 1).trim(), true)))
                continue@outer
            }
        }

        val trimmed = line.trim()

        if (trimmed.startsWith("```")) {
            val language = trimmed.substring(3).trim().ifEmpty { null }
            val content = ArrayList<String>()
            while (index < lines.size) {
                val next = lines[index]
                index++
                if (next.trim() == "```") break
                content.add(next)
            }
            val text = content.joinToString("\n")
            blocks.add(if (language == "mermaid") MarkdownBlock.Mermaid(text) else MarkdownBlock.CodeBlock(language, text))
            continue
        }

        if (trimmed == "---") {
            blocks.add(MarkdownBlock.HorizontalRule)
            continue
        }

        if (trimmed.startsWith("<options>")) {
            val items = ArrayList<String>()
            while (index < lines.size) {
                val next = lines[index]
                index++
                if (next.trim() == "</options>") break
                OPTION.find(next)?.let { items.add(it.groupValues[1]) }
            }
            if (items.isNotEmpty()) blocks.add(MarkdownBlock.Options(items))
            continue
        }

        IMAGE.find(trimmed)?.let { match ->
            blocks.add(MarkdownBlock.Image(match.groupValues[1], match.groupValues[2].trim()))
            continue@outer
        }

        NUMBERED.find(trimmed)?.let { first ->
            data class Line(val number: Int, val indent: Int, val content: String)
            val all = arrayListOf(Line(first.groupValues[1].toIntOrNull() ?: 0, line.indent(), trimmed.substring(first.value.length)))
            while (index < lines.size) {
                val raw = lines[index]
                val nextTrimmed = raw.trim()
                val next = NUMBERED.find(nextTrimmed) ?: break
                all.add(Line(next.groupValues[1].toIntOrNull() ?: 0, raw.indent(), nextTrimmed.substring(next.value.length)))
                index++
            }
            val base = all.first().indent
            blocks.add(MarkdownBlock.NumberedList(all.map { MarkdownBlock.NumberedItem(it.number, Math.floorDiv(it.indent - base, 2), parseMarkdownSpans(it.content, false)) }))
            continue@outer
        }

        BULLET.find(trimmed)?.let { first ->
            val all = arrayListOf(line.indent() to trimmed.substring(first.value.length))
            while (index < lines.size) {
                val raw = lines[index]
                val nextTrimmed = raw.trim()
                val next = BULLET.find(nextTrimmed) ?: break
                all.add(raw.indent() to nextTrimmed.substring(next.value.length))
                index++
            }
            val base = all.first().first
            blocks.add(MarkdownBlock.BulletList(all.map { (indent, content) -> MarkdownBlock.ListItem(Math.floorDiv(indent - base, 2), parseMarkdownSpans(content, false)) }))
            continue@outer
        }

        if ('|' in trimmed) {
            val (table, next) = parseTable(lines, index - 1)
            if (table != null) {
                blocks.add(table)
                index = next
                continue@outer
            }
        }

        if (trimmed.isNotEmpty()) blocks.add(MarkdownBlock.Text(parseMarkdownSpans(trimmed, false)))
    }
    return blocks
}
