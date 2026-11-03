package com.slopus.happy.browser

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportSocket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * [BrowserProxy] end to end against a byte-level fake daemon (iOS's
 * HostedBrowserTests / HostedBrowserFailureTests, without WebKit): the
 * client is OkHttp through the loopback proxy, the daemon a local socket
 * standing in for the agent's Tailcat socket.
 */
@RunWith(RobolectricTestRunner::class)
class BrowserProxyTest {
    /** The agent's socket: counts connections, records every request head, answers by path. */
    private class Daemon {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val connections = AtomicInteger()
        val ended = AtomicInteger()
        val heads = CopyOnWriteArrayList<String>()

        init {
            thread(isDaemon = true) {
                while (true) {
                    val socket = try {
                        server.accept()
                    } catch (_: Exception) {
                        return@thread
                    }
                    connections.incrementAndGet()
                    thread(isDaemon = true) {
                        try {
                            serve(socket)
                        } catch (_: Exception) {
                        } finally {
                            ended.incrementAndGet()
                        }
                    }
                }
            }
        }

        private fun serve(socket: Socket): Unit = socket.use {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            while (true) {
                val head = StringBuilder()
                while (!head.endsWith("\r\n\r\n")) {
                    val byte = input.read()
                    if (byte < 0) return
                    head.append(byte.toChar())
                }
                val text = head.toString()
                heads += text
                val length = Regex("(?i)content-length: (\\d+)").find(text)?.groupValues?.get(1)?.toInt() ?: 0
                val body = ByteArray(length).also { var read = 0; while (read < length) read += input.read(it, read, length - read) }
                val target = text.substringBefore("\r\n").split(' ')[1]
                val keepAlive = text.contains("Connection: keep-alive")
                when {
                    target.startsWith("/v0/artifacts/a1/api/echo") -> {
                        val answer = "echo:" + body.decodeToString()
                        output.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: ${answer.length}\r\n\r\n$answer".toByteArray())
                    }
                    target.startsWith("/v0/artifacts/a1/api/chunks") ->
                        output.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n0\r\nX-Done: yes\r\n\r\n".toByteArray())
                    target.startsWith("/v0/artifacts/a1/api/conflict") ->
                        output.write("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".toByteArray())
                    target.startsWith("/v0/artifacts/a1/api/eof") -> {
                        output.write("HTTP/1.1 200 OK\r\n\r\nuntil-close".toByteArray())
                        output.flush()
                        return
                    }
                    target.startsWith("/v0/artifacts/a1/api/truncated") -> {
                        output.write("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nshort".toByteArray())
                        output.flush()
                        return
                    }
                    target == "/v0/artifacts/a1/versions/3/files/index.html" ->
                        output.write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: sandbox allow-scripts\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi".toByteArray())
                    else -> output.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray())
                }
                output.flush()
                if (!keepAlive) return
            }
        }

        fun close() = server.close()
    }

    private class Sockets(val port: Int) : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)

        override suspend fun socket(): TransportSocket = LocalSocket(Socket(InetAddress.getLoopbackAddress(), port))
        override suspend fun close() {}
    }

    private lateinit var daemon: Daemon
    private lateinit var scope: CoroutineScope
    private lateinit var proxy: BrowserProxy
    private lateinit var page: BrowserProxy.Page
    private lateinit var http: OkHttpClient
    private lateinit var client: AgentClient
    private val origin = "http://aeachtest.happy-artifact.invalid"

    @Before fun setUp() {
        daemon = Daemon()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        proxy = BrowserProxy(scope)
        client = AgentClient(Sockets(daemon.server.localPort), "device-token")
        val authority = BrowserPolicy.Authority.of(origin)!!
        page = proxy.open(BrowserProxy.Scope.Artifact(client, "a1", 3, authority, workspace = null), webView = false)
        http = OkHttpClient.Builder()
            .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress(BrowserProxy.LOOPBACK, proxy.port)))
            .proxyAuthenticator { _, response -> response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(page.username, page.password)).build() }
            .readTimeout(10, TimeUnit.SECONDS)
            .build()
    }

    @After fun tearDown() {
        page.close()
        proxy.shutdown()
        scope.cancel()
        daemon.close()
    }

    private fun through(page: BrowserProxy.Page) = http.newBuilder()
        .proxyAuthenticator { _, response -> response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(page.username, page.password)).build() }
        .build()

    @Test fun anIsolatedPageCannotReachAnotherPagesOrigin() {
        // A WebView in a profile of its own, as with MULTI_PROFILE: its credential, its workspace.
        val other = proxy.open(BrowserProxy.Scope.Workspace(client) { "wsother" }, webView = true, isolated = true)
        through(other).newCall(Request.Builder().url("$origin/index.html").build()).execute().use {
            // Sent to its own workspace as any web address, which knows no such host.
            assertEquals("browser_proxy_upstream_refused", it.header("X-Happy-Proxy-Error"))
        }
        assertTrue(daemon.heads.any { it.startsWith("CONNECT /v0/workspaces/wsother/proxy ") })
        assertFalse(daemon.heads.any { it.contains("/v0/artifacts/") })
        // The shared WebView credential finds no shared page to borrow either.
        OkHttpClient.Builder()
            .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress(BrowserProxy.LOOPBACK, proxy.port)))
            .proxyAuthenticator { _, response -> if (response.request.header("Proxy-Authorization") != null) null else response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(proxy.webUsername, proxy.webPassword)).build() }
            .build().newCall(Request.Builder().url("$origin/index.html").build()).execute().use { assertEquals(407, it.code) }
        other.close()
    }

    private fun get(path: String) = http.newCall(Request.Builder().url(origin + path).build()).execute()

    @Test fun apiRequestsReuseOneUpstreamConnection() {
        repeat(5) { index ->
            val response = http.newCall(Request.Builder().url("$origin/api/echo?n=$index").post("body$index".toRequestBody()).build()).execute()
            response.use {
                assertEquals(200, it.code)
                assertEquals("echo:body$index", it.body.string())
                assertEquals(listOf("a=1", "b=2"), it.headers("Set-Cookie"))
            }
        }
        response("/api/chunks") { assertEquals("one", it.body.string()) }
        assertEquals(1, daemon.connections.get())
        // Every request authenticated on the native side, keep-alive, scoped to the artifact.
        assertTrue(daemon.heads.all { it.contains("Authorization: Bearer device-token") && it.contains("Host: server.tailcat") })
        assertTrue(daemon.heads.all { it.contains("Connection: keep-alive") })
        assertFalse(daemon.heads.any { it.contains("Proxy-Authorization") })
    }

    @Test fun daemonErrorsPassThroughAndStillPool() {
        response("/api/conflict") {
            assertEquals(409, it.code)
            assertEquals(null, it.header("X-Happy-Proxy-Error"))
        }
        response("/api/echo") { assertEquals(200, it.code) }
        assertEquals(1, daemon.connections.get())
    }

    @Test fun closeDelimitedAndTruncatedAnswersAreNeverPooled() {
        response("/api/eof") { assertEquals("until-close", it.body.string()) }
        response("/api/echo") { assertEquals(200, it.code) }
        assertEquals(2, daemon.connections.get())
        // Truncated after its head: the page sees the cut, not a second answer.
        response("/api/truncated") { runCatching { it.body.string() }.onSuccess { body -> assertFalse(body.contains("browser_proxy")) } }
        response("/api/echo") { assertEquals(200, it.code) }
        // The truncated answer used the pooled connection, which then closed.
        assertEquals(3, daemon.connections.get())
    }

    @Test fun filesGetTheirOwnConnectionAndASameOriginSandbox() {
        response("/index.html") {
            assertEquals("hi", it.body.string())
            assertEquals("sandbox allow-scripts allow-same-origin", it.header("Content-Security-Policy"))
        }
        response("/index.html") { assertEquals(200, it.code) }
        assertEquals(2, daemon.connections.get())
        assertTrue(daemon.heads.all { it.contains("Connection: close") })
    }

    @Test fun refusedPathsAndExternalRequestsFailLocallyWithoutUpstream() {
        response("/api/..%2F..%2Fv0%2Fagents") {
            assertEquals(403, it.code)
            assertEquals("browser_proxy_forbidden", it.header("X-Happy-Proxy-Error"))
        }
        // A bundled artifact without a workspace reaches nothing else.
        http.newCall(Request.Builder().url("http://example.com/").build()).execute().use {
            assertEquals(503, it.code)
            assertEquals("browser_proxy_route_unavailable", it.header("X-Happy-Proxy-Error"))
        }
        assertEquals(0, daemon.connections.get())
    }

    @Test fun closingThePageClosesPooledConnections() {
        response("/api/echo") { assertEquals(200, it.code) }
        assertEquals(1, daemon.connections.get())
        assertEquals(0, daemon.ended.get())
        page.close()
        // The pooled socket is closed: the daemon's read ends.
        val deadline = System.currentTimeMillis() + 5000
        while (daemon.ended.get() == 0 && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(1, daemon.ended.get())
    }

    /** WebView reports only ERR_TUNNEL_CONNECTION_FAILED for a refused CONNECT: the page keeps why, per host (iOS 34aa464e1). */
    @Test fun aRefusedTunnelIsKeptForItsHost() {
        val other = proxy.open(BrowserProxy.Scope.Workspace(client) { "wsother" }, webView = true, isolated = true)
        assertEquals(null, other.refusals.last("https://secure.example/"))
        runCatching { through(other).newCall(Request.Builder().url("https://secure.example/").build()).execute().close() }
        assertEquals(BrowserProxyRefusal(404, "browser_proxy_upstream_refused"), other.refusals.last("https://secure.example/"))
        assertEquals(null, other.refusals.last("https://elsewhere.example/"))
        assertEquals(null, page.refusals.last("https://secure.example/"))
        other.refusals.clear()
        assertEquals(null, other.refusals.last("https://secure.example/"))
        other.close()
    }

    private fun response(path: String, check: (okhttp3.Response) -> Unit) = get(path).use(check)
}
