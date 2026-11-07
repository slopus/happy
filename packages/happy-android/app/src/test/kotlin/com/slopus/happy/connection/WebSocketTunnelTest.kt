package com.slopus.happy.connection

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.browser.BrowserException
import com.slopus.happy.browser.BrowserTunnel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * Tunnels over WebSockets (edge SSO contract §4): bytes both ways in
 * binary messages, an empty one ending a direction, the bearer only in
 * `Authorization`, and an edge that refuses CONNECT turning tunnels off.
 */
class WebSocketTunnelTest {
    private val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
        protocols = listOf(Protocol.HTTP_1_1)
        start()
    }
    private val roots = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    private val webSockets = OkHttpClient.Builder()
        .sslSocketFactory(roots.sslSocketFactory(), roots.trustManager)
        .followRedirects(false)
        .pingInterval(WebSocketTunnel.PING_SECONDS, TimeUnit.SECONDS)
        .build()
    private val origin = AgentOrigin.parse("https://localhost:${server.port}")
    private val transport = HttpsTransport(origin, roots.sslSocketFactory(), webSockets = webSockets)

    @After
    fun tearDown() = runBlocking {
        transport.close()
        server.close()
    }

    /** The daemon's side: echoes what comes, and ends its direction when the phone ends its own. */
    private val echo = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            webSocket.send(bytes)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    }

    private val health = MockResponse.Builder().addHeader("Content-Type", "application/json")
        .body("""{"healthy":true,"ready":true,"version":{"protocol":33,"daemon":"1"},"capabilities":{"webSocketTunnels":true}}""").build()

    @Test
    fun bytesGoBothWaysAndAnEmptyMessageEndsTheStream() = runBlocking {
        server.enqueue(MockResponse.Builder().webSocketUpgrade(echo).build())
        val tunnel = withTimeout(10_000) { transport.webSocketTunnel("/v0/workspaces/w1/proxy/websocket", "access-1") }
        try {
            val request = server.takeRequest()
            assertEquals("/v0/workspaces/w1/proxy/websocket", request.target)
            assertEquals("Bearer access-1", request.headers["Authorization"])
            assertEquals("localhost:${server.port}", tunnel.authority)
            val big = ByteArray(200_000) { (it % 251).toByte() }
            tunnel.write(big)
            var read = ByteArray(0)
            withTimeout(10_000) { while (read.size < big.size) read += tunnel.read(65536) }
            assertArrayEquals(big, read)
            // The echo of an empty message: the other side has finished.
            tunnel.write(ByteArray(0))
        } finally {
            tunnel.close()
        }
    }

    @Test
    fun aRefusedUpgradeCarriesItsAnswer() = runBlocking {
        server.enqueue(MockResponse.Builder().code(401).addHeader("Content-Type", "application/json").body("""{"error":"Unauthorized","code":"unauthorized"}""").build())
        try {
            transport.webSocketTunnel("/v0/workspaces/w1/proxy/websocket", "stale")
            fail("upgraded")
        } catch (e: UpgradeRefused) {
            assertEquals(401, e.response.status)
            assertTrue(SignInRule.requiresSignIn(e.response))
        }
    }

    @Test
    fun theBrowserPrefersTheWebSocketTwinWhenHealthOffersIt() = runBlocking {
        server.enqueue(health)
        server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // The nested CONNECT's answer, as the daemon writes it inside the tunnel.
                webSocket.send(ByteString.of(*"HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray()))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
        }).build())
        val client = AgentClient(transport, "device-token")
        val tunnel = withTimeout(10_000) { BrowserTunnel.open(client, com.slopus.happy.browser.BrowserNetwork.workspace("w1"), com.slopus.happy.browser.BrowserPolicy.Authority.parse("localhost:3000")!!) }
        tunnel.close()
        assertEquals("/v0/health", server.takeRequest().target)
        assertEquals("/v0/workspaces/w1/proxy/websocket", server.takeRequest().target)
    }

    @Test
    fun anEdgeThatRefusesConnectTurnsTunnelsOff() = runBlocking {
        server.enqueue(MockResponse.Builder().addHeader("Content-Type", "application/json").body("""{"healthy":true,"ready":true,"version":{"protocol":33,"daemon":"1"}}""").build())
        // A load balancer's own page for CONNECT.
        server.enqueue(MockResponse.Builder().code(405).addHeader("Content-Type", "text/html").body("<html>Method Not Allowed</html>").build())
        val client = AgentClient(transport, "device-token")
        try {
            withTimeout(10_000) { BrowserTunnel.open(client, com.slopus.happy.browser.BrowserNetwork.workspace("w1"), com.slopus.happy.browser.BrowserPolicy.Authority.parse("localhost:3000")!!) }
            fail("tunnelled")
        } catch (_: BrowserException) {
        }
        assertTrue(client.tunnelsBlocked.value)
        // Not asked again.
        val before = server.requestCount
        try { BrowserTunnel.open(client, com.slopus.happy.browser.BrowserNetwork.workspace("w1"), com.slopus.happy.browser.BrowserPolicy.Authority.parse("localhost:3000")!!); fail() } catch (_: BrowserException) {}
        assertEquals(before, server.requestCount)
    }
}
