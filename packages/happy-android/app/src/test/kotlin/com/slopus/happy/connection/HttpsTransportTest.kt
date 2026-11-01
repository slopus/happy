package com.slopus.happy.connection

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Protocol
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import javax.net.ssl.SSLHandshakeException

class HttpsTransportTest {
    @Test fun ownDeadlineIsUnavailableButCallerDeadlineRemainsCancellation() = runBlocking {
        val (serverKeys, clientRoots) = certificates()
        server(serverKeys).use { server ->
            val transport = HttpsTransport(AgentOrigin.parse("https://localhost:${server.port}"), clientRoots.sslSocketFactory(), requestTimeoutMillis = 1_000)
            try {
                server.enqueue(MockResponse.Builder().headersDelay(3, TimeUnit.SECONDS).body("late").build())
                try { transport.request("GET", "/v0/config", "token"); fail("deadline ignored") }
                catch (error: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.Unavailable, error.reason) }
                currentCoroutineContext().ensureActive()
                server.enqueue(MockResponse.Builder().body("reconnected").build())
                assertEquals("reconnected", transport.request("GET", "/v0/health", "token").text)
                server.enqueue(MockResponse.Builder().headersDelay(3, TimeUnit.SECONDS).body("late").build())
                try { withTimeout(100) { transport.request("GET", "/v0/config", "token") }; fail("caller deadline ignored") }
                catch (_: TimeoutCancellationException) { }
            } finally { transport.close() }
        }
    }
    private fun certificates(host: String = "localhost"): Pair<HandshakeCertificates, HandshakeCertificates> {
        val certificate = HeldCertificate.Builder().commonName(host).addSubjectAlternativeName(host).build()
        return HandshakeCertificates.Builder().heldCertificate(certificate).build() to
            HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    }

    private fun server(certificates: HandshakeCertificates): MockWebServer = MockWebServer().apply {
        useHttps(certificates.sslSocketFactory())
        protocols = listOf(Protocol.HTTP_1_1)
        start()
    }

    @Test fun verifiedTlsCarriesBearerFilesAndRejectsRedirectFollowing() = runBlocking {
        val (serverKeys, clientRoots) = certificates()
        server(serverKeys).use { server ->
            val origin = AgentOrigin.parse("https://localhost:${server.port}")
            val transport = HttpsTransport(origin, clientRoots.sslSocketFactory())
            try {
                server.enqueue(MockResponse.Builder().code(200).body("{\"ok\":true}").build())
                val bytes = byteArrayOf(0, 1, 2, -1)
                val response = transport.request("PUT", "/v0/files/example", "device-token", bytes, mapOf("Content-Type" to "application/octet-stream"))
                assertEquals(200, response.status)
                val request = server.takeRequest()
                assertEquals("localhost:${server.port}", request.headers["Host"])
                assertEquals("Bearer device-token", request.headers["Authorization"])
                assertArrayEquals(bytes, request.body!!.toByteArray())
                server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "http://elsewhere.invalid/").build())
                assertEquals(302, transport.request("GET", "/v0/health", "device-token").status)
                assertEquals(2, server.requestCount)
            } finally { transport.close() }
        }
    }

    @Test fun platformTrustRejectsUnknownCertificateBeforeBearerIsWritten() = runBlocking {
        val (serverKeys, _) = certificates()
        server(serverKeys).use { server ->
            val transport = HttpsTransport(AgentOrigin.parse("https://localhost:${server.port}"))
            try {
                try { withTimeout(10_000) { transport.request("GET", "/v0/health", "must-not-arrive") }; fail("untrusted TLS accepted") }
                catch (_: SSLHandshakeException) { }
                assertEquals(0, server.requestCount)
            } finally { transport.close() }
        }
    }

    @Test fun eventStreamAndRawBrowserConnectionUseTheSameTlsOrigin() = runBlocking {
        val (serverKeys, clientRoots) = certificates()
        server(serverKeys).use { server ->
            val transport = HttpsTransport(AgentOrigin.parse("https://localhost:${server.port}"), clientRoots.sslSocketFactory())
            try {
                server.enqueue(MockResponse.Builder().chunkedBody("id: one\ndata: {}\n\n", 3).build())
                val events = transport.stream("/v0/events/stream", "token", mapOf("Last-Event-ID" to "before"))
                try { assertEquals("id: one\ndata: {}\n\n", events.readAll().decodeToString()) }
                finally { events.close() }
                assertEquals("before", server.takeRequest().headers["Last-Event-ID"])
                server.enqueue(MockResponse.Builder().code(200).body("").build())
                val socket = transport.socket()
                try {
                    assertEquals("localhost:${server.port}", socket.authority)
                    com.slopus.happy.browser.BrowserTunnel.connect(socket, "/v0/workspaces/workspace/proxy", "token")
                    val connect = server.takeRequest()
                    assertEquals("CONNECT", connect.method)
                    assertEquals("localhost:${server.port}", connect.headers["Host"])
                    assertEquals("Bearer token", connect.headers["Authorization"])
                } finally { socket.close() }
            } finally { transport.close() }
        }
    }

    @Test fun trustedCertificateStillRequiresMatchingHostname() = runBlocking {
        val (serverKeys, clientRoots) = certificates("not-localhost.example")
        server(serverKeys).use { server ->
            val transport = HttpsTransport(AgentOrigin.parse("https://localhost:${server.port}"), clientRoots.sslSocketFactory())
            try {
                try { withTimeout(10_000) { transport.request("GET", "/v0/health", "must-not-arrive") }; fail("wrong TLS hostname accepted") }
                catch (_: SSLHandshakeException) { }
                assertEquals(0, server.requestCount)
            } finally { transport.close() }
        }
    }
}