package com.slopus.happy.connection

import com.slopus.happy.agent.HappyUrls
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * A team server's link (edge SSO contract §8), from the QR code Happy
 * desktop shows: the only way a phone adds a team server behind SSO. It
 * names the server's base [url] and its installation ([instanceId],
 * health's), and holds no secret: signing in is the person's own, in the
 * browser, and the server is kept only if its health answers with the
 * same [instanceId].
 *
 * The link is `happy://<instanceId>/server?url=<percent-encoded base URL>`,
 * read only from the app's own scanner. It is not a Happy URL
 * ([HappyUrls.parse] refuses it), so nothing else acts on one.
 */
data class ServerInvite(val instanceId: String, val url: String) {
    /**
     * The server's origin when [url] is one (`https://host/`); null for a
     * server under a path prefix, which this app's connections can't
     * reach yet.
     */
    val origin: AgentOrigin? get() = url.toHttpUrlOrNull()?.takeIf { it.encodedPath == "/" }?.let {
        try {
            ServerAuthClient.parseAddress(url)
        } catch (_: ServerAuthException) {
            null
        }
    }

    companion object {
        private const val MAX_LENGTH = 4096
        private val LINK = Regex("happy://([a-z][a-z0-9]{23})/server\\?url=([A-Za-z0-9\\-._~!*'()%]+)")
        private val SHAPE = Regex("happy://[a-z][a-z0-9]{23}/server(?:[/?#].*)?", RegexOption.DOT_MATCHES_ALL)

        /**
         * Whether [text] is shaped like a server link, well-formed or not:
         * a malformed one is still this kind and is refused as one, never
         * read as another.
         */
        fun isServerCode(text: String): Boolean = SHAPE.matches(text)

        /**
         * [text] as a server link; null for anything not exactly one. Its
         * URL must already be a normalized `https:` base URL (no user,
         * query or fragment, lowercase host, no default port, a path
         * ending in `/`); nothing is repaired.
         */
        fun parse(text: String): ServerInvite? {
            if (text.length > MAX_LENGTH) return null
            val match = LINK.matchEntire(text) ?: return null
            val (instanceId, encoded) = match.destructured
            if (!HappyUrls.isInstanceId(instanceId)) return null
            val url = percentDecode(encoded) ?: return null
            val parsed = url.toHttpUrlOrNull() ?: return null
            if (parsed.scheme != "https" || parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) return null
            if (parsed.query != null || parsed.fragment != null || !parsed.encodedPath.endsWith("/")) return null
            // Normalized already: what OkHttp would write back is the text itself.
            if (parsed.toString() != url) return null
            return ServerInvite(instanceId, url)
        }

        private fun percentDecode(text: String): String? {
            val bytes = java.io.ByteArrayOutputStream()
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (c == '%') {
                    if (i + 2 >= text.length) return null
                    val high = Character.digit(text[i + 1], 16)
                    val low = Character.digit(text[i + 2], 16)
                    if (high < 0 || low < 0) return null
                    bytes.write(high * 16 + low)
                    i += 3
                } else {
                    bytes.write(c.code)
                    i++
                }
            }
            return try {
                Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString()
            } catch (_: java.nio.charset.CharacterCodingException) {
                null
            }
        }
    }
}
