package com.slopus.happy.browser

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.TransportSocket
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/**
 * iOS's `BrowserTunnel`: a stream to [target] reached by the computer, through
 * `CONNECT /v0/workspaces/:id/proxy` and a nested `CONNECT host:port`. The
 * device token goes on the first CONNECT only, never to the target.
 */
object BrowserTunnel {
    suspend fun open(client: AgentClient, workspaceId: String, target: BrowserPolicy.Authority): TransportSocket {
        if (!BrowserPolicy.validId(workspaceId)) throw BrowserException(BrowserException.Kind.Forbidden)
        val (stream, token) = client.socket()
        try {
            connect(stream, "/v0/workspaces/$workspaceId/proxy", token)
            connect(stream, target.text, null)
            return stream
        } catch (e: Throwable) {
            stream.close()
            throw e
        }
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
