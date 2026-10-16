package com.slopus.happy.attachments

import java.io.IOException

// attachmentDiagnostics.ts: what an attachment transfer failure may say in a
// log. Hosts and statuses stay; URLs, presigned queries, tokens, refs and
// local paths are redacted before anything is kept.

enum class AttachmentDiagnosticLeg(val wire: String) {
    RequestUpload("request-upload"),
    BlobUpload("blob-upload"),
    RequestDownload("request-download"),
    BlobDownload("blob-download"),
    DecryptRender("decrypt-render"),
}

enum class AttachmentTransferTarget(val wire: String) {
    HappyApi("happy-api"),
    ExternalStorage("external-storage"),
    Unknown("unknown"),
}

enum class AttachmentDiagnosticMethod { GET, POST, PUT }

data class AttachmentDiagnostic(
    val leg: AttachmentDiagnosticLeg,
    val method: AttachmentDiagnosticMethod? = null,
    val host: String? = null,
    val target: AttachmentTransferTarget? = null,
    val status: Int? = null,
    val statusText: String? = null,
    val message: String? = null,
    val reason: String? = null,
) {
    /** formatAttachmentDiagnosticForLog: the fields that are set, re-sanitized, plus the runtime context. */
    fun forLog(platform: String? = null, client: String? = null): Map<String, Any> {
        val clean = sanitized()
        return buildMap {
            put("leg", clean.leg.wire)
            clean.method?.let { put("method", it.name) }
            clean.host?.let { put("host", it) }
            clean.target?.let { put("target", it.wire) }
            clean.status?.let { put("status", it) }
            clean.statusText?.let { put("statusText", it) }
            clean.message?.let { put("message", it) }
            clean.reason?.let { put("reason", it) }
            sanitizeDiagnosticText(platform)?.let { put("platform", it) }
            sanitizeDiagnosticText(client)?.let { put("client", it) }
        }
    }

    internal fun sanitized() = copy(
        host = sanitizeDiagnosticHost(host),
        statusText = sanitizeDiagnosticText(statusText),
        message = sanitizeDiagnosticText(message),
        reason = sanitizeDiagnosticText(reason),
    )
}

/** A transfer failure whose message and [diagnostic] are safe to log. */
class AttachmentDiagnosticError(message: String, diagnostic: AttachmentDiagnostic) :
    IOException(sanitizeDiagnosticText(message).orEmpty()) {
    val diagnostic: AttachmentDiagnostic = diagnostic.sanitized()
}

/** What `createAttachmentDiagnostic` is built from; [status] and [statusText] are the response's. */
data class AttachmentDiagnosticInput(
    val leg: AttachmentDiagnosticLeg,
    val method: AttachmentDiagnosticMethod? = null,
    val url: String? = null,
    val serverUrl: String? = null,
    val status: Int? = null,
    val statusText: String? = null,
    val message: String? = null,
    val reason: String? = null,
)

fun sanitizeAttachmentUrlHost(url: String?): String? {
    if (url.isNullOrEmpty()) return null
    return JsUrl.parse(url)?.host?.ifEmpty { null }
}

fun classifyAttachmentTransferTarget(url: String?, serverUrl: String?): AttachmentTransferTarget {
    val host = sanitizeAttachmentUrlHost(url)
    val serverHost = sanitizeAttachmentUrlHost(serverUrl)
    if (host == null || serverHost == null) return AttachmentTransferTarget.Unknown
    return if (host == serverHost) AttachmentTransferTarget.HappyApi else AttachmentTransferTarget.ExternalStorage
}

/** errorMessageFromUnknown */
fun errorMessageFromUnknown(error: Throwable): String =
    sanitizeDiagnosticText(error.message ?: error.javaClass.simpleName).orEmpty()

fun createAttachmentDiagnostic(input: AttachmentDiagnosticInput) = AttachmentDiagnostic(
    leg = input.leg,
    method = input.method,
    host = sanitizeDiagnosticHost(input.url),
    target = if (!input.url.isNullOrEmpty() || !input.serverUrl.isNullOrEmpty()) {
        classifyAttachmentTransferTarget(input.url, input.serverUrl)
    } else {
        null
    },
    status = input.status,
    statusText = sanitizeDiagnosticText(input.statusText),
    message = sanitizeDiagnosticText(input.message),
    reason = sanitizeDiagnosticText(input.reason),
)

fun createAttachmentDiagnosticError(message: String, input: AttachmentDiagnosticInput) =
    AttachmentDiagnosticError(message, createAttachmentDiagnostic(input))

fun getAttachmentDiagnostic(error: Throwable?): AttachmentDiagnostic? =
    (error as? AttachmentDiagnosticError)?.diagnostic?.sanitized()

private fun sanitizeDiagnosticHost(value: String?): String? {
    val trimmed = value?.trim()?.ifEmpty { null } ?: return null
    val parsedHost = sanitizeAttachmentUrlHost(trimmed)
    if (parsedHost != null) return parsedHost.takeIf(::isSafeDiagnosticHost)
    return trimmed.takeIf(::isSafeDiagnosticHost)
}

private val SAFE_HOST = Regex("""^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+)(?::\d+)?$""")

private fun isSafeDiagnosticHost(value: String): Boolean =
    !value.contains('\\') && !value.contains('@') && !value.contains('=') && !value.contains('&') && SAFE_HOST.matches(value)

private val DATA_URI = Regex("""\bdata:[\s\S]*""", RegexOption.IGNORE_CASE)
private val FILE_URI = Regex("""\bfile://.*""", RegexOption.IGNORE_CASE)
private val WINDOWS_SLASH_PATH = Regex("""(^|[\s(\["'=])[A-Za-z]:/[^"')\],}]+""")
private val WINDOWS_PATH = Regex("""(^|[\s(\["'=])[A-Za-z]:\\[^"')\],}]+""")
private val ABSOLUTE_URL = Regex("""\b[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]+""")
private val SCHEME_TOKEN = Regex("""(^|[^\w.+\-\[])([A-Za-z][A-Za-z0-9+.-]*):[^\s"'<>]+""")
private val BEARER = Regex("""\bBearer\s+[A-Za-z0-9._~+/=-]+""", RegexOption.IGNORE_CASE)
private val REF_ASSIGNMENT = Regex(
    """\bref(?:\s*[=:]\s*|\s+)/?[A-Za-z0-9._~@-]+(?:/[A-Za-z0-9._~@-]+)+(?:\?[^\s"'<>]*)?""",
    RegexOption.IGNORE_CASE,
)
private val SECRET_QUERY = Regex(
    """\b(?:X-Amz-[A-Za-z0-9-]+|AWSAccessKeyId|policy|token|access_token|signature)=[^\s"'<>]+""",
    RegexOption.IGNORE_CASE,
)
private val LOCAL_PATH = Regex(
    """(^|[\s(\["'=])/(?:Users|home|var|tmp|private|Volumes|data/user/0|data/data|storage/emulated/0|sdcard)/[^"')\],}]+""",
)
private val BARE_REF = Regex(
    """(^|[\s(\["'])/?(?:happy|sessions)/[A-Za-z0-9._~@-]+(?:/[A-Za-z0-9._~@-]+)+(?:\?[^\s"'<>]*)?""",
    RegexOption.IGNORE_CASE,
)

/** sanitizeDiagnosticText, rule for rule and in the same order. */
internal fun sanitizeDiagnosticText(value: String?): String? {
    if (value == null) return null
    var text = value
    text = DATA_URI.replace(text, "[data-uri]")
    text = FILE_URI.replace(text, "[local-file]")
    text = WINDOWS_SLASH_PATH.replace(text) { "${it.groupValues[1]}[local-file]" }
    text = WINDOWS_PATH.replace(text) { "${it.groupValues[1]}[local-file]" }
    text = ABSOLUTE_URL.replace(text) { match ->
        val parsed = JsUrl.parse(match.value)
        when {
            parsed == null -> "[url]"
            parsed.scheme == "file" -> "[local-file]"
            parsed.host.isNotEmpty() -> "[url:${parsed.host}]"
            else -> "[url]"
        }
    }
    text = SCHEME_TOKEN.replace(text) { "${it.groupValues[1]}[url:${it.groupValues[2].lowercase()}]" }
    text = BEARER.replace(text, "[redacted-token]")
    text = REF_ASSIGNMENT.replace(text, "ref=[attachment-ref]")
    text = SECRET_QUERY.replace(text, "[redacted-query]")
    text = LOCAL_PATH.replace(text) { "${it.groupValues[1]}[local-file]" }
    text = BARE_REF.replace(text) { "${it.groupValues[1]}[attachment-ref]" }
    return text
}

/**
 * The scheme and host of a URL as the WHATWG URL parser (`new URL`) gives
 * them, enough for the diagnostics: special schemes lowercase their host and
 * drop a default port; other schemes have a host only after `//`. Null where
 * `new URL` throws.
 */
internal data class JsUrl(val scheme: String, val host: String) {
    companion object {
        private val SCHEME = Regex("""^([A-Za-z][A-Za-z0-9+.-]*):""")
        private val DEFAULT_PORTS = mapOf("http" to "80", "https" to "443", "ws" to "80", "wss" to "443", "ftp" to "21")
        private val SPECIAL = DEFAULT_PORTS.keys + "file"
        private val FORBIDDEN_HOST = Regex("""[\u0000-\u0020#/:<>?@\[\\\]^|%]""")

        fun parse(input: String): JsUrl? {
            val url = input.trim()
            val match = SCHEME.find(url) ?: return null
            val scheme = match.groupValues[1].lowercase()
            var rest = url.substring(match.range.last + 1)
            val special = scheme in SPECIAL
            if (special) rest = rest.replace('\\', '/')
            if (!rest.startsWith("//")) {
                // A special scheme needs an authority; others have an opaque path and no host.
                return if (special && scheme != "file") null else JsUrl(scheme, "")
            }
            rest = rest.substring(2)
            val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
            var authority = rest.substring(0, end)
            authority = authority.substring(authority.lastIndexOf('@') + 1)
            if (authority.startsWith("[")) {
                val close = authority.indexOf(']')
                if (close < 0) return null
                return JsUrl(scheme, authority.lowercase())
            }
            val colon = authority.lastIndexOf(':')
            var hostname = if (colon >= 0) authority.substring(0, colon) else authority
            var port = if (colon >= 0) authority.substring(colon + 1) else ""
            if (port.isNotEmpty() && (!port.all(Char::isDigit) || port.toLong() > 65535)) return null
            if (port.isNotEmpty()) port = port.toLong().toString()
            if (port == DEFAULT_PORTS[scheme]) port = ""
            if (FORBIDDEN_HOST.containsMatchIn(hostname)) return null
            if (special) {
                if (hostname.isEmpty() && scheme != "file") return null
                hostname = hostname.lowercase()
            }
            return JsUrl(scheme, if (port.isEmpty()) hostname else "$hostname:$port")
        }
    }
}
