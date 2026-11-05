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
    /** Health's `capabilities.webSocketTunnels` (edge SSO): tunnels go over WebSockets instead of CONNECT. */
    val webSocketTunnels: Boolean = false,
    /** Health's `instanceId`: the installation's, which external links are locked to (edge SSO §7). Null from an older daemon. */
    val instanceId: String? = null,
    /** Health's `capabilities.search`: `POST /v0/search` answers; an older daemon's search is the phone's alone. */
    val search: Boolean = false,
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
    @Serializable private class Capabilities(val webSocketTunnels: Boolean = false, val search: Boolean = false)
    @Serializable private class Health(val ready: Boolean, val version: Version, val capabilities: Capabilities? = null, val instanceId: String? = null)
    @Serializable private class Avatar(val thumbhash: String? = null)
    @Serializable private class Node(val name: String, val avatar: Avatar? = null)
    @Serializable private class Config(val node: Node? = null)
    @Serializable private class ConfigResponse(val config: Config)

    private val json = Json { ignoreUnknownKeys = true }

    /** One request to the agent, authorized: what [refresh] reads with. */
    fun interface Requester {
        suspend fun request(method: String, path: String, headers: Map<String, String>, category: RequestCategory): TransportResponse
    }

    /**
     * [etag] is the picture's the phone holds, asked with `If-None-Match` so
     * unchanged bytes aren't sent again. An [oauth] team server's refusals
     * follow [SignInRule]: SignInRequired, never Revoked.
     */
    suspend fun refresh(transport: Transport, token: String, fallbackName: String, etag: String? = null, oauth: Boolean = false): AgentInfo =
        refresh(Requester { method, path, headers, category -> transport.request(method, path, token, headers = headers, category = category) }, fallbackName, etag, oauth)

    /** Health's `capabilities.webSocketTunnels` alone. */
    suspend fun webSocketTunnels(requester: Requester, oauth: Boolean): Boolean =
        json.decodeOrInvalid<Health>(check(requester.request("GET", "/v0/health", emptyMap(), RequestCategory.Query), oauth)).capabilities?.webSocketTunnels == true

    suspend fun refresh(requester: Requester, fallbackName: String, etag: String? = null, oauth: Boolean = false): AgentInfo {
        fun checked(response: TransportResponse) = check(response, oauth)
        val health = json.decodeOrInvalid<Health>(checked(requester.request("GET", "/v0/health", emptyMap(), RequestCategory.Query)))
        if (health.version.protocol < MIN_PROTOCOL) throw AgentConnectionException(AgentConnectionException.Reason.UpdateRequired)
        if (!health.ready) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        val config = requester.request("GET", "/v0/config", emptyMap(), RequestCategory.Query)
        // A team member may not read the node's configuration: the server goes by the name it was added under.
        val node = if (oauth && config.status != 200 && !SignInRule.requiresSignIn(config)) null
            else json.decodeOrInvalid<ConfigResponse>(checked(config)).config.node
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
                else -> avatar(requester, etag, oauth)
            },
            webSocketTunnels = health.capabilities?.webSocketTunnels == true,
            // Anything but a well-formed id is as good as none: no external link is offered.
            instanceId = health.instanceId?.takeIf(com.slopus.happy.agent.HappyUrls::isInstanceId),
            search = health.capabilities?.search == true,
        )
    }

    /**
     * The node's picture. Only a refusal (401/403) fails the refresh: a
     * picture that can't be read, or isn't one, leaves the kept one as it is.
     */
    private suspend fun avatar(requester: Requester, etag: String?, oauth: Boolean): NodeAvatar {
        val image = try {
            requester.request("GET", "/v0/node/avatar", etag?.let { mapOf("If-None-Match" to it) } ?: emptyMap(), RequestCategory.File)
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentConnectionException) {
            if (e.reason == AgentConnectionException.Reason.SignInRequired) throw e
            return NodeAvatar.Unchanged
        } catch (_: Exception) {
            return NodeAvatar.Unchanged
        }
        if (oauth && SignInRule.requiresSignIn(image)) throw AgentConnectionException(AgentConnectionException.Reason.SignInRequired)
        return when (image.status) {
            401, 403 -> if (oauth) NodeAvatar.Unchanged else throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
            200 -> if (image.body.size <= MAX_AVATAR_BYTES && image.headers["content-type"]?.lowercase()?.startsWith("image/") == true) {
                NodeAvatar.Picture(image.body, image.headers["etag"])
            } else {
                NodeAvatar.Unchanged
            }
            404 -> NodeAvatar.None
            else -> NodeAvatar.Unchanged
        }
    }

    private fun check(response: TransportResponse, oauth: Boolean): TransportResponse {
        if (oauth && SignInRule.requiresSignIn(response)) throw AgentConnectionException(AgentConnectionException.Reason.SignInRequired)
        if (!oauth && (response.status == 401 || response.status == 403)) throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
        if (response.status != 200) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        return response
    }

    private inline fun <reified T> Json.decodeOrInvalid(response: TransportResponse): T = try {
        decodeFromString<T>(response.text)
    } catch (_: Exception) {
        throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }
}
