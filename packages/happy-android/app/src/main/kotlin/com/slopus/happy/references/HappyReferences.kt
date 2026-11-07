package com.slopus.happy.references

import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.agent.HappyShareLinks
import com.slopus.happy.agent.HappyUrls
import java.util.UUID

/**
 * Happy reference tags (`<happy-KIND id="…"/>`) an agent writes inline in
 * its Markdown: a tag carries only identity, and the reader shows the live
 * name of what it names. iOS `HappyReferences` (d95fc8b0f), itself a port of
 * `@slopus/happy-agent-client`'s `happyReferences.ts` and the
 * `markdownBlocks.ts` it scans with, over UTF-16 as the reference counts, so
 * all three agree on exactly what is a tag: never inside a code span or
 * fenced code, never after a backslash, and a malformed tag is ordinary text.
 */
object HappyReferences {
    data class Reference(
        val kind: String,
        val id: String,
        /** An artifact's version. */
        val version: Int? = null,
        /** A service's workspace. */
        val workspaceId: String? = null,
    )

    sealed interface Segment {
        data class Text(val text: String) : Segment
        /** [source] is the tag exactly as written. */
        data class Tag(val reference: Reference, val source: String) : Segment
    }

    /** The kinds a reader resolves; any other well-formed kind reads as inert text. */
    val knownKinds: Set<String> = setOf("artifact", "agent", "workspace", "project", "service", "user")

    internal const val MAX_TAG_LENGTH = 512
    internal const val MAX_VALUE_LENGTH = 256

    /** Splits Markdown into text and references. Still [streaming], a trailing tag that has only partly arrived is held back. */
    fun parse(markdown: String, streaming: Boolean = false): List<Segment> {
        val (tags, end) = scan(markdown, streaming)
        val segments = ArrayList<Segment>(tags.size * 2 + 1)
        var position = 0
        for (tag in tags) {
            if (tag.start > position) segments += Segment.Text(markdown.substring(position, tag.start))
            segments += Segment.Tag(tag.reference, markdown.substring(tag.start, tag.end))
            position = tag.end
        }
        if (end > position) segments += Segment.Text(markdown.substring(position, end))
        return segments
    }

    /** Every complete tag outside code replaced by [replace]'s text. */
    fun replace(markdown: String, streaming: Boolean = false, replace: (Reference) -> String): String {
        if ('<' !in markdown) return markdown
        return buildString(markdown.length) {
            for (segment in parse(markdown, streaming)) when (segment) {
                is Segment.Text -> append(segment.text)
                is Segment.Tag -> append(replace(segment.reference))
            }
        }
    }

    /** Streaming text without a trailing tag still arriving, held back rather than flashed as raw text. */
    fun droppingPartialTag(text: String): String {
        if ('<' !in text) return text
        val end = scan(text, streaming = true).second
        return if (end == text.length) text else text.substring(0, end)
    }

    // Reading

    /**
     * The scheme of the links written for references. Minted once per
     * launch, as desktop's and iOS's are, so a link an agent wrote by hand
     * never passes for one: only a tag the grammar accepted becomes one.
     */
    val linkPrefix: String = "happy-reference-${UUID.randomUUID().toString().take(8)}:"

    /** `kind/id`, and `/version` when the reference pins one. */
    fun link(reference: Reference): String =
        "$linkPrefix${reference.kind}/${reference.id}" + (reference.version?.let { "/$it" } ?: "")

    /** A mention's link: `user/id`, and `/me` when it names the reader. */
    fun mentionLink(reference: Reference, me: Boolean): String = "${linkPrefix}user/${reference.id}" + if (me) "/me" else ""

    /** The person a mention's link names, and whether it is the reader. */
    fun mention(link: String): Pair<String, Boolean>? {
        if (!link.startsWith(linkPrefix)) return null
        val parts = link.substring(linkPrefix.length).split('/')
        if (!(parts.size == 2 || (parts.size == 3 && parts[2] == "me")) || parts[0] != "user" || !isId(parts[1])) return null
        return parts[1] to (parts.size == 3)
    }

    /** The reference a link written by [markdown] points at; null for a mention or any other link. */
    fun reference(link: String): Reference? {
        if (!link.startsWith(linkPrefix)) return null
        val parts = link.substring(linkPrefix.length).split('/')
        if ((parts.size != 2 && parts.size != 3) || !isId(parts[1])) return null
        if (parts.size == 2) return Reference(parts[0], parts[1])
        if (!isVersion(parts[2])) return null
        return Reference(parts[0], parts[1], version = parts[2].toInt())
    }

    /** Whether [link] is one [markdown] wrote: a reference or a mention. */
    fun owns(link: String): Boolean = link.startsWith(linkPrefix)

    /**
     * Whether a Markdown link to [url] opens in the app: a reference this
     * phone wrote (not a mention, which opens nothing), a Happy URL
     * (`happy://`, `happy-file:`) an agent did, or a link.happy.page share
     * link carrying one.
     */
    fun opensInApp(url: String): Boolean =
        (reference(url) != null && mention(url) == null) || com.slopus.happy.agent.HappyUrls.owns(url) ||
            com.slopus.happy.agent.HappyShareLinks.parse(url) != null

    /**
     * The Markdown a message is drawn from (desktop's
     * `messageReferencesResolve`): a reference that opens is a link with its
     * name, any other its words; a kind this build doesn't know is never asked about.
     */
    fun markdown(text: String, references: References, streaming: Boolean = false): String = replace(text, streaming) { reference ->
        val shown = if (reference.kind in knownKinds) references.view(reference) else References.View.Text(references.placeholder(reference))
        val name = label(shown.label).ifEmpty { label(references.placeholder(reference)) }
        when (shown) {
            is References.View.Link -> "[$name](${link(reference)})"
            is References.View.Mention -> "[$name](${mentionLink(reference, shown.me)})"
            is References.View.Text -> name
        }
    }

    /** The same words as plain text, for what is read aloud, copied or shown as written (`messageReferencesPlainText`). */
    fun plain(text: String, references: References, streaming: Boolean = false): String = replace(text, streaming) { reference ->
        if (reference.kind in knownKinds) references.view(reference).label else references.placeholder(reference)
    }

    /**
     * [text] with every share link outside code that names this installation
     * ([here]) written as the Happy link it carries (desktop's
     * `shareLinksHere`, 5a4c075c): a link keeps its words and opens the
     * `happy://` link; a bare or angle-bracketed one reads as the reference it
     * names, with its live name, where [references] say that opens, a file as
     * its path, and anything else as the address written, opening in the app.
     * Another server's share link stays a web address. Still [streaming], a
     * link at the very end may not have come whole and is left as written.
     */
    fun shareLinks(text: String, references: References?, here: (String) -> Boolean, streaming: Boolean = false): String {
        if (!text.contains(HappyShareLinks.PREFIX)) return text
        val cut = if (!streaming) text.length else text.lastIndexOf(HappyShareLinks.PREFIX).takeIf { start -> text.substring(start).none(Char::isWhitespace) } ?: text.length
        val head = HappyShareLinks.rewrite(text.substring(0, cut), here) { target, written ->
            val link = HappyUrls.parse(target.url)?.link
            val tag = link?.let(::tag)
            when {
                tag != null && references?.view(tag.first) is References.View.Link -> tag.second
                link is HappyLink.File -> "[${label(link.path)}](${target.url})"
                else -> "[${label(written)}](${target.url})"
            }
        }
        return head + text.substring(cut)
    }

    /** [text] with the share links naming this installation as the tags they read as, so what they name is read ([ReferenceReader.read]). */
    fun shareLinkTags(text: String, here: (String) -> Boolean): String =
        if (!text.contains(HappyShareLinks.PREFIX)) text
        else HappyShareLinks.rewrite(text, here) { target, written -> HappyUrls.parse(target.url)?.link?.let(::tag)?.second ?: written }

    /** The reference [link] names, and its tag; null for what no tag names (a Surface, a file, a settings page). */
    private fun tag(link: HappyLink): Pair<Reference, String>? {
        val reference = link as? HappyLink.Reference ?: return null
        val kind = when (reference.kind) {
            HappyReferenceKind.Artifact -> "artifact"
            HappyReferenceKind.Agent -> "agent"
            HappyReferenceKind.Workspace -> "workspace"
            HappyReferenceKind.Project -> "project"
            HappyReferenceKind.Service -> "service"
            HappyReferenceKind.User -> "user"
            HappyReferenceKind.Surface -> return null
        }
        val source = "<happy-$kind id=\"${reference.id}\"" +
            (reference.version?.let { " version=\"$it\"" } ?: "") +
            (reference.workspaceId?.let { " workspace=\"$it\"" } ?: "") + "/>"
        return Reference(kind, reference.id, reference.version, reference.workspaceId) to source
    }

    private val lineBreaks = Regex("\\s*[\\r\\n]+\\s*")

    /** A name as running words on one line. The chat's Markdown has no escapes, so what would open a span or end the link goes instead. */
    internal fun label(text: String): String = buildString {
        for (character in text.replace(lineBreaks, " ")) when (character) {
            '[' -> append('(')
            ']' -> append(')')
            '*', '`' -> Unit
            else -> append(character)
        }
    }.trim { it == '\t' || Character.getType(it) == Character.SPACE_SEPARATOR.toInt() }

    // Scan

    private class Tag(val start: Int, val end: Int, val reference: Reference)

    private const val OPEN = "<happy-"

    private fun isLower(c: Char) = c in 'a'..'z'
    private fun isUpper(c: Char) = c in 'A'..'Z'
    private fun isDigit(c: Char) = c in '0'..'9'
    private fun isBlank(c: Char) = c == ' ' || c == '\t'

    /** The complete tags outside code, and where the text ends once a streaming partial is dropped. */
    private fun scan(text: String, streaming: Boolean): Pair<List<Tag>, Int> {
        val tags = ArrayList<Tag>()
        for ((start, end) in textBlocks(text)) {
            val last = end == text.length
            var index = start
            while (index < end) {
                when (text[index]) {
                    '\\' -> index += 2
                    '`' -> index = skipCodeSpan(text, index, end, open = streaming && last)
                    '<' -> {
                        val tag = matchTag(text, index)
                        when {
                            tag != null -> {
                                tags += tag
                                index = tag.end
                            }
                            streaming && last && isTagPrefix(text, index) -> return tags to index
                            else -> index++
                        }
                    }
                    else -> index++
                }
            }
        }
        return tags to text.length
    }

    /** `^[ \t]*(?:>[ \t]?)*[ \t]*`: where the quote markers of the line [from] until [to] end. */
    private fun afterQuotes(text: String, from: Int, to: Int): Int {
        var index = from
        while (index < to && isBlank(text[index])) index++
        while (index < to && text[index] == '>') {
            index++
            if (index < to && isBlank(text[index])) index++
        }
        while (index < to && isBlank(text[index])) index++
        return index
    }

    private fun run(text: String, from: Int, to: Int, character: Char): Int {
        var index = from
        while (index < to && text[index] == character) index++
        return index - from
    }

    private fun blankFrom(text: String, from: Int, to: Int): Boolean {
        for (i in from until to) if (!isBlank(text[i]) && text[i] != '\r') return false
        return true
    }

    /**
     * `textBlocks`: the runs that are neither fenced code nor blank lines,
     * each with its line endings, as (start, end). A fence never closed runs to the end.
     */
    internal fun textBlocks(text: String): List<Pair<Int, Int>> {
        val blocks = ArrayList<Pair<Int, Int>>()
        var blockStart = -1
        var fenceMarker = ' '
        var fenceLength = 0
        var lineStart = 0
        while (lineStart < text.length) {
            val newline = text.indexOf('\n', lineStart)
            val lineStop = if (newline < 0) text.length else newline
            val lineEnd = if (newline < 0) text.length else newline + 1
            val at = afterQuotes(text, lineStart, lineStop)
            if (fenceLength > 0) {
                // `^…(`+|~+)[ \t\r]*$`
                if (at < lineStop && text[at] == fenceMarker) {
                    val length = run(text, at, lineStop, fenceMarker)
                    if (length >= fenceLength && blankFrom(text, at + length, lineStop)) fenceLength = 0
                }
            } else {
                var opened = false
                if (at < lineStop && (text[at] == '`' || text[at] == '~')) {
                    val marker = text[at]
                    val length = run(text, at, lineStop, marker)
                    var terminated = false
                    var backtick = false
                    for (i in at + length until lineStop) {
                        val c = text[i]
                        // `(.*)$` crosses no line terminator; a backtick fence's info has no backtick.
                        if (c == '\r' || c == '\u2028' || c == '\u2029') terminated = true
                        if (c == '`') backtick = true
                    }
                    if (length >= 3 && !terminated && !(marker == '`' && backtick)) {
                        if (blockStart >= 0) blocks += blockStart to lineStart
                        blockStart = -1
                        fenceMarker = marker
                        fenceLength = length
                        opened = true
                    }
                }
                if (!opened) {
                    if (blankFrom(text, lineStart, lineStop)) {
                        if (blockStart >= 0) blocks += blockStart to lineStart
                        blockStart = -1
                    } else if (blockStart < 0) {
                        blockStart = lineStart
                    }
                }
            }
            lineStart = lineEnd
        }
        if (blockStart >= 0) blocks += blockStart to text.length
        return blocks
    }

    /**
     * `skipCodeSpan`: past a code span opening at [start]. Backticks with no
     * closing run of the same length are literal, except at the end of
     * streaming text ([open]), where everything after the opening run is code.
     */
    internal fun skipCodeSpan(text: String, start: Int, end: Int, open: Boolean): Int {
        val length = run(text, start, text.length, '`')
        var index = start + length
        while (index < end) {
            val next = text.indexOf('`', index).takeIf { it in 0 until end } ?: break
            val closing = run(text, next, text.length, '`')
            if (closing == length) return next + closing
            index = next + closing
        }
        return if (open) end else start + length
    }

    /** The tag starting at [start]: `<happy-KIND (name="value")+ />`. */
    private fun matchTag(text: String, start: Int): Tag? {
        val count = text.length
        if (!text.startsWith(OPEN, start)) return null
        var index = start + OPEN.length
        // KIND: [a-z][a-z0-9]*(?:-[a-z0-9]+)*
        val kindStart = index
        if (index >= count || !isLower(text[index])) return null
        index++
        while (index < count) {
            if (isLower(text[index]) || isDigit(text[index])) {
                index++
            } else if (text[index] == '-' && index + 1 < count && (isLower(text[index + 1]) || isDigit(text[index + 1]))) {
                index += 2
            } else {
                break
            }
        }
        val kind = text.substring(kindStart, index)
        val attributes = HashMap<String, String>()
        var duplicate = false
        var seen = 0
        while (true) {
            val blanks = index
            while (index < count && isBlank(text[index])) index++
            if (index >= count) return null
            if (text[index] == '/') {
                if (seen == 0 || index + 1 >= count || text[index + 1] != '>') return null
                index += 2
                break
            }
            // Another attribute, after at least one blank.
            if (index == blanks || !isLower(text[index])) return null
            val nameStart = index
            index++
            while (index < count && (isLower(text[index]) || isDigit(text[index]) || text[index] == '-')) index++
            val name = text.substring(nameStart, index)
            if (index + 1 >= count || text[index] != '=' || text[index + 1] != '"') return null
            index += 2
            val valueStart = index
            while (index < count && text[index] != '"' && text[index] != '<' && text[index] != '>' && text[index] != '\r' && text[index] != '\n') index++
            if (index >= count || text[index] != '"' || index - valueStart > MAX_VALUE_LENGTH) return null
            val value = text.substring(valueStart, index)
            index++
            if (attributes.put(name, value) != null) duplicate = true
            seen++
        }
        if (index - start > MAX_TAG_LENGTH || duplicate) return null
        val id = attributes["id"]?.takeIf(::isId) ?: return null
        val version = attributes["version"]?.let { if (isVersion(it)) it.toInt() else return null }
        val workspaceId = attributes["workspace"]?.let { if (isId(it)) it else return null }
        return Tag(start, index, Reference(kind, id, version, workspaceId))
    }

    /** `[A-Za-z0-9_-]{1,128}` */
    private fun isId(value: String): Boolean =
        value.length in 1..128 && value.all { isLower(it) || isUpper(it) || isDigit(it) || it == '_' || it == '-' }

    /** `[1-9][0-9]{0,8}` */
    private fun isVersion(value: String): Boolean =
        value.length in 1..9 && value[0] != '0' && value.all(::isDigit)

    private enum class State { KindStart, Kind, KindDash, Space, Name, Equals, Value, AfterValue, Slash }

    /** Whether the text from [start], which is a `<`, could still grow into a complete tag. It walks code points, as the reference does. */
    private fun isTagPrefix(text: String, start: Int): Boolean {
        val length = text.length - start
        if (length >= MAX_TAG_LENGTH) return false
        if (length <= OPEN.length) return OPEN.startsWith(text.substring(start))
        if (!text.startsWith(OPEN, start)) return false
        var state = State.KindStart
        var attributeSeen = false
        var valueLength = 0
        var index = start + OPEN.length
        while (index < text.length) {
            val scalar = text.codePointAt(index)
            index += Character.charCount(scalar)
            val lower = scalar in 0x61..0x7A
            val digit = scalar in 0x30..0x39
            val blank = scalar == ' '.code || scalar == '\t'.code
            when (state) {
                State.KindStart, State.KindDash -> {
                    if (!(lower || (digit && state == State.KindDash))) return false
                    state = State.Kind
                }
                State.Kind -> when {
                    scalar == '-'.code -> state = State.KindDash
                    blank -> state = State.Space
                    !lower && !digit -> return false
                }
                State.Space -> when {
                    lower -> state = State.Name
                    scalar == '/'.code && attributeSeen -> state = State.Slash
                    !blank -> return false
                }
                State.Name -> when {
                    scalar == '='.code -> state = State.Equals
                    !lower && !digit && scalar != '-'.code -> return false
                }
                State.Equals -> {
                    if (scalar != '"'.code) return false
                    state = State.Value
                    valueLength = 0
                }
                State.Value -> when (scalar) {
                    '"'.code -> {
                        attributeSeen = true
                        state = State.AfterValue
                    }
                    '<'.code, '>'.code, '\r'.code, '\n'.code -> return false
                    else -> if (++valueLength > MAX_VALUE_LENGTH) return false
                }
                // A closed value is followed by a blank or `/>`, never directly by a name.
                State.AfterValue -> when {
                    blank -> state = State.Space
                    scalar == '/'.code -> state = State.Slash
                    else -> return false
                }
                State.Slash -> return false
            }
        }
        return true
    }
}
