package com.slopus.happy.browser

import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

/** Why the browser's proxy refused or failed a request (iOS's `BrowserError`). */
class BrowserException(val kind: Kind, val status: Int = 0) : Exception(kind.name) {
    enum class Kind { Forbidden, Malformed, TooLarge, Unavailable, Timeout, Upstream }
}

/**
 * iOS's `BrowserPolicy`: web pages always use the agent's network, never the
 * phone's. Everything a page asks for goes through the in-app proxy
 * ([BrowserProxy]); what may go where is decided here.
 */
object BrowserPolicy {
    enum class Route { Web, System }

    /** http(s) and ws(s) with a host browse in the app; anything else is the system's. */
    fun route(url: String): Route {
        val uri = runCatching { URI(url) }.getOrNull() ?: return Route.System
        return if (uri.scheme?.lowercase() in WEB_SCHEMES && !hostPort(uri)?.first.isNullOrEmpty()) Route.Web else Route.System
    }

    /**
     * Addresses WebView resolves inside the page, with nothing to fetch
     * (iOS's `isInPage`): a blank or srcdoc frame, data and blob URLs,
     * `javascript:` links.
     */
    fun isInPage(url: String): Boolean = url.substringBefore(':', "").lowercase() in IN_PAGE_SCHEMES

    /**
     * The host and port (-1: none) of [uri]. java.net.URI leaves a host such
     * as `127.1` or `0x7f000001` unparsed, as a registry authority; this
     * reads it as a browser does. Null with credentials in it.
     */
    private fun hostPort(uri: URI): Pair<String, Int>? {
        if (uri.rawUserInfo != null) return null
        uri.host?.let { return it to uri.port }
        val authority = uri.rawAuthority ?: return null
        if ('@' in authority || authority.startsWith("[")) return null
        val colon = authority.lastIndexOf(':')
        if (colon < 0) return authority to -1
        val port = authority.substring(colon + 1).takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toIntOrNull() ?: return null
        return authority.substring(0, colon) to port
    }

    /**
     * A host as the proxy compares it: lowercased, brackets and dots off the
     * ends, and the legacy IPv4 spellings browsers canonicalize before
     * CONNECT (`127.1`, octal, hex, a bare integer) written out.
     */
    fun normalize(host: String): String {
        val lower = host.lowercase().trim('[', ']', '.')
        ipv4(lower)?.let { return it }
        if (':' in lower && lower.all { it in "0123456789abcdef:." }) {
            val address = runCatching { InetAddress.getByName(lower) }.getOrNull()
            if (address is Inet6Address) return compress(address.address)
        }
        return lower
    }

    /** `inet_aton`: one to four parts, each decimal, octal (`0`) or hex (`0x`), the last filling the rest. */
    private fun ipv4(text: String): String? {
        if (text.isEmpty() || text.endsWith(".")) return null
        val parts = text.split('.')
        if (parts.size > 4) return null
        val values = parts.map { part ->
            when {
                part.isEmpty() -> return null
                part.startsWith("0x") -> part.substring(2).takeIf { it.isNotEmpty() && it.length <= 8 }?.toLongOrNull(16) ?: if (part == "0x") 0L else return null
                part.startsWith("0") && part.length > 1 -> part.substring(1).toLongOrNull(8) ?: return null
                else -> part.takeIf { it.length <= 10 }?.toLongOrNull() ?: return null
            }
        }
        val leading = values.dropLast(1)
        if (leading.any { it > 255 }) return null
        val lastBits = 8 * (5 - values.size)
        if (values.last() >= (1L shl lastBits)) return null
        var number = values.last()
        for ((index, value) in leading.withIndex()) number = number or (value shl (24 - 8 * index))
        return (3 downTo 0).joinToString(".") { ((number shr (8 * it)) and 0xff).toString() }
    }

    /** RFC 5952's text for an IPv6 address, as `inet_ntop` writes it. */
    private fun compress(bytes: ByteArray): String {
        val groups = (0 until 8).map { ((bytes[2 * it].toInt() and 0xff) shl 8) or (bytes[2 * it + 1].toInt() and 0xff) }
        var bestStart = -1
        var bestLength = 0
        var index = 0
        while (index < 8) {
            if (groups[index] != 0) {
                index++
                continue
            }
            val start = index
            while (index < 8 && groups[index] == 0) index++
            if (index - start > bestLength && index - start > 1) {
                bestStart = start
                bestLength = index - start
            }
        }
        if (bestStart < 0) return groups.joinToString(":") { it.toString(16) }
        val head = groups.subList(0, bestStart).joinToString(":") { it.toString(16) }
        val tail = groups.subList(bestStart + bestLength, 8).joinToString(":") { it.toString(16) }
        return "$head::$tail"
    }

    /** A target the proxy may reach: a normalized host and a port. */
    data class Authority(val host: String, val port: Int) {
        val text: String get() = "${if (':' in host) "[$host]" else host}:$port"

        companion object {
            /** From a URL; null for credentials in it, a scheme that isn't web, or a host with anything but `a-z0-9-._:`. */
            fun of(url: String): Authority? {
                val uri = runCatching { URI(url) }.getOrNull() ?: return null
                val scheme = uri.scheme?.lowercase() ?: return null
                if (scheme !in WEB_SCHEMES) return null
                val (host, port) = hostPort(uri) ?: return null
                return of(host, if (port == -1) (if (scheme == "https" || scheme == "wss") 443 else 80) else port)
            }

            fun of(host: String, port: Int): Authority? {
                if (port !in 1..65535) return null
                val normalized = normalize(host)
                if (normalized.isEmpty() || normalized.length > 253) return null
                if (!normalized.all { it in 'a'..'z' || it in '0'..'9' || it in "-._:" }) return null
                return Authority(normalized, port)
            }

            /** A CONNECT target, `host:port` or `[v6]:port`. */
            fun parse(target: String): Authority? {
                val uri = runCatching { URI("http://$target") }.getOrNull() ?: return null
                if (!uri.rawPath.isNullOrEmpty() || uri.rawQuery != null) return null
                val (host, port) = hostPort(uri) ?: return null
                return if (port == -1) null else of(host, port)
            }
        }
    }

    /**
     * An artifact page's request target as the daemon's route: `/api/…` to
     * the artifact's own API, anything else to the opened version's files.
     * Paths are checked before anything could normalize traversal away.
     * A vault's artifact ([vault], its file route) has no API: every
     * path is one of its version's files.
     */
    fun artifactPath(target: String, artifactId: String, version: Int, vault: String? = null): String {
        if (!validId(artifactId) || version <= 0 || !target.startsWith("/") || target.startsWith("//") ||
            target.any { it.code < 33 || it.code == 127 } || '#' in target
        ) throw BrowserException(BrowserException.Kind.Forbidden)
        val path = target.substringBefore('?')
        for (part in path.drop(1).split('/')) {
            val decoded = percentDecode(part) ?: throw BrowserException(BrowserException.Kind.Forbidden)
            if (decoded == "." || decoded == ".." || '/' in decoded || '\\' in decoded || '%' in decoded ||
                decoded.any { it.code < 32 || it.code == 127 }
            ) throw BrowserException(BrowserException.Kind.Forbidden)
        }
        if (vault != null) {
            if (path == "/") throw BrowserException(BrowserException.Kind.Forbidden)
            return "$vault/versions/$version/artifact$target"
        }
        val prefix = "/v0/artifacts/$artifactId"
        if (path.startsWith("/api/")) return prefix + target
        if (path == "/api" || path == "/") throw BrowserException(BrowserException.Kind.Forbidden)
        return "$prefix/versions/$version/files$target"
    }

    /** API.md's identifiers: a lowercase letter, then lowercase letters and digits. */
    fun validId(value: String): Boolean = value.firstOrNull()?.let { it in 'a'..'z' } == true && value.all { it in 'a'..'z' || it in '0'..'9' }

    /** A request may borrow an artifact's API only from its own origin. */
    fun checkArtifactOrigin(head: HttpHead, authority: Authority) {
        head.value("Sec-Fetch-Site")?.let { if (it.lowercase() !in setOf("same-origin", "none")) throw BrowserException(BrowserException.Kind.Forbidden) }
        head.value("Origin")?.let { origin ->
            val uri = runCatching { URI(origin) }.getOrNull()
            if (uri?.scheme != "http" || Authority.of(origin) != authority) throw BrowserException(BrowserException.Kind.Forbidden)
        }
    }

    internal fun percentDecode(text: String): String? = com.slopus.happy.artifacts.ArtifactMarkdown.percentDecode(text)

    private val WEB_SCHEMES = setOf("http", "https", "ws", "wss")
    private val IN_PAGE_SCHEMES = setOf("about", "data", "blob", "javascript")
}

/** A bounded HTTP head, keeping duplicate fields (notably Set-Cookie) in order. */
data class HttpHead(val line: String, val fields: List<Pair<String, String>>) {
    fun value(name: String): String? = fields.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second

    val bytes: ByteArray get() = (listOf(line) + fields.map { "${it.first}: ${it.second}" } + listOf("", "")).joinToString("\r\n").toByteArray(Charsets.UTF_8)

    /** The status of a response head; null for a request. */
    val status: Int? get() = line.split(' ').getOrNull(1)?.toIntOrNull()?.takeIf { line.startsWith("HTTP/") }

    fun without(vararg names: String): HttpHead = copy(fields = fields.filter { field -> names.none { it.equals(field.first, ignoreCase = true) } })

    /**
     * This page request as the daemon's own (iOS's `artifactRequest`): its
     * method and target mapped by [BrowserPolicy.artifactPath], the page's
     * authentication and routing fields replaced by the device token, and
     * the connection closed after one answer unless it upgrades or is
     * [keepAlive] (a pooled API request).
     */
    fun artifactRequest(artifactId: String, version: Int, credential: String, keepAlive: Boolean = false, authority: String = "server.tailcat", vault: String? = null): HttpHead {
        val parts = line.split(' ')
        if (parts.size != 3 || parts[2] != "HTTP/1.1" || parts[0] == "CONNECT" || !parts[0].all { it in 'A'..'Z' } ||
            '\r' in credential || '\n' in credential
        ) throw BrowserException(BrowserException.Kind.Malformed)
        val target = BrowserPolicy.artifactPath(parts[1], artifactId, version, vault)
        val kept = without("host", "authorization", "proxy-authorization", "proxy-connection", "connection", "x-happy-proxy-route", "expect", "keep-alive")
        return HttpHead(
            "${parts[0]} $target HTTP/1.1",
            kept.fields + listOf("Host" to authority, "Authorization" to "Bearer $credential", "Connection" to if (value("upgrade") != null) "Upgrade" else if (keepAlive) "keep-alive" else "close"),
        )
    }

    /**
     * The daemon's answer as the page gets it (iOS's `artifactResponse`):
     * its opaque-origin sandbox made same-origin on the already isolated
     * artifact origin, so fetch, SSE and storage work; closed after it unless it upgraded.
     */
    fun artifactResponse(): HttpHead {
        var sandboxed = false
        val rewritten = without("connection", "keep-alive", "proxy-connection").fields.map { (name, value) ->
            if (!name.equals("content-security-policy", ignoreCase = true)) return@map name to value
            name to value.split(';').joinToString(";") { directive ->
                val words = directive.trim().split(Regex("\\s+"))
                if (words.firstOrNull()?.lowercase() != "sandbox") return@joinToString directive
                sandboxed = true
                if ("allow-same-origin" in words) directive else "$directive allow-same-origin"
            }
        }
        val extra = if (sandboxed) emptyList() else listOf("Content-Security-Policy" to "sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads")
        return HttpHead(line, rewritten + extra + closing())
    }

    /** Any other answer, unchanged but closed after it unless it upgraded: each request on a local connection is classified once. */
    fun closedResponse(): HttpHead = HttpHead(line, without("connection", "keep-alive", "proxy-connection").fields + closing())

    private fun closing() = if (status == 101) listOf("Connection" to "Upgrade") else listOf("Connection" to "close", "Proxy-Connection" to "close")

    companion object {
        const val LIMIT = 32 * 1024

        /** A head and the bytes after it, null until the blank line arrives. */
        fun parse(data: ByteArray): Pair<HttpHead, ByteArray>? {
            val end = indexOf(data, CRLFCRLF)
            if (end < 0) {
                if (data.size > LIMIT) throw BrowserException(BrowserException.Kind.TooLarge)
                return null
            }
            if (end > LIMIT) throw BrowserException(BrowserException.Kind.TooLarge)
            val text = String(data, 0, end, Charsets.UTF_8)
            val lines = text.split("\r\n")
            val line = lines.first().takeIf { it.isNotEmpty() } ?: throw BrowserException(BrowserException.Kind.Malformed)
            val fields = lines.drop(1).map { field ->
                val colon = field.indexOf(':')
                if (colon <= 0) throw BrowserException(BrowserException.Kind.Malformed)
                val name = field.substring(0, colon)
                val value = field.substring(colon + 1).trim(' ', '\t')
                if (!name.all { it.code in 33..126 && it !in "()<>@,;:\\\"/[]?={} " } ||
                    value.any { (it.code < 32 && it != '\t') || it.code == 127 }
                ) throw BrowserException(BrowserException.Kind.Malformed)
                name to value
            }
            return HttpHead(line, fields) to data.copyOfRange(end + 4, data.size)
        }

        private val CRLFCRLF = "\r\n\r\n".toByteArray()

        internal fun indexOf(data: ByteArray, needle: ByteArray, from: Int = 0): Int {
            outer@ for (i in from..data.size - needle.size) {
                for (j in needle.indices) if (data[i + j] != needle[j]) continue@outer
                return i
            }
            return -1
        }
    }
}
