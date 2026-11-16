package com.slopus.happy.artifacts

import com.slopus.happy.chat.markdown.MarkdownFrontmatter
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Where a reference in an artifact's Markdown leads (iOS's
 * `ArtifactReference`). API.md: relative references inside a Markdown
 * entry resolve against the entry's own URL, exactly as a browser resolves
 * them, and every file of a version lives under the same prefix; a client
 * rendering the entry itself resolves each link and image the same way and
 * loads it through the file route.
 */
sealed interface ArtifactReference {
    /** A file of the same version, by its manifest `path`, and the fragment after `#`. Whether the manifest holds it is the caller's to check. */
    data class File(val path: String, val fragment: String? = null) : ArtifactReference
    /** Only a fragment: a place in the same document. */
    data class Fragment(val fragment: String) : ArtifactReference
    /** An http(s) address, which the phone reaches only through the agent connection. */
    data class Web(val url: String) : ArtifactReference
    /** A `data:` picture, read where it is written. */
    data class Data(val url: String) : ArtifactReference
    /** Any other scheme (`mailto:`, `tel:`), for the system to open. */
    data class External(val url: String) : ArtifactReference
    /** Malformed, or a path that leaves the artifact. */
    data object Refused : ArtifactReference
}

/** iOS's `ArtifactMarkdown`: references resolved against the document, and the document made ready for the chat's renderer. */
object ArtifactMarkdown {
    /**
     * Resolves [raw], as written in the document at [document] (a manifest
     * path), against that document's folder. `..` never climbs above the
     * version's root; a path that would is refused, as is one whose segments
     * decode to a separator, a backslash or a control character (the daemon
     * serves none of them). A leading `/` starts at the version's root
     * rather than leaving the artifact for the host's.
     */
    fun resolve(raw: String, document: String): ArtifactReference {
        var text = raw.trim()
        if (text.startsWith("<") && text.indexOf('>') > 0) {
            // `<a b.png>` is CommonMark's way to write a destination with spaces.
            text = text.substring(1, text.indexOf('>'))
        } else {
            // `url "title"`: the title is not part of the address.
            val space = text.indexOfFirst { it == ' ' || it == '\t' }
            if (space >= 0) text = text.substring(0, space)
        }
        if (text.isEmpty() || text.any { it.code < 32 || it.code == 127 }) return ArtifactReference.Refused
        if (text.startsWith("//")) {
            val url = "https:$text"
            return if (hostOf(url) != null) ArtifactReference.Web(url) else ArtifactReference.Refused
        }
        scheme(text)?.let { scheme ->
            val parsed = runCatching { URI(text) }.getOrNull() ?: return ArtifactReference.Refused
            return when (scheme) {
                "http", "https" -> if (!parsed.host.isNullOrEmpty()) ArtifactReference.Web(text) else ArtifactReference.Refused
                "data" -> ArtifactReference.Data(text)
                "javascript", "file", "vbscript" -> ArtifactReference.Refused
                else -> ArtifactReference.External(text)
            }
        }
        var fragment: String? = null
        val hash = text.indexOf('#')
        if (hash >= 0) {
            fragment = text.substring(hash + 1)
            text = text.substring(0, hash)
        }
        val query = text.indexOf('?')
        if (query >= 0) text = text.substring(0, query)
        if (text.isEmpty()) {
            fragment ?: return ArtifactReference.Refused
            return ArtifactReference.Fragment(percentDecode(fragment) ?: fragment)
        }
        val segments = ArrayList<String>()
        if (!text.startsWith("/")) {
            segments += document.split('/')
            segments.removeAt(segments.lastIndex)
        }
        val parts = text.split('/')
        for ((index, part) in parts.withIndex()) {
            val decoded = percentDecode(part) ?: return ArtifactReference.Refused
            if ('/' in decoded || '\\' in decoded || decoded.any { it.code < 32 || it.code == 127 }) return ArtifactReference.Refused
            when (decoded) {
                "." -> continue
                ".." -> {
                    if (segments.isEmpty()) return ArtifactReference.Refused
                    segments.removeAt(segments.lastIndex)
                }
                // A leading `/`, or `a//b`; a trailing `/` names a folder.
                "" -> if (index == parts.lastIndex && index > 0) return ArtifactReference.Refused
                else -> segments += decoded
            }
        }
        if (segments.isEmpty()) return ArtifactReference.Refused
        return ArtifactReference.File(segments.joinToString("/"), fragment)
    }

    /** RFC 3986's `scheme ":"`, lowercased; null for a relative reference. A single letter is a drive, not a scheme. */
    internal fun scheme(text: String): String? {
        val colon = text.indexOf(':')
        if (colon < 0) return null
        val scheme = text.substring(0, colon)
        val first = scheme.firstOrNull() ?: return null
        if (!first.isAsciiLetter() || !scheme.all { it.isAsciiLetter() || it in '0'..'9' || it in "+-." }) return null
        return if (scheme.length > 1) scheme.lowercase() else null
    }

    private fun hostOf(url: String): String? = runCatching { URI(url).host }.getOrNull()?.takeIf { it.isNotEmpty() }

    /**
     * Foundation's `removingPercentEncoding`: every `%XX` decoded as UTF-8;
     * null for a malformed escape or bytes that aren't UTF-8.
     */
    internal fun percentDecode(text: String): String? {
        if ('%' !in text) return text
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '%') {
                if (i + 2 > text.lastIndex) return null
                val high = Character.digit(text[i + 1], 16)
                val low = Character.digit(text[i + 2], 16)
                if (high < 0 || low < 0) return null
                out.write(high * 16 + low)
                i += 3
            } else {
                out.write(c.toString().toByteArray(Charsets.UTF_8))
                i++
            }
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray()))
                .toString()
        } catch (_: CharacterCodingException) {
            null
        }
    }

    /**
     * The document as the chat's renderer reads it, with every picture on a
     * line of its own, where its parser looks for one: soft breaks joined,
     * `<img>` and `<video>` written as Markdown images, a picture inside a
     * paragraph moved out between the words around it, and a linked picture
     * (`[![a](p)](l)`) shown as itself. Code is left as written, and so is
     * the document's frontmatter.
     */
    fun prepare(markdown: String): String {
        val split = MarkdownFrontmatter.split(markdown) ?: return prepareBody(markdown)
        return split.first + "\n" + prepareBody(split.second)
    }

    private fun prepareBody(markdown: String): String {
        val out = ArrayList<String>()
        var fence: String? = null
        for (text in joiningSoftBreaks(markdown).split('\n')) {
            val trimmed = text.trim(' ', '\t')
            val open = fence
            if (open != null) {
                out += text
                if (trimmed.startsWith(open)) fence = null
                continue
            }
            val marker = fenceMarker(trimmed)
            if (marker != null) {
                fence = marker
                out += text
                continue
            }
            // A table keeps its cells; a picture can't be drawn in one.
            if (trimmed.startsWith("|")) {
                out += text
                continue
            }
            out += split(html(text))
        }
        return out.joinToString("\n")
    }

    /** Every picture [prepare]d Markdown shows, as written, in order. */
    fun pictures(prepared: String): List<String> {
        val found = ArrayList<String>()
        var fence: String? = null
        for (line in (MarkdownFrontmatter.split(prepared)?.second ?: prepared).split('\n')) {
            val trimmed = line.trim(' ', '\t')
            val open = fence
            if (open != null) {
                if (trimmed.startsWith(open)) fence = null
                continue
            }
            val marker = fenceMarker(trimmed)
            if (marker != null) {
                fence = marker
                continue
            }
            WHOLE_IMAGE.find(trimmed)?.let { found += it.groupValues[2].trim(' ', '\t') }
        }
        return found
    }

    /**
     * `<img src alt>`, `<video src>` and `<source src>` as Markdown images.
     * On a line that had one, the tags wrapped around it (`<p
     * align="center">`, `<a>`, `<video controls>`) go: drawn, they would read as code.
     */
    internal fun html(line: String): String {
        if ('<' !in line) return line
        var result = line
        val images = ArrayList<String>()
        for (pattern in listOf(MEDIA, SOURCE)) {
            for (match in pattern.findAll(result).toList().asReversed()) {
                val tag = match.value
                val source = attribute("src", tag) ?: continue
                if ('>' in source) continue
                val alt = (attribute("alt", tag) ?: "").replace("]", "")
                // Held out while the wrappers go, so an address is never taken for a tag.
                result = result.replaceRange(match.range, "\u0001${images.size}\u0001")
                images += "![$alt](<$source>)"
            }
        }
        if (images.isEmpty()) return result
        result = WRAPPER.replace(result, " ")
        for ((index, image) in images.withIndex()) result = result.replace("\u0001$index\u0001", image)
        return result
    }

    /** A picture as the renderer's parser reads it: its address's parentheses escaped, which its pattern would stop at. */
    internal fun normalized(image: String): String {
        val open = image.indexOf("](")
        if (open < 0 || !image.endsWith(")")) return image
        val destination = image.substring(open + 2, image.length - 1)
        if ('(' !in destination && ')' !in destination) return image
        return image.substring(0, open + 2) + destination.replace("(", "%28").replace(")", "%29") + ")"
    }

    internal fun attribute(name: String, tag: String): String? {
        for (match in ATTRIBUTE.findAll(tag)) {
            if (match.groupValues[1].lowercase() != name) continue
            for (group in 2..4) match.groups[group]?.let { return decodeEntities(it.value) }
        }
        return null
    }

    internal fun decodeEntities(text: String): String {
        if ('&' !in text) return text
        return text.replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    }

    /** The line with each picture on a line of its own, outside code spans. */
    internal fun split(line: String): List<String> {
        val code = CODE_SPAN.findAll(line).map { it.range }.toList()
        val images = LINKED_IMAGE.findAll(line).map { it.range to it.groups[1]!!.range }.toList() +
            IMAGE.findAll(line).map { it.range to it.range }.toList()
        val pieces = ArrayList<Pair<IntRange, IntRange>>()
        for ((range, image) in images.sortedBy { it.first.first }) {
            if (code.any { it.overlaps(range) } || pieces.any { it.first.overlaps(range) }) continue
            pieces += range to image
        }
        if (pieces.isEmpty()) return listOf(line)
        val out = ArrayList<String>()
        var cursor = 0
        // Whatever opens the line (a list's marker, a quote's `>`) stays with the words before.
        for ((range, image) in pieces) {
            val before = line.substring(cursor, range.first).trim(' ', '\t')
            if (before.isNotEmpty()) out += before
            out += normalized(line.substring(image))
            cursor = range.last + 1
        }
        val after = line.substring(cursor).trim(' ', '\t')
        if (after.isNotEmpty()) out += after
        return out
    }

    private fun IntRange.overlaps(other: IntRange) = first <= other.last && other.first <= last

    // iOS's `Markdown.joiningSoftBreaks`: a paragraph's lines become one, as a soft break reads.

    internal fun joiningSoftBreaks(markdown: String): String {
        val out = ArrayList<String>()
        var fence: String? = null
        // The previous line is paragraph text a soft break may continue.
        var continues = false
        for (text in markdown.replace("\r\n", "\n").split('\n')) {
            val trimmed = text.trim(' ', '\t')
            val open = fence
            if (open != null) {
                out += text
                if (trimmed.startsWith(open)) fence = null
                continue
            }
            val marker = fenceMarker(trimmed)
            if (marker != null) {
                fence = marker
                out += text
                continues = false
                continue
            }
            if (trimmed.isEmpty()) {
                out += text
                continues = false
                continue
            }
            if (continues && !startsBlock(trimmed) && out.isNotEmpty()) {
                out[out.lastIndex] = out.last().trim(' ', '\t') + " " + trimmed
            } else {
                out += text
            }
            // A hard break (two trailing spaces or a backslash), a heading, a table row or a rule ends here.
            val hardBreak = text.endsWith("  ") || text.endsWith("\\")
            continues = !hardBreak && !trimmed.startsWith("#") && !trimmed.startsWith("|") && !isRule(trimmed)
        }
        return out.joinToString("\n")
    }

    internal fun fenceMarker(line: String): String? = when {
        line.startsWith("```") -> "```"
        line.startsWith("~~~") -> "~~~"
        else -> null
    }

    private fun startsBlock(line: String): Boolean {
        if (line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || isRule(line)) return true
        if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) return true
        val digits = line.takeWhile { it in '0'..'9' }
        if (digits.isNotEmpty() && digits.length <= 9) {
            val rest = line.substring(digits.length)
            if (rest.startsWith(". ") || rest.startsWith(") ")) return true
        }
        return false
    }

    private fun isRule(line: String): Boolean {
        val compact = line.filter { it != ' ' }
        val first = compact.firstOrNull() ?: return false
        return compact.length >= 3 && first in "-*_" && compact.all { it == first }
    }

    private fun Char.isAsciiLetter() = this in 'a'..'z' || this in 'A'..'Z'

    private val IMAGE = Regex("""!\[[^\]]*\]\((?:<[^>]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)""")
    private val LINKED_IMAGE = Regex("""\[(!\[[^\]]*\]\((?:<[^>]*>|[^()\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\))\]\([^)]*\)""")
    /** What the chat's parser takes as a picture (`parseMarkdownBlocks`'s IMAGE). */
    private val WHOLE_IMAGE = Regex("""^!\[([^\]]*)\]\(([^)]+)\)$""")
    private val MEDIA = Regex("""<(?:img|video)\b[^>]*\bsrc\s*=[^>]*>""", RegexOption.IGNORE_CASE)
    private val SOURCE = Regex("""<source\b[^>]*\bsrc\s*=[^>]*>""", RegexOption.IGNORE_CASE)
    private val WRAPPER = Regex("""</?(?:p|div|center|a|picture|span|figure|video|br)\b[^>]*>""", RegexOption.IGNORE_CASE)
    private val ATTRIBUTE = Regex("""([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
    private val CODE_SPAN = Regex("""`+[^`]*`+""")
}
