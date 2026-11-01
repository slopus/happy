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
 * the workspace's proxy and a nested `CONNECT host:port`. The bearer goes on
 * the outer tunnel only, never to the target.
 *
 * The outer tunnel is the route's WebSocket twin where the agent offers it
 * over HTTPS (edge SSO contract §4), else `CONNECT`. A server reached over
 * HTTPS whose edge refuses CONNECT (an answer that isn't the daemon's, or
 * none) has its tunnels turned off ([AgentClient.tunnelsBlocked]) instead
 * of being asked again.
 */
object BrowserTunnel {
    suspend fun open(client: AgentClient, workspaceId: String, target: BrowserPolicy.Authority): TransportSocket {
        if (!BrowserPolicy.validId(workspaceId)) throw BrowserException(BrowserException.Kind.Forbidden)
        val stream = outer(client, "/v0/workspaces/$workspaceId/proxy")
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
 * The workspace whose network a page reaches the web through (iOS's
 * `browserWorkspace`): an artifact's source's, else the agent's, else the
 * one active workspace on the computer itself. Never an arbitrary runner.
 */
suspend fun AgentClient.browserWorkspace(agentId: String? = null, artifactId: String? = null): String {
    if (artifactId != null) {
        val artifact = decode<JsonObject>("GET", "/v0/artifacts/${AgentClient.escape(artifactId)}")["artifact"].obj
        val source = artifact?.get("updatedSource").obj ?: artifact?.get("source").obj
        (source?.get("workspaceId").str ?: source?.get("projectId").str)?.takeIf(BrowserPolicy::validId)?.let { return it }
        source?.get("agentId").str?.let { return agentWorkspace(it) }
        for ((key, resource, field) in listOf(Triple("botId", "bots", "bot"), Triple("taskId", "tasks", "task"))) {
            val id = source?.get(key).str?.takeIf(BrowserPolicy::validId) ?: continue
            return decode<JsonObject>("GET", "/v0/$resource/$id")[field].obj?.get("workspaceId").str?.takeIf(BrowserPolicy::validId)
                ?: throw BrowserException(BrowserException.Kind.Unavailable)
        }
    }
    if (!agentId.isNullOrEmpty()) return agentWorkspace(agentId)
    // The API has no unscoped host CONNECT route: a confirmed local host workspace provides exactly that.
    val workspaces = decode<JsonObject>("GET", "/v0/workspaces")["workspaces"].arr.orEmpty().mapNotNull { it.obj }
    return workspaces.firstOrNull { w ->
        val compute = w["compute"].obj
        w["status"].str == "active" && compute?.get("type").str == "host" && compute?.get("runnerId").str == null
    }?.get("id").str ?: throw BrowserException(BrowserException.Kind.Unavailable)
}

private suspend fun AgentClient.agentWorkspace(agentId: String): String =
    decode<JsonObject>("GET", "/v0/agents/${AgentClient.escape(agentId)}")["agent"].obj?.get("workspaceId").str
        ?: throw BrowserException(BrowserException.Kind.Unavailable)

/** Runs [block], turning anything but cancellation into null. */
internal suspend fun <T> quietly(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
