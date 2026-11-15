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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

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
            if (BrowserCompute.gone(e.status, e.code)) throw BrowserException(BrowserException.Kind.ComputeGone, e.status)
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
        if (BrowserCompute.gone(status, body)) throw BrowserException(BrowserException.Kind.ComputeGone, status)
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
        val status = response.status ?: 502
        if (status == 200 && rest.isEmpty()) return
        if (status != 200) {
            val body = refusalBody(stream, response, rest)
            // Happy Cloud answers a stopped compute's CONNECT with a JSON code, and a destination past its loopback with another.
            if (BrowserCompute.gone(status, body)) throw BrowserException(BrowserException.Kind.ComputeGone, status)
            if (status == 403 && code(body) == "destination_not_allowed") throw BrowserException(BrowserException.Kind.OutsideNetwork, status)
        }
        throw BrowserException(BrowserException.Kind.Upstream, status)
    }

    /** A refusal's JSON `code`, if its body has one. */
    internal fun code(body: ByteArray): String? =
        runCatching { Json.parseToJsonElement(body.decodeToString()) }.getOrNull().obj?.get("code").str
}

/**
 * Which destinations a network's tunnels carry, as the agent's network
 * lookup says (`destinations`): every one (absent, as on a computer), or
 * only the computer's own loopback (`"loopback"`, Happy Cloud), when
 * everything else is dialed from the phone ([BrowserDirect]). Decided by
 * the host as written, never by resolving it: `localhost`, `*.localhost`,
 * `127.0.0.0/8` and `::1` are the loopback.
 */
enum class BrowserDestinations {
    All, Loopback;

    /** Whether a tunnel carries [authority]; false means the phone dials it. */
    fun tunnels(authority: BrowserPolicy.Authority): Boolean = this == All || isLoopback(authority)

    companion object {
        fun of(value: String?): BrowserDestinations = if (value == "loopback") Loopback else All

        fun isLoopback(authority: BrowserPolicy.Authority): Boolean {
            val host = authority.host
            if (host == "localhost" || host.endsWith(".localhost") || host == "::1") return true
            val parts = host.split('.')
            return parts.size == 4 && parts[0] == "127" && parts.all { it.isNotEmpty() && it.length <= 3 && it.all(Char::isDigit) && it.toInt() <= 255 }
        }
    }
}

/**
 * A destination a [BrowserDestinations.Loopback] network doesn't carry,
 * dialed from the phone over plain TCP (iOS's `BrowserDirect`). The page's
 * TLS stays end to end; nothing of the agent's goes with it. A name that
 * resolves to the phone itself (its loopback, `0.0.0.0`) is refused: only
 * the computer's loopback is the page's.
 */
object BrowserDirect {
    private const val CONNECT_TIMEOUT_MILLIS = 10_000

    /**
     * Where tests dial instead. Here rather than [BrowserProxy]'s
     * constructor: a function-typed property there costs [BrowserProxy.Page]
     * its Compose `$stable` field, which its users still read.
     */
    @Volatile internal var dialer: (suspend (BrowserPolicy.Authority) -> TransportSocket)? = null

    suspend fun open(authority: BrowserPolicy.Authority): TransportSocket {
        dialer?.let { return it(authority) }
        val addresses = try {
            runInterruptible(Dispatchers.IO) { InetAddress.getAllByName(authority.host) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            throw BrowserException(BrowserException.Kind.Upstream, 502)
        }
        if (addresses.any { it.isLoopbackAddress || it.isAnyLocalAddress }) throw BrowserException(BrowserException.Kind.Forbidden)
        for (address in addresses) {
            val socket = Socket()
            try {
                runInterruptible(Dispatchers.IO) {
                    socket.tcpNoDelay = true
                    socket.connect(InetSocketAddress(address, authority.port), CONNECT_TIMEOUT_MILLIS)
                }
                return LocalSocket(socket)
            } catch (e: CancellationException) {
                runCatching { socket.close() }
                throw e
            } catch (_: Exception) {
                runCatching { socket.close() }
            }
        }
        // Refused or silent at every address: the phone can't reach it, as a refused tunnel says.
        throw BrowserException(BrowserException.Kind.Upstream, 502)
    }
}

/**
 * Whose network a page reaches the web through, by its proxy route
 * ([path]): an agent's own, the network its commands run in (its
 * container, runner or the computer), named by a `networkId`; a
 * workspace's on a computer too old to name one; or a live artifact's
 * own, the network it was made on (`live.networkId`), where the daemon
 * checks every destination against the artifact's URL. An id that isn't
 * one is refused before any route.
 */
class BrowserNetwork private constructor(val path: String, val destinations: BrowserDestinations = BrowserDestinations.All) {
    /** A live artifact's route (`CONNECT /v0/artifacts/:id/proxy`). */
    val live: Boolean get() = path.startsWith("/v0/artifacts/")

    companion object {
        fun workspace(id: String) = BrowserNetwork("/v0/workspaces/${checked(id)}/proxy")
        fun network(id: String, destinations: BrowserDestinations = BrowserDestinations.All) =
            BrowserNetwork("/v0/networks/${id.takeIf(BrowserPolicy::validNetworkId) ?: throw BrowserException(BrowserException.Kind.Forbidden)}/proxy", destinations)
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
 * On a computer: an artifact's source workspace's, else its or [agentId]'s
 * agent's own ([agentNetwork]), else the one active workspace on the
 * computer itself, never an arbitrary runner. On Happy Cloud, an agent's:
 * the artifact's source's (its agent, bot's or task's), else [agentId]'s;
 * nothing else has one.
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
            val target = found?.takeIf(BrowserPolicy::validId) ?: throw BrowserException(BrowserException.Kind.Unavailable)
            return if (cloud) agentNetwork(target) else BrowserNetwork.workspace(target)
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

/**
 * The network [agentId]'s commands run in, as desktop finds it:
 * `GET /v0/workspaces/:ws/agents/:id/proxy` names it, on a computer and on
 * Happy Cloud alike. A workspace whose agents run in containers has no
 * network of its own, so its proxy can't reach them. A paired computer too
 * old to name one (404) has only the workspace's; a server signed in to
 * (Happy Cloud, a team server) has no workspace proxy, so there it is none.
 * The answer's `destinations` says which hosts its tunnels carry.
 */
internal suspend fun AgentClient.agentNetwork(agentId: String): BrowserNetwork {
    val workspaceId = decode<JsonObject>("GET", "/v0/agents/${AgentClient.escape(agentId)}")["agent"].obj?.get("workspaceId").str
        ?.takeIf(BrowserPolicy::validId) ?: throw BrowserException(BrowserException.Kind.Unavailable)
    val answer = try {
        decode<JsonObject>("GET", "/v0/workspaces/${AgentClient.escape(workspaceId)}/agents/${AgentClient.escape(agentId)}/proxy")
    } catch (e: AgentApiException) {
        if (e.status == 404) return if (cloud || isOAuth()) throw BrowserException(BrowserException.Kind.Unavailable) else BrowserNetwork.workspace(workspaceId)
        if (BrowserCompute.gone(e.status, e.code)) throw BrowserException(BrowserException.Kind.ComputeGone, e.status)
        throw BrowserException(BrowserException.Kind.Upstream, e.status)
    }
    val destinations = BrowserDestinations.of(answer["destinations"].str)
    return answer["networkId"].str?.takeIf(BrowserPolicy::validNetworkId)?.let { BrowserNetwork.network(it, destinations) }
        ?: throw BrowserException(BrowserException.Kind.Unavailable)
}

/**
 * Whether [agentId]'s compute answers a tunnel to [url]'s server now: it
 * opens, or something other than the compute refuses it. A compute back
 * within its grace says nothing of having gone, so a page closed for it
 * asks this.
 */
suspend fun AgentClient.computeAnswers(agentId: String, url: String): Boolean {
    val authority = BrowserPolicy.Authority.of(url) ?: return false
    return try {
        BrowserTunnel.open(this, agentNetwork(agentId), authority).close()
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: BrowserException) {
        e.kind == BrowserException.Kind.Upstream && e.status != 429
    } catch (_: Exception) {
        false
    }
}

/** Runs [block], turning anything but cancellation into null. */
internal suspend fun <T> quietly(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
