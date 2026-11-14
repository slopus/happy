package com.slopus.happy.references

import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.agent.HappyShareLinks
import com.slopus.happy.agent.HappyUrl
import com.slopus.happy.agent.HappyUrls

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
    val knownKinds: Set<String> = setOf("artifact", "agent", "workspace", "project", "service", "surface", "user")

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
     * What a link's address names, read from the address itself when it is
     * drawn or tapped: a Happy URL (`happy://`, `happy-file:`), or a
     * link.happy.page share link as the Happy URL it carries. Null for a
     * malformed one and any other address.
     */
    fun target(url: String): HappyUrl? = HappyUrls.parse(HappyShareLinks.parse(url)?.url ?: url)

    /** The reference [url] names, and the installation it is locked to, if any: null for a file, a settings page or any other address. */
    fun reference(url: String): Pair<Reference, String?>? {
        val target = target(url) ?: return null
        val link = target.link as? HappyLink.Reference ?: return null
        return link.tagReference() to target.instanceId
    }

    /** Whether [url] names a person: a mention, drawn in the strong face and opening nothing. */
    fun mention(url: String): Boolean = reference(url)?.first?.kind == "user"

    /**
     * Whether a Markdown link to [url] is the app's own to open: a Happy URL
     * (`happy://`, `happy-file:`), well-formed or not, or a link.happy.page
     * share link carrying one. A mention opens nothing.
     */
    fun opensInApp(url: String): Boolean = (HappyUrls.owns(url) || HappyShareLinks.parse(url) != null) && !mention(url)

    /**
     * The Markdown a message is drawn from (desktop's `messageReferencesResolve`,
     * iOS `HappyReferences.markdown`). A Happy link, a share link or a
     * `happy://` one written as Markdown (`[](https://link.happy.page/…)`),
     * reads as the current name of what it names, whatever its label says
     * (a label goes stale on a rename), and keeps the address it was written
     * with: what it opens and whether it shimmers is read from that address
     * where it is drawn ([target], [References.resolve]). A person reads as "@"
     * and their name. What isn't found, archived, malformed or another
     * server's ([here] says which installation is this connection's) reads as
     * its placeholder ("an unavailable agent"), never the label: a share link
     * stays a link, so a tap says its server isn't connected, and a `happy://`
     * one is words. As on desktop, a deleted artifact is its last title as
     * words, a file link its path and a settings link "Settings"; a button
     * keeps its words. A bare link is its address. A tag (`<happy-agent id/>`)
     * reads as a link to the Happy URL it names, or as its words where it opens
     * nothing; a kind this build doesn't know is never asked about. Still
     * [streaming], a tag only partly come is held back.
     */
    fun markdown(text: String, references: References, streaming: Boolean = false, here: ((String) -> Boolean)? = null): String {
        val linked = HappyMarkdownLinks.replace(text) { match ->
            if (match.image) return@replace null
            val title = if (match.button) " \"button\"" else ""
            fun link(name: String) = "[$name](${match.url}$title)"
            // What opens nothing: a share link still says so when tapped, a Happy URL is its words.
            fun unresolved(words: String) = if (match.button || match.url.startsWith(HappyShareLinks.PREFIX)) link(words) else words
            val url = match.link ?: return@replace if (match.button) null else unresolved(label(references.words.unavailableReference))
            when (val target = url.link) {
                is HappyLink.Settings -> if (match.button) null else link(SETTINGS)
                is HappyLink.File -> if (match.button) null else link(label(target.path))
                is HappyLink.Reference -> {
                    val reference = target.tagReference()
                    val placeholder = label(references.placeholder(reference))
                    if (url.instanceId?.let { here?.invoke(it) != true } == true) return@replace unresolved(placeholder)
                    val shown = references.view(reference)
                    val name = label(shown.label).ifEmpty { placeholder }
                    when {
                        shown !is References.View.Text -> link(name)
                        name == placeholder -> unresolved(name)
                        // Named, not offered: a deleted artifact's last title, a hidden subagent's.
                        else -> if (match.button) link(name) else name
                    }
                }
            }
        }
        return replace(linked, streaming) { reference ->
            val shown = if (reference.kind in knownKinds) references.view(reference) else References.View.Text(references.placeholder(reference))
            val name = label(shown.label).ifEmpty { label(references.placeholder(reference)) }
            when (shown) {
                is References.View.Link, is References.View.Mention -> url(reference)?.let { "[$name]($it)" } ?: name
                is References.View.Text -> name
            }
        }
    }

    /**
     * The same words as plain text, for what is read aloud and copied
     * (`messageReferencesPlainText`): tags as their names, and everything
     * else, links among it, exactly as written.
     */
    fun plain(text: String, references: References, streaming: Boolean = false): String =
        replace(text, streaming) { reference ->
            if (reference.kind in knownKinds) references.view(reference).label else references.placeholder(reference)
        }

    /**
     * [text] with the Happy links naming this installation ([here]) as the
     * tags they read as, share links among them, so what they name is read
     * ([ReferenceReader.read]).
     */
    fun linkTags(text: String, here: ((String) -> Boolean)?): String =
        HappyMarkdownLinks.replace(text) { match ->
            val url = match.link ?: return@replace null
            if (url.instanceId != null && here?.invoke(url.instanceId) != true) return@replace null
            (url.link as? HappyLink.Reference)?.tagReference()?.let(::tagSource)
        }

    /** What a settings link with no words reads as (desktop's). */
    private const val SETTINGS = "Settings"

    /** [reference] as the tag that names it. */
    private fun tagSource(reference: Reference): String =
        "<happy-${reference.kind} id=\"${reference.id}\"" +
            (reference.version?.let { " version=\"$it\"" } ?: "") +
            (reference.workspaceId?.let { " workspace=\"$it\"" } ?: "") + "/>"

    /** The Happy URL a tag's [reference] names, on the conversation's own installation; null where the grammar has none. */
    private fun url(reference: Reference): String? {
        val kind = HappyReferenceKind.entries.firstOrNull { it.host == reference.kind + "s" } ?: return null
        return runCatching {
            HappyUrls.format(
                HappyLink.Reference(
                    kind,
                    reference.id,
                    version = reference.version.takeIf { kind == HappyReferenceKind.Artifact },
                    workspaceId = reference.workspaceId.takeIf { kind == HappyReferenceKind.Service },
                ),
            )
        }.getOrNull()
    }

    /** A Happy URL's entity as the reference a tag would name. */
    private fun HappyLink.Reference.tagReference(): Reference {
        val kind = when (kind) {
            HappyReferenceKind.Artifact -> "artifact"
            HappyReferenceKind.Agent -> "agent"
            HappyReferenceKind.Workspace -> "workspace"
            HappyReferenceKind.Project -> "project"
            HappyReferenceKind.Service -> "service"
            HappyReferenceKind.Surface -> "surface"
            HappyReferenceKind.User -> "user"
        }
        return Reference(kind, id, version, workspaceId)
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
