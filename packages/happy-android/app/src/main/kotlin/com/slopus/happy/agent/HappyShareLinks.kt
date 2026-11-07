package com.slopus.happy.agent

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/** What an agent is, as the row or page its link was copied from names it. Display only. */
enum class HappyShareRole(val wire: String) {
    Task("task"),
    Bot("bot"),
    Subtask("subtask"),
    Subagent("subagent"),
    Session("session"),
}

/** What a share link opens: [url], the canonical instance link `happy://<instanceId>/…`. */
data class HappyShareTarget(val url: String, val instanceId: String, val role: HappyShareRole? = null)

/**
 * Share links: a Happy instance link carried in the fragment of an https URL
 * on link.happy.page, so it can be pasted to anyone with access to the same
 * thing and opens the app from a browser.
 *
 *     https://link.happy.page/#1/<instanceId>/<rest>[?<param>=<value>&…]
 *
 * opens `happy://<instanceId>/<rest>`. The parameters are `as` (what an agent
 * is, for the page to say), `version` (an artifact's), and `lines` (a file's);
 * nothing else, no titles and no actions. The grammar is the page's own,
 * `link.happy.page/src/link.ts` in slopus/happy-link, ported exactly as
 * desktop's `happyShareLink.ts` (5a4c075c) has it: anything else is rejected
 * whole, and the Happy URL is always rebuilt from the parsed link, so a share
 * link can only ever open a canonical instance link.
 */
object HappyShareLinks {
    /** Where share links live; everything after `#` stays in the browser. */
    const val ORIGIN = "https://link.happy.page"

    const val PREFIX = "$ORIGIN/#"
    private const val PAYLOAD_VERSION = 1
    private const val MAX_PAYLOAD_LENGTH = 4096
    private const val MAX_NUMBER = 999_999_999

    private sealed interface Target {
        data class Agent(val id: String, val role: HappyShareRole? = null) : Target
        data class Artifact(val id: String, val version: Int? = null) : Target
        /** A workspace, project, surface or user: [host] is its plural. */
        data class Entity(val host: String, val id: String) : Target
        data class Service(val workspaceId: String, val id: String) : Target
        /** [owner] is `agents` or `workspaces`; [path] is decoded, relative to the workspace root. */
        data class File(val owner: String, val ownerId: String, val path: String, val lines: IntRange? = null) : Target
    }

    private class Link(val instanceId: String, val target: Target)

    private const val ID = "[A-Za-z0-9_-]{1,128}"
    private const val NUMBER = "[1-9][0-9]{0,8}"
    private const val INSTANCE = "[a-z][a-z0-9]{23}"
    private const val ENCODED_PATH = "[A-Za-z0-9\\-._~!$&'*+,;=:@%/]+"
    private const val HOSTS = "agents|artifacts|workspaces|projects|surfaces|users"

    // matchEntire throughout: Java's `$` would also match before a final line break, JavaScript's doesn't.
    private val VERSIONED = Regex("^([0-9]+)/")
    private val INSTANCE_PREFIX = Regex("^($INSTANCE)/")
    private val ENTITY = Regex("($HOSTS)/($ID)")
    private val SERVICE = Regex("workspaces/($ID)/services/($ID)")
    private val FILE = Regex("(agents|workspaces)/($ID)/files/($ENCODED_PATH)")
    private val PARAM = Regex("([a-z]+)=([A-Za-z0-9\\-._~%]+)")
    private val NUMBER_ONLY = Regex(NUMBER)
    private val LINES = Regex("($NUMBER)(?:-($NUMBER))?")
    private val ID_ONLY = Regex(ID)
    private val INSTANCE_ONLY = Regex(INSTANCE)

    private val HAPPY_INSTANCE_URL = Regex("happy://($INSTANCE)/(.+)", RegexOption.DOT_MATCHES_ALL)
    private val HAPPY_ENTITY = Regex("($HOSTS)/($ID)(?:\\?version=($NUMBER))?")
    private val HAPPY_FILE = Regex("(agents|workspaces)/($ID)/files/($ENCODED_PATH)(?:#L($NUMBER)(?:-L($NUMBER))?)?")

    /**
     * The share link for an instance link, `happy://<instanceId>/…`, or null
     * for anything else: a link with no instance has no form that leaves the
     * app. [role] says what an agent is and is refused on anything but an agent.
     */
    fun format(happyUrl: String, role: HappyShareRole? = null): String? {
        val link = instanceUrlParse(happyUrl, role) ?: return null
        return try {
            PREFIX + payloadEncode(link)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** The share link for [link] on installation [instanceId]; null where it has none (no instance, or a settings page). */
    fun format(link: HappyLink, instanceId: String?, role: HappyShareRole? = null): String? {
        if (instanceId == null || link is HappyLink.Settings) return null
        val url = try {
            HappyUrls.format(link, instanceId)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return format(url, role)
    }

    /**
     * What a share link opens, or null for anything that is not exactly one:
     * another host, a fragment the grammar refuses, or one naming no instance.
     */
    fun parse(url: String): HappyShareTarget? {
        if (!url.startsWith(PREFIX)) return null
        val link = payloadDecode(url.substring(PREFIX.length)) ?: return null
        val happyUrl = try {
            happyUrlFormat(link)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return HappyShareTarget(happyUrl, link.instanceId, (link.target as? Target.Agent)?.role)
    }

    // A share link as Markdown can hold it: up to what the grammar allows, which
    // never includes whitespace, brackets, parentheses, or quotes.
    private val SHARE_URL_IN_TEXT = Regex("https://link\\.happy\\.page/#1/[A-Za-z0-9\\-._~!$&'*+,;=:@%/?]+")
    private val SHARE_URL_ANGLED = Regex("<(https://link\\.happy\\.page/#1/[^\\s<>]+)>")
    // What GFM leaves off the end of a bare URL as the sentence around it.
    private val TRAILING_PUNCTUATION = Regex("[?!.,:*_~']+$")

    /**
     * Markdown with every share link outside code whose instance [here]
     * accepts written as the instance link it opens, so it reads exactly as
     * that `happy://` link would: a link's destination is replaced, and a bare
     * or angle-bracketed URL becomes [bare]'s Markdown, by default an
     * empty-label link that takes its target's title. Any other share link
     * stays as written: it is a web address.
     */
    fun rewrite(
        markdown: String,
        here: (String) -> Boolean,
        bare: (target: HappyShareTarget, written: String) -> String = { target, _ -> "[](${target.url})" },
    ): String {
        if (!markdown.contains(PREFIX)) return markdown
        fun opened(candidate: String): HappyShareTarget? = parse(candidate)?.takeIf { here(it.instanceId) }
        return markdownOutsideCodeMap(markdown) { text ->
            // `<url>`: the brackets are the link.
            val angled = SHARE_URL_ANGLED.replace(text) { match ->
                val url = match.groupValues[1]
                opened(url)?.let { bare(it, url) } ?: match.value
            }
            SHARE_URL_IN_TEXT.replace(angled) { match ->
                val before = angled.substring(0, match.range.first)
                when {
                    // Inside angle brackets another server's link stays one; a link's label is its words.
                    before.endsWith("<") || before.endsWith("[") -> match.value
                    // A link's destination is replaced as it stands.
                    before.endsWith("](") -> opened(match.value)?.url ?: match.value
                    else -> {
                        val url = match.value.replace(TRAILING_PUNCTUATION, "")
                        opened(url)?.let { bare(it, url) + match.value.substring(url.length) } ?: match.value
                    }
                }
            }
        }
    }

    /** Applies [map] to every run of [markdown] outside fenced code and inline code spans, which stay literal as Markdown reads them. */
    private fun markdownOutsideCodeMap(markdown: String, map: (String) -> String): String {
        val lines = markdown.split("\n")
        var fence: String? = null
        val prose = ArrayList<String>()
        val out = ArrayList<String>()
        fun flush() {
            if (prose.isEmpty()) return
            out += inlineOutsideCodeMap(prose.joinToString("\n"), map)
            prose.clear()
        }
        for (line in lines) {
            val opener = FENCE_OPEN.find(line)?.groupValues?.get(1)
            val open = fence
            if (open == null && opener != null) {
                flush()
                fence = opener
                out += line
            } else if (open != null) {
                if (Regex("^ {0,3}${if (open[0] == '`') "`" else "~"}{${open.length},}\\s*$").containsMatchIn(line)) fence = null
                out += line
            } else {
                prose += line
            }
        }
        flush()
        return out.joinToString("\n")
    }

    private val FENCE_OPEN = Regex("^ {0,3}(`{3,}|~{3,})")

    /** Applies [map] outside inline code spans: a run of backticks closed by the same run. */
    private fun inlineOutsideCodeMap(text: String, map: (String) -> String): String {
        val out = StringBuilder()
        var index = 0
        var start = 0
        while (index < text.length) {
            if (text[index] == '\\') {
                index += 2
                continue
            }
            if (text[index] != '`') {
                index += 1
                continue
            }
            var run = 1
            while (index + run < text.length && text[index + run] == '`') run += 1
            val ticks = "`".repeat(run)
            var close = text.indexOf(ticks, index + run)
            while (close != -1 && close + run < text.length && text[close + run] == '`') {
                var after = close + run
                while (after < text.length && text[after] == '`') after += 1
                close = text.indexOf(ticks, after)
            }
            if (close == -1) {
                index += run
                continue
            }
            out.append(map(text.substring(start, index))).append(text, index, close + run)
            index = close + run
            start = index
        }
        return out.append(map(text.substring(minOf(start, text.length)))).toString()
    }

    private fun payloadDecode(payload: String): Link? {
        if (payload.isEmpty() || payload.length > MAX_PAYLOAD_LENGTH) return null
        val versioned = VERSIONED.find(payload) ?: return null
        if (versioned.groupValues[1] != PAYLOAD_VERSION.toString()) return null
        val body = payload.substring(versioned.value.length)
        val instance = INSTANCE_PREFIX.find(body) ?: return null
        val target = bodyParse(body.substring(instance.value.length)) ?: return null
        return Link(instance.groupValues[1], target)
    }

    /** Throws [IllegalArgumentException] for a link the grammar can't express. */
    private fun payloadEncode(link: Link): String {
        // Formatting validates the whole link.
        happyUrlFormat(link)
        val params = ArrayList<String>()
        val rest = when (val target = link.target) {
            is Target.Agent -> {
                target.role?.let { params += "as=${it.wire}" }
                "agents/${target.id}"
            }
            is Target.Artifact -> {
                target.version?.let { params += "version=$it" }
                "artifacts/${target.id}"
            }
            is Target.Service -> "workspaces/${target.workspaceId}/services/${target.id}"
            is Target.File -> {
                target.lines?.let { params += "lines=${linesFormat(it, "")}" }
                "${target.owner}/${target.ownerId}/files/${target.path.split('/').joinToString("/", transform = ::segmentEncode)}"
            }
            is Target.Entity -> "${target.host}/${target.id}"
        }
        val query = if (params.isEmpty()) "" else "?" + params.joinToString("&")
        val payload = "$PAYLOAD_VERSION/${link.instanceId}/$rest$query"
        require(payload.length <= MAX_PAYLOAD_LENGTH) { INVALID }
        return payload
    }

    /** The canonical `happy://<instanceId>/…` URL for [link]. Throws [IllegalArgumentException] for an invalid one. */
    private fun happyUrlFormat(link: Link): String {
        require(INSTANCE_ONLY.matches(link.instanceId)) { INVALID }
        val rest = when (val target = link.target) {
            is Target.Agent -> {
                require(ID_ONLY.matches(target.id)) { INVALID }
                "agents/${target.id}"
            }
            is Target.Artifact -> {
                require(ID_ONLY.matches(target.id)) { INVALID }
                require(target.version == null || numberValid(target.version)) { INVALID }
                "artifacts/${target.id}" + (target.version?.let { "?version=$it" } ?: "")
            }
            is Target.Entity -> {
                require(target.host in ENTITY_HOSTS && ID_ONLY.matches(target.id)) { INVALID }
                "${target.host}/${target.id}"
            }
            is Target.Service -> {
                require(ID_ONLY.matches(target.workspaceId) && ID_ONLY.matches(target.id)) { INVALID }
                "workspaces/${target.workspaceId}/services/${target.id}"
            }
            is Target.File -> {
                require(target.owner == "agents" || target.owner == "workspaces") { INVALID }
                require(ID_ONLY.matches(target.ownerId)) { INVALID }
                val segments = target.path.split('/')
                require(segments.all(::isSegment)) { INVALID }
                val lines = target.lines?.let {
                    require(numberValid(it.first) && numberValid(it.last) && it.last >= it.first) { INVALID }
                    "#" + linesFormat(it, "L")
                }.orEmpty()
                "${target.owner}/${target.ownerId}/files/${segments.joinToString("/", transform = ::segmentEncode)}$lines"
            }
        }
        val url = "happy://${link.instanceId}/$rest"
        require(url.length <= MAX_PAYLOAD_LENGTH) { INVALID }
        return url
    }

    private val ENTITY_HOSTS = setOf("workspaces", "projects", "surfaces", "users")

    /** An instance link as a share link, or null for anything that is not exactly one. */
    private fun instanceUrlParse(url: String, role: HappyShareRole?): Link? {
        if (url.length > MAX_PAYLOAD_LENGTH) return null
        val instance = HAPPY_INSTANCE_URL.matchEntire(url) ?: return null
        val (instanceId, rest) = instance.destructured
        val entity = HAPPY_ENTITY.matchEntire(rest)
        val service = SERVICE.matchEntire(rest)
        val file = HAPPY_FILE.matchEntire(rest)
        var target: Target = when {
            entity != null -> {
                val (host, id, version) = entity.destructured
                val target = entityTarget(host, id)
                if (version.isEmpty()) target
                else if (target is Target.Artifact) target.copy(version = version.toInt())
                else return null
            }
            service != null -> Target.Service(service.groupValues[1], service.groupValues[2])
            file != null -> {
                val (host, ownerId, encodedPath, start, end) = file.destructured
                fileTarget(host, ownerId, encodedPath, start.ifEmpty { null }, end.ifEmpty { null }) ?: return null
            }
            else -> return null
        }
        if (role != null) {
            if (target !is Target.Agent) return null
            target = target.copy(role = role)
        }
        val link = Link(instanceId, target)
        return try {
            link.takeIf { happyUrlFormat(it) == url }
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun bodyParse(body: String): Target? {
        val question = body.indexOf('?')
        val rest = if (question == -1) body else body.substring(0, question)
        val params = paramsParse(if (question == -1) null else body.substring(question + 1)) ?: return null

        val allowed = HashSet<String>()
        val entity = ENTITY.matchEntire(rest)
        val service = SERVICE.matchEntire(rest)
        val file = FILE.matchEntire(rest)
        val target: Target = when {
            entity != null -> when (val target = entityTarget(entity.groupValues[1], entity.groupValues[2])) {
                is Target.Agent -> {
                    allowed += "as"
                    val role = params["as"]?.let { value -> HappyShareRole.entries.firstOrNull { it.wire == value } ?: return null }
                    target.copy(role = role)
                }
                is Target.Artifact -> {
                    allowed += "version"
                    val version = params["version"]?.let { if (NUMBER_ONLY.matches(it)) it.toInt() else return null }
                    target.copy(version = version)
                }
                else -> target
            }
            service != null -> Target.Service(service.groupValues[1], service.groupValues[2])
            file != null -> {
                allowed += "lines"
                val lines = params["lines"]
                val range = lines?.let { LINES.matchEntire(it) ?: return null }
                fileTarget(file.groupValues[1], file.groupValues[2], file.groupValues[3], range?.groupValues?.get(1), range?.groupValues?.get(2)?.ifEmpty { null }) ?: return null
            }
            else -> return null
        }
        if (params.keys.any { it !in allowed }) return null
        return target
    }

    /** Strict `key=value&…`: lowercase keys, each once, values non-empty. */
    private fun paramsParse(query: String?): Map<String, String>? {
        val params = LinkedHashMap<String, String>()
        if (query == null) return params
        for (pair in query.split('&')) {
            val match = PARAM.matchEntire(pair) ?: return null
            val (key, encoded) = match.destructured
            val value = valueDecode(encoded) ?: return null
            if (key in params) return null
            params[key] = value
        }
        return params
    }

    private fun entityTarget(host: String, id: String): Target = when (host) {
        "agents" -> Target.Agent(id)
        "artifacts" -> Target.Artifact(id)
        else -> Target.Entity(host, id)
    }

    private fun fileTarget(host: String, ownerId: String, encodedPath: String, start: String?, end: String?): Target? {
        val segments = ArrayList<String>()
        for (segment in encodedPath.split('/')) {
            val decoded = valueDecode(segment)
            // An encoded `%2F` is never a separator, and `.`, `..`, `\`, and control characters are out.
            if (decoded == null || !isSegment(decoded)) return null
            segments += decoded
        }
        val lines = start?.let {
            val first = it.toInt()
            val last = end?.toInt() ?: first
            if (last < first) return null
            first..last
        }
        return Target.File(host, ownerId, segments.joinToString("/"), lines)
    }

    private fun linesFormat(lines: IntRange, prefix: String): String =
        if (lines.first == lines.last) "$prefix${lines.first}" else "$prefix${lines.first}-$prefix${lines.last}"

    /** A decoded path segment: never `.` or `..`, and no `/`, `\`, or control character. */
    private fun isSegment(segment: String): Boolean =
        segment.isNotEmpty() && segment != "." && segment != ".." &&
            segment.none { it == '/' || it == '\\' || it.code <= 0x1f || it.code in 0x7f..0x9f }

    /** decodeURIComponent: a `%` that starts no escape, and bytes that are not UTF-8, refuse it. */
    private fun valueDecode(value: String): String? {
        if (value.isEmpty()) return null
        val bytes = ByteArrayOutputStream()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '%') {
                if (i + 2 >= value.length) return null
                val high = Character.digit(value[i + 1], 16)
                val low = Character.digit(value[i + 2], 16)
                if (high < 0 || low < 0) return null
                bytes.write(high * 16 + low)
                i += 3
            } else {
                // The grammar lets only ASCII this far.
                if (c.code > 0x7f) return null
                bytes.write(c.code)
                i += 1
            }
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        } catch (_: CharacterCodingException) {
            null
        }
    }

    /** Percent-encodes every byte but the unreserved characters; throws for a lone surrogate, which has no UTF-8. */
    private fun segmentEncode(segment: String): String {
        val bytes = try {
            Charsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(CharBuffer.wrap(segment))
        } catch (_: CharacterCodingException) {
            throw IllegalArgumentException(INVALID)
        }
        return buildString {
            while (bytes.hasRemaining()) {
                val b = bytes.get().toInt() and 0xff
                val c = b.toChar()
                if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_' || c == '.' || c == '~') append(c)
                else append('%').append(HEX[b shr 4]).append(HEX[b and 0xf])
            }
        }
    }

    private const val HEX = "0123456789ABCDEF"

    private fun numberValid(value: Int): Boolean = value in 1..MAX_NUMBER

    private const val INVALID = "The Happy share link is invalid."
}
