package com.slopus.happy.browser

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.SignInRule
import kotlinx.coroutines.withTimeout
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.TransportSocket
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/**
 * iOS's `BrowserTunnel`: a stream to [target] reached by the computer, through
 * a [BrowserNetwork]'s proxy and a nested `CONNECT host:port`. The bearer goes on
 * the outer tunnel only, never to the target.
 *
 * The outer tunnel is the route's WebSocket twin where the agent offers it
 * over HTTPS (edge SSO contract §4), else `CONNECT`. A server reached over
 * HTTPS whose edge refuses CONNECT (an answer that isn't the daemon's, or
 * none) has its tunnels turned off ([AgentClient.tunnelsBlocked]) instead
 * of being asked again.
 */
object BrowserTunnel {
    suspend fun open(client: AgentClient, network: BrowserNetwork, target: BrowserPolicy.Authority): TransportSocket {
        val stream = try {
            outer(client, network.path)
        } catch (e: BrowserException) {
            // A live artifact's network that isn't there: never another network instead.
            if (network.live && e.kind == BrowserException.Kind.Upstream && e.status in BrowserNetwork.unavailable) {
                throw BrowserException(BrowserException.Kind.LiveUnavailable, e.status)
            }
            throw e
        }
        try {
            connect(stream, target.text, null)
            return stream
        } catch (e: Throwable) {
            stream.close()
            throw e
        }
    }

    /** The tunnel into [path]'s network, past its outer `200` (or `101`). */
    internal suspend fun outer(client: AgentClient, path: String): TransportSocket {
        if (client.tunnelsBlocked.value) throw BrowserException(BrowserException.Kind.Unavailable)
        val webSocket = try {
            client.webSocketTunnel(path)
        } catch (e: AgentApiException) {
            // No daemon code: the edge turned the upgrade away.
            if (e.code == null) client.blockTunnels()
            throw BrowserException(BrowserException.Kind.Upstream, e.status)
        }
        if (webSocket != null) return webSocket
        val (stream, token) = client.socket()
        try {
            connectOuter(client, stream, path, token)
            return stream
        } catch (e: Throwable) {
            stream.close()
            throw e
        }
    }

    private suspend fun connectOuter(client: AgentClient, stream: TransportSocket, path: String, token: String) {
        val https = client.resolve().transport.overHttps()
        stream.write("CONNECT $path HTTP/1.1\r\nHost: ${stream.authority}\r\nAuthorization: Bearer $token\r\n\r\n".toByteArray(Charsets.UTF_8))
        val (response, rest) = try {
            BrowserRelay.head(stream)
        } catch (e: BrowserException) {
            // Dropped without an answer: an edge that doesn't speak CONNECT.
            if (https && e.kind == BrowserException.Kind.Unavailable) client.blockTunnels()
            throw e
        }
        val status = response.status ?: 502
        if (status == 200 && rest.isEmpty()) return
        if (status == 200) throw BrowserException(BrowserException.Kind.Upstream, 502)
        val body = refusalBody(stream, response, rest)
        val type = response.value("content-type")
        if (client.isOAuth() && SignInRule.requiresSignIn(status, type, body)) client.signInRequired()
        if (https && !SignInRule.isHappyError(type, body)) client.blockTunnels()
        throw BrowserException(BrowserException.Kind.Upstream, status)
    }

    /** Up to 16 KiB of a refusal's body, by its Content-Length: enough to tell the daemon's JSON from an edge's page. */
    private suspend fun refusalBody(stream: TransportSocket, head: HttpHead, initial: ByteArray): ByteArray {
        val length = head.value("content-length")?.toIntOrNull()?.coerceIn(0, 16 * 1024) ?: return initial
        var body = initial
        try {
            withTimeout(5_000) {
                while (body.size < length) {
                    val more = stream.read(length - body.size)
                    if (more.isEmpty()) break
                    body += more
                }
            }
        } catch (e: CancellationException) {
            if (e !is kotlinx.coroutines.TimeoutCancellationException) throw e
        }
        return body.copyOf(minOf(body.size, length))
    }

    internal suspend fun connect(stream: TransportSocket, target: String, credential: String?) {
        val head = StringBuilder("CONNECT $target HTTP/1.1\r\nHost: ${if (credential == null) target else stream.authority}\r\n")
        credential?.let { head.append("Authorization: Bearer ").append(it).append("\r\n") }
        stream.write(head.append("\r\n").toString().toByteArray(Charsets.UTF_8))
        val (response, rest) = BrowserRelay.head(stream)
        if (response.status != 200 || rest.isNotEmpty()) throw BrowserException(BrowserException.Kind.Upstream, response.status ?: 502)
    }
}

/**
 * Whose network a page reaches the web through, by its proxy route
 * ([path]): a workspace's on a computer, an agent's on Happy Cloud, which
 * has no workspaces, or a live artifact's own, the network it was made on
 * (`live.networkId`), where the daemon checks every destination against the
 * artifact's URL. An id that isn't one is refused before any route.
 */
@JvmInline
value class BrowserNetwork private constructor(val path: String) {
    /** A live artifact's route (`CONNECT /v0/artifacts/:id/proxy`). */
    val live: Boolean get() = path.startsWith("/v0/artifacts/")

    companion object {
        fun workspace(id: String) = BrowserNetwork("/v0/workspaces/${checked(id)}/proxy")
        fun agent(id: String) = BrowserNetwork("/v0/agents/${checked(id)}/proxy")
        fun artifact(id: String) = BrowserNetwork("/v0/artifacts/${checked(id)}/proxy")

        /**
         * The artifact route's refusals that mean its page can't open: the
         * artifact is missing or not live, or its network isn't served (404);
         * the network's machine opens no connections (501) or is away (503).
         */
        val unavailable = setOf(404, 501, 503)

        private fun checked(id: String) = id.takeIf(BrowserPolicy::validId) ?: throw BrowserException(BrowserException.Kind.Forbidden)
    }
}

/**
 * The network a page reaches the web through (iOS's `browserWorkspace`).
 * On a computer, a workspace's: an artifact's source's, else the agent's,
 * else the one active workspace on the computer itself, never an
 * arbitrary runner. On Happy Cloud, an agent's: the artifact's source's
 * (its agent, bot's or task's), else [agentId]'s; nothing else has one.
 */
suspend fun AgentClient.browserNetwork(agentId: String? = null, artifactId: String? = null): BrowserNetwork {
    if (artifactId != null) {
        val artifact = decode<JsonObject>("GET", "/v0/artifacts/${AgentClient.escape(artifactId)}")["artifact"].obj
        val source = artifact?.get("updatedSource").obj ?: artifact?.get("source").obj
        if (!cloud) (source?.get("workspaceId").str ?: source?.get("projectId").str)?.takeIf(BrowserPolicy::validId)?.let { return BrowserNetwork.workspace(it) }
        source?.get("agentId").str?.let { return agentNetwork(it) }
        for ((key, resource, field) in listOf(Triple("botId", "bots", "bot"), Triple("taskId", "tasks", "task"))) {
            val id = source?.get(key).str?.takeIf(BrowserPolicy::validId) ?: continue
            val owner = decode<JsonObject>("GET", "/v0/$resource/$id")[field].obj
            val found = if (cloud) owner?.get("agent").obj?.get("id").str else owner?.get("workspaceId").str
            return found?.takeIf(BrowserPolicy::validId)?.let { if (cloud) BrowserNetwork.agent(it) else BrowserNetwork.workspace(it) }
                ?: throw BrowserException(BrowserException.Kind.Unavailable)
        }
    }
    if (!agentId.isNullOrEmpty()) return agentNetwork(agentId)
    if (cloud) throw BrowserException(BrowserException.Kind.Unavailable)
    // The API has no unscoped host CONNECT route: a confirmed local host workspace provides exactly that.
    val workspaces = decode<JsonObject>("GET", "/v0/workspaces")["workspaces"].arr.orEmpty().mapNotNull { it.obj }
    return workspaces.firstOrNull { w ->
        val compute = w["compute"].obj
        w["status"].str == "active" && compute?.get("type").str == "host" && compute?.get("runnerId").str == null
    }?.get("id").str?.let(BrowserNetwork::workspace) ?: throw BrowserException(BrowserException.Kind.Unavailable)
}

/** [agentId]'s own network on Happy Cloud; on a computer, its workspace's. */
private suspend fun AgentClient.agentNetwork(agentId: String): BrowserNetwork =
    if (cloud) BrowserNetwork.agent(agentId)
    else decode<JsonObject>("GET", "/v0/agents/${AgentClient.escape(agentId)}")["agent"].obj?.get("workspaceId").str?.let(BrowserNetwork::workspace)
        ?: throw BrowserException(BrowserException.Kind.Unavailable)

/** Runs [block], turning anything but cancellation into null. */
internal suspend fun <T> quietly(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
