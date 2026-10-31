package com.slopus.happy.connection

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A paired agent as the phone shows it: its own name and avatar, and how it answers now. */
data class AgentInfo(
    val name: String,
    val thumbhash: String? = null,
    val daemonVersion: String? = null,
    val protocol: Int? = null,
    val avatar: NodeAvatar = NodeAvatar.Unchanged,
)

/** What `/v0/node/avatar` answered. The ETag, not the ThumbHash, says which bytes these are. */
sealed interface NodeAvatar {
    /** The agent has none (no `config.node.avatar`, or a 404). */
    data object None : NodeAvatar
    /** The bytes the phone holds are still the agent's (a 304), or nothing was asked. */
    data object Unchanged : NodeAvatar
    class Picture(val bytes: ByteArray, val etag: String?) : NodeAvatar
}

/**
 * Health, then `config.node` (happy-agent API.md, "Node configuration"),
 * and the node's picture when it has one, with the paired device token. 401
 * or 403 means the phone was removed on the agent:
 * [AgentConnectionException.Reason.Revoked].
 */
object AgentIdentity {
    /** The oldest daemon protocol the phone talks to. */
    const val MIN_PROTOCOL = 27

    /** The largest picture kept, as iOS's AgentIdentity. */
    private const val MAX_AVATAR_BYTES = 8 * 1024 * 1024

    @Serializable private class Version(val protocol: Int, val daemon: String? = null)
    @Serializable private class Health(val ready: Boolean, val version: Version)
    @Serializable private class Avatar(val thumbhash: String? = null)
    @Serializable private class Node(val name: String, val avatar: Avatar? = null)
    @Serializable private class Config(val node: Node? = null)
    @Serializable private class ConfigResponse(val config: Config)

    private val json = Json { ignoreUnknownKeys = true }

    /** [etag] is the picture's the phone holds, asked with `If-None-Match` so unchanged bytes aren't sent again. */
    suspend fun refresh(transport: Transport, token: String, fallbackName: String, etag: String? = null): AgentInfo {
        val health = json.decodeOrInvalid<Health>(check(transport.request("GET", "/v0/health", token)))
        if (health.version.protocol < MIN_PROTOCOL) throw AgentConnectionException(AgentConnectionException.Reason.UpdateRequired)
        if (!health.ready) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        val node = json.decodeOrInvalid<ConfigResponse>(check(transport.request("GET", "/v0/config", token))).config.node
        val name = node?.name?.takeIf { it.isNotEmpty() && it.codePointCount(0, it.length) <= 128 && it.none(Char::isISOControl) }
        if (node != null && name == null) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        return AgentInfo(
            name = name ?: fallbackName,
            thumbhash = node?.avatar?.thumbhash,
            daemonVersion = health.version.daemon,
            protocol = health.version.protocol,
            avatar = when {
                node == null -> NodeAvatar.Unchanged
                node.avatar == null -> NodeAvatar.None
                else -> avatar(transport, token, etag)
            },
        )
    }

    /**
     * The node's picture. Only a refusal (401/403) fails the refresh: a
     * picture that can't be read, or isn't one, leaves the kept one as it is.
     */
    private suspend fun avatar(transport: Transport, token: String, etag: String?): NodeAvatar {
        val image = try {
            transport.request("GET", "/v0/node/avatar", token, headers = etag?.let { mapOf("If-None-Match" to it) } ?: emptyMap())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return NodeAvatar.Unchanged
        }
        return when (image.status) {
            401, 403 -> throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
            200 -> if (image.body.size <= MAX_AVATAR_BYTES && image.headers["content-type"]?.lowercase()?.startsWith("image/") == true) {
                NodeAvatar.Picture(image.body, image.headers["etag"])
            } else {
                NodeAvatar.Unchanged
            }
            404 -> NodeAvatar.None
            else -> NodeAvatar.Unchanged
        }
    }

    private fun check(response: TransportResponse): TransportResponse {
        if (response.status == 401 || response.status == 403) throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
        if (response.status != 200) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        return response
    }

    private inline fun <reified T> Json.decodeOrInvalid(response: TransportResponse): T = try {
        decodeFromString<T>(response.text)
    } catch (_: Exception) {
        throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }
}
