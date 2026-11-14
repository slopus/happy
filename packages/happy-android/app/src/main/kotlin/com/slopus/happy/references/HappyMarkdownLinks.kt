package com.slopus.happy.references

import com.slopus.happy.agent.HappyShareLinks
import com.slopus.happy.agent.HappyUrl

/**
 * The Happy links an agent writes as Markdown inline links,
 * `[](https://link.happy.page/#1/…)`, `[label](happy://agents/…)`,
 * `![alt](happy://artifacts/…)` or with a title,
 * `[label](happy://settings/providers "button")`: found the way
 * `@slopus/happy-agent-client`'s `parseHappyLinks` finds them, as iOS
 * `HappyMarkdownLinks` ports it, the label possibly empty. Never in fenced
 * code or a code span, never after a backslash, and never across a blank
 * line. Only destinations under the `happy` or `happy-file` scheme, and
 * link.happy.page share links, are Happy links; every other link is left as
 * written.
 */
object HappyMarkdownLinks {
    data class Match(
        /** The Markdown between the brackets, as written. */
        val label: String,
        /** The destination as written: a Happy URL or a share link. */
        val url: String,
        /** What it opens, a share link as the Happy URL it carries; null when the destination is malformed. */
        val link: HappyUrl?,
        /** Titled exactly `button`. */
        val button: Boolean,
        /** The link exactly as written. */
        val source: String,
        /** Where [source] is in the text. */
        val start: Int,
        val end: Int,
    ) {
        /** `![alt](…)`: a picture, not words. */
        val image: Boolean get() = source.startsWith("!")
    }

    /** Every Happy link in [markdown], in order. */
    fun matches(markdown: String): List<Match> {
        if (!markdown.contains("happy", ignoreCase = true) && !markdown.contains(HappyShareLinks.PREFIX)) return emptyList()
        val found = ArrayList<Match>()
        for ((blockStart, blockEnd) in HappyReferences.textBlocks(markdown)) {
            var index = blockStart
            while (index < blockEnd) {
                when (markdown[index]) {
                    '\\' -> index += 2
                    '`' -> index = HappyReferences.skipCodeSpan(markdown, index, blockEnd, open = false)
                    '[' -> {
                        val start = if (index > blockStart && markdown[index - 1] == '!') index - 1 else index
                        val match = match(markdown, index, blockEnd, start)
                        if (match != null) {
                            found += match
                            index = match.end
                        } else {
                            index++
                        }
                    }
                    else -> index++
                }
            }
        }
        return found
    }

    /** [markdown] with each Happy link replaced by [replace]'s text, or left as written where it answers null. */
    fun replace(markdown: String, replace: (Match) -> String?): String {
        val found = matches(markdown)
        if (found.isEmpty()) return markdown
        return buildString(markdown.length) {
            var position = 0
            for (match in found) {
                append(markdown, position, match.start)
                append(replace(match) ?: match.source)
                position = match.end
            }
            append(markdown, position, markdown.length)
        }
    }

    /** Whether [url] is under the `happy` or `happy-file` scheme, in any letter case, well-formed or not. */
    fun isHappyUrl(url: String): Boolean =
        url.startsWith("happy:", ignoreCase = true) || url.startsWith("happy-file:", ignoreCase = true)

    private fun isSpace(c: Char) = c == ' ' || c == '\t' || c == '\r' || c == '\n'

    /** The link whose `[` is at [at]: balanced brackets, then `(`, the destination bare or in `<>`, an optional title, and `)`. */
    private fun match(text: String, at: Int, end: Int, start: Int): Match? {
        var index = at + 1
        var depth = 1
        while (index < end) {
            val c = text[index]
            if (c == '\\') {
                index += 2
                continue
            }
            if (c == '`') {
                index = HappyReferences.skipCodeSpan(text, index, end, open = false)
                continue
            }
            if (c == '[') depth++
            if (c == ']') {
                depth--
                if (depth == 0) break
            }
            index++
        }
        if (index >= end || depth != 0) return null
        val labelEnd = index
        index++
        if (index >= end || text[index] != '(') return null
        index++
        while (index < end && isSpace(text[index])) index++
        val destinationStart: Int
        val destinationEnd: Int
        if (index < end && text[index] == '<') {
            destinationStart = index + 1
            index = destinationStart
            while (index < end && text[index] != '>' && text[index] != '<' && text[index] != '\n') index++
            if (index >= end || text[index] != '>') return null
            destinationEnd = index
            index++
        } else {
            destinationStart = index
            var parens = 0
            while (index < end && !isSpace(text[index])) {
                if (text[index] == '\\') {
                    index += 2
                    continue
                }
                if (text[index] == '(') parens++
                if (text[index] == ')') {
                    if (parens == 0) break
                    parens--
                }
                index++
            }
            index = minOf(index, end)
            destinationEnd = index
        }
        val url = text.substring(destinationStart, destinationEnd)
        if (!isHappyUrl(url) && !url.startsWith(HappyShareLinks.PREFIX)) return null
        var title: String? = null
        val beforeTitle = index
        while (index < end && isSpace(text[index])) index++
        if (index < end && index > beforeTitle && text[index] in "\"'(") {
            val closer = if (text[index] == '(') ')' else text[index]
            val from = index + 1
            index = from
            while (index < end && text[index] != closer) {
                if (text[index] == '\\') index++
                index++
            }
            if (index >= end) return null
            title = text.substring(from, index)
            index++
            while (index < end && isSpace(text[index])) index++
        }
        if (index >= end || text[index] != ')') return null
        index++
        return Match(
            label = text.substring(at + 1, labelEnd),
            url = url,
            link = HappyReferences.target(url),
            button = title == "button",
            source = text.substring(start, index),
            start = start,
            end = index,
        )
    }
}
