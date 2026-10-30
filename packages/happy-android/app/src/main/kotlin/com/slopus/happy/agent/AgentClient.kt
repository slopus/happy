package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionException
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
    class Link(val transport: Transport, val token: String)

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
     * Sends a request. A 401 is [AgentConnectionException.Reason.Revoked];
     * an unreachable agent [AgentConnectionException.Reason.Unavailable];
     * any other status but 2xx and 304 an [AgentApiException].
     */
    suspend fun send(
        method: String,
        path: String,
        body: JsonElement? = null,
        headers: Map<String, String> = emptyMap(),
    ): TransportResponse {
        val link = link()
        val bytes = body?.let { json.encodeToString(JsonElement.serializer(), it).toByteArray(Charsets.UTF_8) }
        return check(link.transport.request(method, path, link.token, bytes, headers))
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
        val stream = link.transport.stream("/v0/events/stream", link.token, after?.let { mapOf("Last-Event-ID" to it) } ?: emptyMap())
        if (stream.status != 200) {
            val body = try {
                stream.readAll()
            } catch (_: Exception) {
                ByteArray(0)
            } finally {
                stream.close()
            }
            check(com.slopus.happy.connection.TransportResponse(stream.status, stream.headers, body))
        }
        return stream
    }

    /** Lets go of the tunnel, so the next request makes a new one. */
    suspend fun reset() = link().transport.reset()

    suspend fun close() = link().transport.close()

    private fun check(response: TransportResponse): TransportResponse {
        if (response.status == 401) throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
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
