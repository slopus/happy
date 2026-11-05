package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.AgentInfo
import com.slopus.happy.connection.SignInRule
import com.slopus.happy.connection.TransportSocket
import com.slopus.happy.connection.UpgradeRefused
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportStream
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import java.net.URLEncoder
import java.security.SecureRandom

/**
 * The agent refused a request: [status] and its error [code]
 * (happy-agent API.md, "Errors"). Branch on [code], never on [message].
 */
class AgentApiException(val status: Int, val code: String?, override val message: String?) : Exception(message) {
    /** The error body, for codes that carry more (a `409`'s current resource). */
    var body: JsonElement? = null
        internal set
}

/**
 * The Happy Agent API over one agent connection's Tailcat socket, with its
 * device token. Every route a device token may use (API.md, "Credentials on
 * the connector's socket"). The transport is reached lazily: the
 * credentials are read on the first request.
 */
class AgentClient private constructor(private val link: suspend () -> Link) {
    /**
     * The transport and the bearer it is authorized with. A team server
     * signed in with OAuth has [renew]: a 401 asks it once for a newer
     * token and the request is sent again, and its refusals follow
     * [SignInRule] (SignInRequired, never Revoked), told to [signedOut]
     * first so the account says so however the refusal is handled.
     */
    class Link(
        val transport: Transport,
        val token: String,
        internal val renew: (suspend (stale: String) -> String)? = null,
        internal val signedOut: (suspend (profileRequired: Boolean) -> Unit)? = null,
    ) {
        val oauth: Boolean get() = renew != null
    }

    constructor(transport: Transport, token: String) : this(Link(transport, token).let { fixed -> { fixed } })

    companion object {
        internal fun lazy(link: suspend () -> Link) = AgentClient(link)

        /** How every agent answer is read: unknown keys are skipped, as the wire grows. */
        val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
            coerceInputValues = true
        }

        private val random = SecureRandom()
        private const val ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

        /**
         * A fresh client-chosen id, as API.md's identifiers ask
         * (`^[a-z][a-z0-9]+$`, up to 32 for a workspace): a letter, then 23
         * letters or digits. For tasks, workspaces, agents, messages and
         * `mutationId`s.
         */
        fun newId(): String = buildString(24) {
            append(ID_ALPHABET[random.nextInt(26)])
            repeat(23) { append(ID_ALPHABET[random.nextInt(ID_ALPHABET.length)]) }
        }

        /** One path segment or query value, percent-encoded. */
        fun escape(component: String): String = URLEncoder.encode(component, "UTF-8").replace("+", "%20")
    }

    /**
     * Sends a request as [category]. A 401 is [AgentConnectionException.Reason.Revoked];
     * an unreachable agent [AgentConnectionException.Reason.Unavailable];
     * any other status but 2xx and 304 an [AgentApiException].
     */
    suspend fun send(
        method: String,
        path: String,
        body: JsonElement? = null,
        headers: Map<String, String> = emptyMap(),
        category: RequestCategory = RequestCategory.Query,
    ): TransportResponse {
        val link = link()
        val bytes = body?.let { json.encodeToString(JsonElement.serializer(), it).toByteArray(Charsets.UTF_8) }
        return check(link, authorized(link) { token -> link.transport.request(method, path, token, bytes, headers, category) })
    }

    /** Sends [bytes] as they are (an image), with their Content-Type in [headers]: a [RequestCategory.File]. */
    suspend fun sendBytes(method: String, path: String, bytes: ByteArray, headers: Map<String, String>): TransportResponse {
        val link = link()
        return check(link, authorized(link) { token -> link.transport.request(method, path, token, bytes, headers, RequestCategory.File) })
    }

    /**
     * One request, authorized (a team server's token renewed after a 401),
     * its answer as it came: for [AgentIdentity], which reads statuses
     * itself. A team server that wants signing in again throws SignInRequired.
     */
    val requester: AgentIdentity.Requester = AgentIdentity.Requester { method, path, headers, category ->
        val link = link()
        val response = authorized(link) { token -> link.transport.request(method, path, token, null, headers, category) }
        if (link.oauth && SignInRule.requiresSignIn(response)) signInRequired(link)
        response
    }

    /** Whether the open link is a team server signed in with OAuth. */
    suspend fun isOAuth(): Boolean = link().oauth

    /** [call] with the link's token; after a team server's 401, once more if [recover] says to. */
    private suspend fun authorized(link: Link, call: suspend (String) -> TransportResponse): TransportResponse {
        val response = call(link.token)
        return recover(link, response)?.let { call(it) } ?: response
    }

    /**
     * The token to send again with after a team server's [refused] answer,
     * or null to let it stand (edge SSO contract §3). Only the daemon's own
     * JSON 401 is asked about, with `GET /v0/authentication` and the same
     * bearer: valid but no profile is the profile gate (ProfileRequired),
     * valid with a user is transient (the same token once more), invalid is
     * renewed. An edge's 401 stands: the edge may refuse what the daemon
     * accepts, so the person signs in again.
     */
    private suspend fun recover(link: Link, refused: TransportResponse): String? {
        val renew = link.renew ?: return null
        if (refused.status != 401 || !SignInRule.isHappyError(refused.headers["content-type"], refused.body)) return null
        val check = link.transport.request("GET", "/v0/authentication", link.token)
        val root = if (check.status == 200) runCatching { json.parseToJsonElement(check.text).jsonObject }.getOrNull() else null
        val authenticated = (root?.get("authenticated") as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
        val user = (root?.get("userId") as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        return when {
            root == null -> renew(link.token)
            authenticated && user == null -> signInRequired(link, profileRequired = true)
            authenticated -> link.token
            else -> renew(link.token)
        }
    }

    /** The answer to [send] decoded; an answer that doesn't decode is [AgentConnectionException.Reason.InvalidResponse]. */
    suspend fun <T> decode(
        deserializer: DeserializationStrategy<T>,
        method: String,
        path: String,
        body: JsonElement? = null,
        headers: Map<String, String> = emptyMap(),
    ): T {
        val response = send(method, path, body, headers)
        return try {
            json.decodeFromString(deserializer, response.text)
        } catch (e: Exception) {
            throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse).initCause(e)
        }
    }

    /** `GET /v0/events/stream` from [after]; the stream's status is checked. */
    suspend fun events(after: String?): TransportStream {
        val link = link()
        val headers = after?.let { mapOf("Last-Event-ID" to it) } ?: emptyMap()
        var stream = link.transport.stream("/v0/events/stream", link.token, headers)
        if (stream.status == 401 && link.renew != null) {
            val refused = try {
                TransportResponse(stream.status, stream.headers, stream.readAll())
            } catch (_: Exception) {
                TransportResponse(stream.status, stream.headers)
            } finally {
                stream.close()
            }
            val retry = recover(link, refused) ?: signInRequired(link)
            stream = link.transport.stream("/v0/events/stream", retry, headers)
        }
        if (stream.status != 200) {
            val body = try {
                stream.readAll()
            } catch (_: Exception) {
                ByteArray(0)
            } finally {
                stream.close()
            }
            check(link, com.slopus.happy.connection.TransportResponse(stream.status, stream.headers, body))
        }
        return stream
    }

    /**
     * A raw stream to the agent's socket and the device token that
     * authenticates on it: the in-app browser's proxy writes its own HTTP
     * there. The token never leaves native code.
     */
    suspend fun socket(): Pair<com.slopus.happy.connection.TransportSocket, String> {
        val link = link()
        return link.transport.socket() to link.token
    }

    /** The transport and token, the credentials read and the link made on the first call. */
    internal suspend fun resolve(): Link = link()

    /** Health's `capabilities.webSocketTunnels`, once known ([noteHealth], or read by [webSocketTunnel]). */
    @Volatile private var webSocketTunnels: Boolean? = null
    private val blocked = MutableStateFlow(false)

    /**
     * This server's edge refuses CONNECT and it offers no WebSocket tunnels
     * (edge SSO contract §4): previews and other tunnels are off for it,
     * with a note, and not tried again while this client lives.
     */
    val tunnelsBlocked: StateFlow<Boolean> = blocked.asStateFlow()

    /** Health's `capabilities.quickSearch`, false until health is read. */
    @Volatile var quickSearch: Boolean = false
        private set

    /** What health said, kept so a tunnel needn't ask again. */
    fun noteHealth(info: AgentInfo) {
        webSocketTunnels = info.webSocketTunnels
        quickSearch = info.quickSearch
    }

    internal fun blockTunnels() {
        blocked.value = true
    }

    /**
     * A tunnel over the WebSocket twin of the CONNECT route [connectPath]
     * (`<connectPath>/websocket`), when this agent offers them and is
     * reached over HTTPS; null otherwise, and CONNECT is the way. A refused
     * upgrade is an [AgentApiException] for the daemon's own refusals, and
     * SignInRequired or Revoked by the same rules as a request.
     */
    suspend fun webSocketTunnel(connectPath: String): TransportSocket? {
        val link = link()
        if (!link.transport.overHttps()) return null
        val supported = webSocketTunnels ?: AgentIdentity.webSocketTunnels(requester, link.oauth).also { webSocketTunnels = it }
        if (!supported) return null
        val path = "$connectPath/websocket"
        return try {
            try {
                link.transport.webSocketTunnel(path, link.token)
            } catch (e: UpgradeRefused) {
                val retry = recover(link, e.response) ?: throw e
                link.transport.webSocketTunnel(path, retry)
            }
        } catch (e: UpgradeRefused) {
            check(link, e.response)
            throw AgentApiException(e.response.status, null, null)
        }
    }

    suspend fun close() = link().transport.close()

    /**
     * A team server wants signing in again ([profileRequired]: a name
     * first): the account is told, and the request fails.
     */
    internal suspend fun signInRequired(link: Link? = null, profileRequired: Boolean = false): Nothing {
        (link ?: link()).signedOut?.invoke(profileRequired)
        val reason = if (profileRequired) AgentConnectionException.Reason.ProfileRequired else AgentConnectionException.Reason.SignInRequired
        throw AgentConnectionException(reason)
    }

    private suspend fun check(link: Link, response: TransportResponse): TransportResponse {
        if (link.oauth && SignInRule.requiresSignIn(response)) signInRequired(link)
        if (!link.oauth && response.status == 401) throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
        if (response.status in 200..299 || response.status == 304) return response
        val failure = try {
            json.parseToJsonElement(response.text)
        } catch (_: Exception) {
            null
        }
        val error = runCatching { failure?.jsonObject?.get("error")?.jsonPrimitive?.contentOrNull }.getOrNull()
        val code = runCatching { failure?.jsonObject?.get("code")?.jsonPrimitive?.contentOrNull }.getOrNull()
        throw AgentApiException(response.status, code, error).also { it.body = failure }
    }
}

/** [AgentClient.decode] for a reified type. */
suspend inline fun <reified T> AgentClient.decode(
    method: String,
    path: String,
    body: JsonElement? = null,
    headers: Map<String, String> = emptyMap(),
): T = decode(serializer<T>(), method, path, body, headers)
