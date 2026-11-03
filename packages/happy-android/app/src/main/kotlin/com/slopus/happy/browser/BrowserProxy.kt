package com.slopus.happy.browser

import android.util.Base64
import android.util.Log
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.TransportSocket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * The in-app browser's proxy (iOS's `BrowserProxy`, docs/browser-proxy.md):
 * one authenticated listener on 127.0.0.1 that every in-app web page and
 * picture fetch goes through, so they use the computer's network and never
 * the phone's.
 *
 * Android's WebView takes one proxy for the whole app (`ProxyController`),
 * where WebKit takes one per page, so one listener serves every open
 * [Page], and a request reaches its page by its credentials. Where WebView
 * has profiles (`MULTI_PROFILE`), each page's WebView is in a profile of its
 * own, whose network context answers the 407 with that page's credentials
 * only, so pages are as separate as iOS's. Without profiles, WebViews share
 * one credential and a request reaches its page by its target: an artifact
 * page's synthetic origin is unique to that page, and anything else goes
 * through the newest page's workspace. A client that is not a WebView (the
 * picture fetcher's OkHttp) always authenticates as its own page.
 *
 * Chromium asks a proxy for plain `http` in absolute form (`GET http://host/p`)
 * and tunnels everything else with CONNECT; both are handled. Every local
 * connection serves one request and closes, so each is classified and
 * authorized on its own. The device token is added only here, only on the
 * workspace CONNECT or an artifact's own route, never in what a page sees.
 */
class BrowserProxy(parent: CoroutineScope) {
    /** What a page may reach, besides the web through its workspace. */
    sealed interface Scope {
        val client: AgentClient

        /** A bundled artifact on its synthetic origin: its files, its API, and the web through its source's workspace if it has one. */
        class Artifact(
            override val client: AgentClient,
            val id: String,
            val version: Int,
            val authority: BrowserPolicy.Authority,
            val workspace: (suspend () -> String)?,
        ) : Scope

        /** An older artifact running at an http URL: its own origin, `/api/…` to the artifact, the rest through the workspace. */
        class Live(override val client: AgentClient, val id: String, val workspaceId: String, val authority: BrowserPolicy.Authority) : Scope

        /** A web page: the web through the workspace, and no daemon or artifact API. */
        class Workspace(override val client: AgentClient, val workspace: suspend () -> String) : Scope
    }

    /**
     * One open page. [webView] pages are WebViews, which need the app-wide
     * proxy override; an [isolated] page answers the proxy with its own
     * [username] and [password] (a fetcher, or a WebView in a profile of its
     * own) and reaches only what its scope allows. The others share
     * [webUsername] and are told apart by their targets.
     */
    inner class Page internal constructor(val scope: Scope, internal val webView: Boolean, internal val isolated: Boolean) {
        val username = token()
        val password = token()
        internal val authorization = basic(username, password)
        /** Why tunnels to each host were refused, for the screen to say. */
        val refusals = BrowserRefusals()
        private var resolved: Deferred<String>? = null

        /** Keep-alive connections for this page's artifact API, closed with the page. */
        internal val pool = BrowserConnectionPool({ scope.client.socket() })

        /** The workspace the page reaches the web through, asked once; asked again after a failure. */
        internal suspend fun workspace(): String {
            val running = synchronized(this) {
                resolved?.takeUnless { it.isCompleted && it.getCompletionExceptionOrNull() != null } ?: scopeJob.async {
                    when (scope) {
                        is Scope.Artifact -> scope.workspace?.invoke() ?: throw BrowserException(BrowserException.Kind.Unavailable)
                        is Scope.Live -> scope.workspaceId
                        is Scope.Workspace -> scope.workspace()
                    }
                }.also { resolved = it }
            }
            return try {
                running.await()
            } catch (e: CancellationException) {
                throw e
            } catch (e: BrowserException) {
                throw e
            } catch (_: Exception) {
                throw BrowserException(BrowserException.Kind.Unavailable)
            }
        }

        fun close() {
            remove(this)
            pool.stop()
        }
    }

    private val scopeJob = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]) + Dispatchers.IO)
    private val pages = CopyOnWriteArrayList<Page>()
    private var server: ServerSocket? = null
    private var accepting: Job? = null
    private val jobs = AtomicInteger(0)

    /** What every WebView answers the proxy's challenge with. */
    val webUsername = token()
    val webPassword = token()
    private val webAuthorization = basic(webUsername, webPassword)

    /**
     * Opens [scope] for a page, starting the listener if needed: a WebView
     * that shares the web credentials, one [isolated] in its own profile, or
     * ([webView] false) a fetcher, which always has its own.
     */
    @Synchronized
    fun open(scope: Scope, webView: Boolean = true, isolated: Boolean = !webView): Page {
        val page = Page(scope, webView, isolated)
        pages += page
        if (server == null) start()
        return page
    }

    /** The listener's port, once a page is open. */
    val port: Int get() = server?.localPort ?: throw BrowserException(BrowserException.Kind.Unavailable)

    /** Whether any WebView page is open, which is when WebView's proxy override is wanted. */
    val hasWebPages: Boolean get() = pages.any { it.webView }

    @Synchronized
    private fun remove(page: Page) {
        pages -= page
        if (pages.isEmpty()) stop()
    }

    private fun start() {
        // IPv4 by name: Android's getLoopbackAddress() is ::1, and WebView's proxy rule is 127.0.0.1.
        val socket = ServerSocket(0, 50, LOOPBACK)
        server = socket
        accepting = scopeJob.launch {
            while (isActive) {
                val connection = try {
                    runInterruptible { socket.accept() }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    break
                }
                if (jobs.get() >= MAX_CONNECTIONS) {
                    runCatching { connection.close() }
                    continue
                }
                jobs.incrementAndGet()
                launch {
                    val local = LocalSocket(connection)
                    try {
                        serve(local)
                    } catch (_: Exception) {
                        // A cancelled tab or connection ends only its own stream.
                    } finally {
                        local.close()
                        jobs.decrementAndGet()
                    }
                }
            }
        }
    }

    private fun stop() {
        runCatching { server?.close() }
        server = null
        accepting?.cancel()
        accepting = null
    }

    /** Closes the listener and every connection; for the app's end. */
    fun shutdown() {
        pages.forEach { it.pool.stop() }
        pages.clear()
        stop()
        scopeJob.cancel()
    }

    private fun authenticate(head: HttpHead): Page? {
        val given = head.value("Proxy-Authorization") ?: return null
        pages.firstOrNull { it.isolated && it.authorization == given }?.let { return it }
        // A shared WebView's own page is found by its target; this is just any open one.
        return if (given == webAuthorization) pages.lastOrNull { it.webView && !it.isolated } else null
    }

    /** The page that owns [authority]: an artifact or live page's own origin, else [fallback]. */
    private fun owner(authority: BrowserPolicy.Authority, fallback: Page): Page {
        if (fallback.isolated) return fallback
        return pages.lastOrNull { page ->
            !page.isolated &&
            when (val scope = page.scope) {
                is Scope.Artifact -> scope.authority == authority
                is Scope.Live -> scope.authority == authority
                is Scope.Workspace -> false
            }
        } ?: fallback
    }

    private suspend fun serve(local: TransportSocket) {
        var started = false
        var refused: Pair<Page, BrowserPolicy.Authority>? = null
        try {
            val (head, rest) = BrowserRelay.head(local)
            val page = authenticate(head)
            if (page == null) {
                local.write(PROXY_AUTH_REQUIRED)
                return
            }
            val parts = head.line.split(' ')
            if (parts.size != 3 || parts[2] != "HTTP/1.1" || !parts[0].all { it in 'A'..'Z' }) throw BrowserException(BrowserException.Kind.Malformed)
            if (parts[0] == "CONNECT") {
                val authority = BrowserPolicy.Authority.parse(parts[1]) ?: throw BrowserException(BrowserException.Kind.Forbidden)
                val owner = owner(authority, page)
                refused = owner to authority
                when (val scope = owner.scope) {
                    is Scope.Artifact if scope.authority == authority -> {
                        local.write(ESTABLISHED)
                        // CONNECT cannot already carry an HTTP request.
                        if (rest.isNotEmpty()) throw BrowserException(BrowserException.Kind.Malformed)
                        val (inner, body) = BrowserRelay.head(local)
                        BrowserPolicy.checkArtifactOrigin(inner, authority)
                        artifact(local, owner.pool, scope.id, scope.version, inner, body) { started = true }
                    }
                    is Scope.Live if scope.authority == authority -> {
                        local.write(ESTABLISHED)
                        if (rest.isNotEmpty()) throw BrowserException(BrowserException.Kind.Malformed)
                        val (inner, body) = BrowserRelay.head(local)
                        val target = inner.line.split(' ').getOrNull(1).orEmpty()
                        if (target.startsWith("/api/")) {
                            BrowserPolicy.checkArtifactOrigin(inner, authority)
                            artifact(local, owner.pool, scope.id, 1, inner, body) { started = true }
                        } else {
                            forward(local, scope.client, scope.workspaceId, authority, inner, body) { started = true }
                        }
                    }
                    else -> {
                        val workspace = owner.workspace()
                        val remote = upstream { BrowserTunnel.open(owner.scope.client, workspace, authority) }
                        try {
                            local.write(ESTABLISHED)
                            started = true
                            if (rest.isNotEmpty()) remote.write(rest)
                            BrowserRelay.duplex(local, remote)
                        } finally {
                            remote.close()
                        }
                    }
                }
                return
            }
            // Absolute form: Chromium's plain http through a proxy.
            val uri = runCatching { URI(parts[1]) }.getOrNull()
            if (uri?.scheme?.lowercase() != "http") throw BrowserException(BrowserException.Kind.Malformed)
            val authority = BrowserPolicy.Authority.of(parts[1]) ?: throw BrowserException(BrowserException.Kind.Forbidden)
            val target = (uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/") + (uri.rawQuery?.let { "?$it" } ?: "")
            val inner = HttpHead("${parts[0]} $target HTTP/1.1", head.without("proxy-authorization", "proxy-connection").fields)
            val owner = owner(authority, page)
            when (val scope = owner.scope) {
                is Scope.Artifact if scope.authority == authority -> {
                    BrowserPolicy.checkArtifactOrigin(inner, authority)
                    artifact(local, owner.pool, scope.id, scope.version, inner, rest) { started = true }
                }
                is Scope.Live if scope.authority == authority && target.startsWith("/api/") -> {
                    BrowserPolicy.checkArtifactOrigin(inner, authority)
                    artifact(local, owner.pool, scope.id, 1, inner, rest) { started = true }
                }
                else -> forward(local, owner.scope.client, owner.workspace(), authority, inner, rest) { started = true }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val failure = BrowserFailure.of(e)
            Log.w(TAG, "Browser proxy failure: ${failure.code}, status ${failure.status}")
            // Never append another HTTP response to a started one or an opaque tunnel.
            if (!started) {
                refused?.let { (owner, authority) -> owner.refusals.record(BrowserProxyRefusal(failure.status, failure.code), authority) }
                runCatching { local.write(failure.bytes) }
            }
        }
    }

    /**
     * One request to an artifact's own route, its answer relayed as it
     * comes (SSE included) with the page's sandbox made same-origin. An
     * upgrade stays open both ways.
     *
     * An API request (`/api/…`, not an upgrade) leases a keep-alive
     * connection from the page's [pool]: exactly one framed request per
     * lease, never pipelined and never retried (a failed write may already
     * have reached the daemon), and the lease goes back only once its
     * answer ended exactly where its framing says. Everything else gets a
     * connection of its own that closes after the answer.
     */
    private suspend fun artifact(
        local: TransportSocket,
        pool: BrowserConnectionPool,
        id: String,
        version: Int,
        head: HttpHead,
        initial: ByteArray,
        onStarted: () -> Unit,
    ) {
        val (request, body) = BrowserRelay.requestBody(head, initial, local)
        val parts = request.line.split(' ')
        val method = parts.firstOrNull().orEmpty()
        val api = parts.getOrNull(1)?.startsWith("/api/") == true && request.value("upgrade") == null
        // Checked before a connection is taken: a refused path costs nothing upstream.
        request.artifactRequest(id, version, "-", keepAlive = api)
        val lease = upstream { pool.take(reusing = api) }
        var reusable = false
        try {
            val translated = request.artifactRequest(id, version, lease.token, keepAlive = api, authority = lease.socket.authority)
            val remote = lease.socket
            upstream {
                remote.write(translated.bytes)
                if (body.isNotEmpty()) remote.write(body)
            }
            var (response, bytes) = upstream { BrowserRelay.head(remote) }
            var interim = 0
            while ((response.status ?: 0) in 100..199 && response.status != 101) {
                if (++interim > 8) throw BrowserUpstreamException(BrowserException(BrowserException.Kind.Malformed))
                onStarted()
                local.write(response.bytes)
                val next = upstream { BrowserRelay.head(remote, bytes) }
                response = next.first
                bytes = next.second
            }
            if (response.status == 101) {
                onStarted()
                local.write(response.artifactResponse().bytes)
                if (bytes.isNotEmpty()) local.write(bytes)
                BrowserRelay.duplex(local, remote)
                return
            }
            val framing = upstream { BrowserResponseBody(response, method) }
            onStarted()
            local.write(response.artifactResponse().bytes)
            val complete = relay(remote, local, framing, bytes)
            reusable = api && complete
        } finally {
            pool.release(lease, reusable)
        }
    }

    /**
     * The rest of an answer to the page, as it comes and by its framing,
     * while watching the page's side: a page that goes away stops the
     * upstream (an EventSource with nothing to send), and nothing it sends
     * after its request reaches the daemon. True when the answer ended
     * exactly where its framing said, so the upstream may carry another.
     */
    private suspend fun relay(remote: TransportSocket, local: TransportSocket, framing: BrowserResponseBody, initial: ByteArray): Boolean = coroutineScope {
        val done = CompletableDeferred<Boolean>()
        val relay = launch {
            try {
                upstream { framing.append(initial) }
                if (initial.isNotEmpty()) local.write(initial)
                while (!framing.finished) {
                    val data = upstream { remote.read(65536) }
                    if (data.isEmpty()) {
                        upstream { framing.end() }
                        done.complete(false)
                        return@launch
                    }
                    upstream { framing.append(data) }
                    local.write(data)
                }
                done.complete(framing.reusable)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                done.completeExceptionally(e)
            }
        }
        val watch = launch {
            try {
                local.read(1)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            done.complete(false)
        }
        val reuse = try {
            done.await()
        } finally {
            local.close()
            relay.cancel()
            watch.cancel()
        }
        if (!reuse) remote.close()
        reuse
    }

    /**
     * A plain-http request through the workspace: sent to the target in
     * origin form, closed after its answer, the answer relayed unchanged
     * but for its connection fields.
     */
    private suspend fun forward(
        local: TransportSocket,
        client: AgentClient,
        workspaceId: String,
        authority: BrowserPolicy.Authority,
        head: HttpHead,
        initial: ByteArray,
        onStarted: () -> Unit,
    ) {
        val remote = upstream { BrowserTunnel.open(client, workspaceId, authority) }
        try {
            val upgrade = head.value("upgrade") != null
            val request = head.without("connection", "keep-alive", "proxy-connection", "proxy-authorization", "x-happy-proxy-route")
            remote.write(request.copy(fields = request.fields + ("Connection" to if (upgrade) "Upgrade" else "close")).bytes)
            if (initial.isNotEmpty()) remote.write(initial)
            coroutineScope {
                // The rest of a request body follows as the page sends it.
                val sending = launch {
                    try {
                        BrowserRelay.pipe(local, remote)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }
                val (response, bytes) = upstream { BrowserRelay.head(remote) }
                onStarted()
                local.write(response.closedResponse().bytes)
                if (bytes.isNotEmpty()) local.write(bytes)
                if (response.status == 101) {
                    sending.cancel()
                    BrowserRelay.duplex(local, remote)
                } else {
                    BrowserRelay.pipe(remote, local)
                    sending.cancel()
                }
            }
        } finally {
            remote.close()
        }
    }

    private suspend fun <T> upstream(block: suspend () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: BrowserUpstreamException) {
        throw e
    } catch (e: Exception) {
        throw BrowserUpstreamException(e)
    }

    companion object {
        private const val TAG = "BrowserProxy"
        const val MAX_CONNECTIONS = 64

        /** Where the listener is, and what WebView's proxy rule and the fetcher name. */
        val LOOPBACK: InetAddress = InetAddress.getByAddress("127.0.0.1", byteArrayOf(127, 0, 0, 1))
        private val ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray()
        private val PROXY_AUTH_REQUIRED =
            "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Happy\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()
        private val random = SecureRandom()

        private fun token(): String = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }

        internal fun basic(user: String, password: String) =
            "Basic " + Base64.encodeToString("$user:$password".toByteArray(), Base64.NO_WRAP)
    }
}

/** The upstream (the computer, or the target behind it) failed, as opposed to the request. */
class BrowserUpstreamException(cause: Throwable) : Exception(cause)

/**
 * iOS's `BrowserFailure`: a safe, stable answer for a failure the proxy made
 * itself. Never a URL, token, header or upstream body; daemon answers
 * (400, 409, 413 included) pass through untouched and never come here.
 */
data class BrowserFailure(val status: Int, val reason: String, val code: String) {
    val bytes: ByteArray get() {
        val body = """{"code":"$code","error":"$reason"}""".toByteArray()
        return ("HTTP/1.1 $status $reason\r\nContent-Type: application/json\r\nX-Happy-Proxy-Error: $code\r\n" +
            "Content-Length: ${body.size}\r\nConnection: close\r\nProxy-Connection: close\r\n\r\n").toByteArray() + body
    }

    companion object {
        private fun failure(status: Int, reason: String, code: String) = BrowserFailure(status, reason, "browser_proxy_$code")

        /** Tailcat ran out of connections somewhere under [error] (the transport wraps it). */
        private fun atCapacity(error: Throwable?): Boolean = generateSequence(error) { it.cause }.take(8)
            .any { it is io.tailcat.stack.TailcatTransportException && it.reason == io.tailcat.stack.TailcatTransportException.Reason.RESOURCE_LIMIT }

        fun of(error: Throwable): BrowserFailure {
            if (error is BrowserUpstreamException) {
                val cause = error.cause
                return when {
                    cause is BrowserException && cause.kind == BrowserException.Kind.Timeout -> failure(504, "Gateway Timeout", "upstream_timeout")
                    cause is BrowserException && (cause.kind == BrowserException.Kind.Malformed || cause.kind == BrowserException.Kind.TooLarge) ->
                        failure(502, "Bad Gateway", "upstream_response_invalid")
                    cause is BrowserException && cause.kind == BrowserException.Kind.Upstream && cause.status in 400..599 ->
                        failure(cause.status, "Upstream Refused", "upstream_refused")
                    atCapacity(cause) -> failure(503, "Service Unavailable", "upstream_capacity")
                    else -> failure(502, "Bad Gateway", "upstream_transport")
                }
            }
            if (atCapacity(error)) return failure(503, "Service Unavailable", "upstream_capacity")
            if (error is BrowserException) {
                return when (error.kind) {
                    BrowserException.Kind.Forbidden -> failure(403, "Forbidden", "forbidden")
                    BrowserException.Kind.Malformed -> failure(400, "Bad Request", "request_invalid")
                    BrowserException.Kind.TooLarge -> failure(413, "Content Too Large", "request_too_large")
                    BrowserException.Kind.Unavailable -> failure(503, "Service Unavailable", "route_unavailable")
                    BrowserException.Kind.Timeout -> failure(408, "Request Timeout", "request_timeout")
                    BrowserException.Kind.Upstream ->
                        if (error.status in 400..599) failure(error.status, "Upstream Refused", "upstream_refused") else failure(502, "Bad Gateway", "upstream_transport")
                }
            }
            if (error is AgentConnectionException) return failure(502, "Bad Gateway", "upstream_transport")
            if (error is java.io.IOException) return failure(502, "Bad Gateway", "socket_transport")
            return failure(500, "Internal Server Error", "internal")
        }
    }
}
