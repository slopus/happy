package com.slopus.happy.agent

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Happy URLs, as `@slopus/happy-agent-client`'s happyLinks.ts reads and
 * writes them, so the phone agrees with the daemon and every other client
 * on what a link names: `happy://artifacts/<id>?version=2`,
 * `happy://workspaces/<w>/services/<s>`, `happy://agents/<a>/files/<path>#L3-L9`,
 * `happy://settings/providers` and the API's `happy-file://agents/<a>/<path>`.
 *
 * External links (edge SSO contract §7) are locked to one installation:
 * `happy://<instanceId>/<remainder>`, the remainder exactly an internal
 * URL without its `happy://`. An instance id is health's `instanceId`, 24
 * lowercase characters, a length no internal host or mobile route has.
 *
 * The grammar is strict: anything else is malformed and never partly
 * interpreted.
 */
enum class HappyReferenceKind(val host: String) {
    Artifact("artifacts"),
    Agent("agents"),
    Workspace("workspaces"),
    Project("projects"),
    Service("services"),
    Surface("surfaces"),
    User("users"),
}

/** What a Happy URL names: an entity, or a file in a workspace. */
sealed interface HappyLink {
    /** One entity. [version] only on an artifact; [workspaceId] always, and only, on a service. */
    data class Reference(val kind: HappyReferenceKind, val id: String, val version: Int? = null, val workspaceId: String? = null) : HappyLink

    /** One file; [path] is decoded and relative to the workspace root, [lines] inclusive. An agent target is that agent's workspace. */
    data class File(val target: Target, val path: String, val lines: IntRange? = null) : HappyLink

    sealed interface Target {
        data class Agent(val agentId: String) : Target
        data class Workspace(val workspaceId: String) : Target
    }

    /**
     * A page of the client's own settings, one of [HappyUrls.SETTINGS_PAGES];
     * it names no entity. [query] holds only what [HappyUrls.SETTINGS_QUERY]
     * allows (an add flow's `vendor` and `to`), never a credential.
     */
    data class Settings(val page: String, val query: Map<String, String> = emptyMap()) : HappyLink
}

/** A parsed Happy URL: [link], and the installation it is locked to when it came in external form. */
data class HappyUrl(val link: HappyLink, val instanceId: String? = null)

object HappyUrls {
    /** The settings pages a settings link may name, a closed list (API.md, "Settings links"). */
    val SETTINGS_PAGES = listOf(
        "general", "account", "sharing", "servers", "instructions", "secrets", "providers", "providers/import",
        "providers/add", "providers/add/openai", "providers/add/anthropic", "providers/add/api-key",
        "usage", "voice", "mobile-access", "members", "roles", "policy", "mcp", "computes",
    )

    /** What a settings link's query may carry, and each key's values: navigation only, never a secret. */
    val SETTINGS_QUERY = mapOf("vendor" to setOf("openai", "anthropic"), "to" to setOf("private", "team"))

    /** The longest URL, in characters. */
    const val MAX_LENGTH = 4096

    private const val MAX_NUMBER = 999_999_999
    private const val ID = "[A-Za-z0-9_-]{1,128}"
    private const val VERSION = "[1-9][0-9]{0,8}"
    private const val LINES = "#L($VERSION)(?:-L($VERSION))?"
    private const val ENCODED_PATH = "[A-Za-z0-9\\-._~!$&'*+,;=:@%/]+"
    private val ID_PATTERN = Regex(ID)
    private val INSTANCE_ID = Regex("[a-z][a-z0-9]{23}")

    // matchEntire throughout: Java's `$` would also match before a final line break, JavaScript's doesn't.
    private val ENTITY = Regex("happy://(artifacts|agents|workspaces|projects|surfaces|users)/($ID)(?:\\?version=($VERSION))?")
    private val SERVICE = Regex("happy://workspaces/($ID)/services/($ID)")
    private val FILE = Regex("happy://(agents|workspaces)/($ID)/files/($ENCODED_PATH)(?:$LINES)?")
    private val HAPPY_FILE = Regex("happy-file://(agents|workspaces)/($ID)/($ENCODED_PATH)(?:$LINES)?")
    private val SETTINGS = Regex("happy://settings/(.+)")
    private val EXTERNAL = Regex("happy://([a-z][a-z0-9]{23})/(.+)")

    /** A host that is this grammar's, well-formed or not: the entity hosts, or anything shaped like an instance id. */
    private val OWNED = Regex("happy://(artifacts|agents|workspaces|projects|services|surfaces|users|settings|[a-z][a-z0-9]{23})(?:[/?#].*)?", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    /** Whether [instanceId] is an installation's id as health reports it. */
    fun isInstanceId(instanceId: String): Boolean = INSTANCE_ID.matches(instanceId)

    /**
     * Whether [url] is under one of this grammar's hosts (or `happy-file`),
     * whether or not it is well-formed: a link the mobile routes must
     * never take for one of theirs.
     */
    fun owns(url: String): Boolean = url.startsWith("happy-file:", ignoreCase = true) || OWNED.matches(url)

    /** [url] parsed, internal or external; null for anything that isn't exactly a well-formed link. */
    fun parse(url: String): HappyUrl? {
        if (url.length > MAX_LENGTH) return null
        EXTERNAL.matchEntire(url)?.let { external ->
            val (instanceId, remainder) = external.destructured
            return parseInternal("happy://$remainder")?.let { HappyUrl(it, instanceId) }
        }
        return parseInternal(url)?.let { HappyUrl(it) }
    }

    private fun parseInternal(url: String): HappyLink? {
        SETTINGS.matchEntire(url)?.let { settings ->
            val (page, query) = settings.groupValues[1].split('?', limit = 2).let { it[0] to it.getOrNull(1) }
            if (page !in SETTINGS_PAGES) return null
            if (query == null) return HappyLink.Settings(page)
            // Only an add flow takes a query, and only keys and values it knows: anything else isn't a settings link.
            if (!page.startsWith("providers/add")) return null
            val values = query.split('&').map { pair ->
                val (key, value) = pair.split('=', limit = 2).takeIf { it.size == 2 } ?: return null
                if (value !in SETTINGS_QUERY[key].orEmpty()) return null
                key to value
            }.toMap()
            return HappyLink.Settings(page, values)
        }
        ENTITY.matchEntire(url)?.let { entity ->
            val (host, id, version) = entity.destructured
            val kind = HappyReferenceKind.entries.first { it.host == host }
            if (version.isNotEmpty() && kind != HappyReferenceKind.Artifact) return null
            return HappyLink.Reference(kind, id, version.takeIf { it.isNotEmpty() }?.toInt())
        }
        SERVICE.matchEntire(url)?.let { service ->
            val (workspaceId, id) = service.destructured
            return HappyLink.Reference(HappyReferenceKind.Service, id, workspaceId = workspaceId)
        }
        val file = FILE.matchEntire(url) ?: HAPPY_FILE.matchEntire(url) ?: return null
        val (host, id, encodedPath, start, end) = file.destructured
        val path = decodePath(encodedPath) ?: return null
        val target = if (host == "agents") HappyLink.Target.Agent(id) else HappyLink.Target.Workspace(id)
        val lines = start.takeIf { it.isNotEmpty() }?.toInt()?.let { first -> first..(end.takeIf { it.isNotEmpty() }?.toInt() ?: first) }
        return HappyLink.File(target, path, lines).takeIf(::isValid)
    }

    /**
     * The canonical URL for [link]; with [instanceId], its external form,
     * locked to that installation. Throws [IllegalArgumentException] for a
     * link the grammar can't express.
     */
    fun format(link: HappyLink, instanceId: String? = null): String {
        require(instanceId == null || isInstanceId(instanceId)) { "The instance id is invalid." }
        val internal = when (link) {
            is HappyLink.Reference -> reference(link)
            is HappyLink.File -> file(link, fileScheme = false)
            is HappyLink.Settings -> {
                require(link.page in SETTINGS_PAGES) { "The settings page is unknown." }
                val query = SETTINGS_QUERY.keys.mapNotNull { key -> link.query[key]?.takeIf { it in SETTINGS_QUERY.getValue(key) }?.let { "$key=$it" } }
                "happy://settings/${link.page}" + if (query.isEmpty()) "" else query.joinToString("&", prefix = "?")
            }
        }
        return if (instanceId == null) internal else "happy://$instanceId/${internal.removePrefix("happy://")}"
    }

    /** The API's canonical `happy-file://` form for [file]. It has no external form. */
    fun formatHappyFile(file: HappyLink.File): String = file(file, fileScheme = true)

    private fun reference(reference: HappyLink.Reference): String {
        require(ID_PATTERN.matches(reference.id) && (reference.workspaceId?.let(ID_PATTERN::matches) ?: true)) { "The Happy reference is invalid." }
        require(reference.version == null || (reference.kind == HappyReferenceKind.Artifact && reference.version in 1..MAX_NUMBER)) { "The Happy reference is invalid." }
        require((reference.workspaceId != null) == (reference.kind == HappyReferenceKind.Service)) { "The Happy reference is invalid." }
        if (reference.kind == HappyReferenceKind.Service) return "happy://workspaces/${reference.workspaceId}/services/${reference.id}"
        return "happy://${reference.kind.host}/${reference.id}" + (reference.version?.let { "?version=$it" } ?: "")
    }

    private fun file(file: HappyLink.File, fileScheme: Boolean): String {
        require(isValid(file)) { "The Happy file link is invalid." }
        val target = when (val target = file.target) {
            is HappyLink.Target.Agent -> "agents/${target.agentId}"
            is HappyLink.Target.Workspace -> "workspaces/${target.workspaceId}"
        }
        val path = file.path.split('/').joinToString("/") { encodeSegment(it) ?: throw IllegalArgumentException("The Happy file link is invalid.") }
        val lines = file.lines?.let { if (it.first == it.last) "#L${it.first}" else "#L${it.first}-L${it.last}" }.orEmpty()
        val url = if (fileScheme) "happy-file://$target/$path$lines" else "happy://$target/files/$path$lines"
        require(url.length <= MAX_LENGTH) { "The Happy file link is too long." }
        return url
    }

    private fun isValid(file: HappyLink.File): Boolean {
        val id = when (val target = file.target) {
            is HappyLink.Target.Agent -> target.agentId
            is HappyLink.Target.Workspace -> target.workspaceId
        }
        val lines = file.lines
        return ID_PATTERN.matches(id) &&
            file.path.length <= MAX_LENGTH &&
            file.path.split('/').all(::isSegment) &&
            (lines == null || (lines.first in 1..MAX_NUMBER && lines.last in 1..MAX_NUMBER && lines.last >= lines.first))
    }

    /** A decoded path segment: never `.` or `..`, and no `/`, `\`, or control character. */
    private fun isSegment(segment: String): Boolean =
        segment.isNotEmpty() && segment != "." && segment != ".." &&
            segment.none { it == '/' || it == '\\' || it.code <= 0x1f || it.code in 0x7f..0x9f }

    /** decodeURIComponent per segment: a stray `%` or bytes that aren't UTF-8 refuse it, and an encoded `/` is never a separator. */
    private fun decodePath(encoded: String): String? {
        val segments = encoded.split('/').map { segment ->
            if (segment.isEmpty()) return null
            val bytes = ByteArrayOutputStream()
            var i = 0
            while (i < segment.length) {
                val c = segment[i]
                if (c == '%') {
                    if (i + 2 >= segment.length) return null
                    val high = Character.digit(segment[i + 1], 16)
                    val low = Character.digit(segment[i + 2], 16)
                    if (high < 0 || low < 0) return null
                    bytes.write(high * 16 + low)
                    i += 3
                } else {
                    bytes.write(c.code)
                    i += 1
                }
            }
            val decoded = try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
            } catch (_: CharacterCodingException) {
                return null
            }
            if ('/' in decoded) return null
            decoded
        }
        return segments.joinToString("/")
    }

    /** Every byte but the unreserved characters percent-encoded; null for a lone surrogate, which has no UTF-8. */
    private fun encodeSegment(segment: String): String? {
        val bytes = try {
            Charsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(CharBuffer.wrap(segment))
        } catch (_: CharacterCodingException) {
            return null
        }
        return buildString {
            while (bytes.hasRemaining()) {
                val b = bytes.get().toInt() and 0xff
                val c = b.toChar()
                if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_' || c == '.' || c == '~') append(c)
                else append('%').append("0123456789ABCDEF"[b shr 4]).append("0123456789ABCDEF"[b and 0xf])
            }
        }
    }
}
