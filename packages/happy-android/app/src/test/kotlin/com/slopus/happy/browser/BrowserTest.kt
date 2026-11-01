package com.slopus.happy.browser

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportSocket
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** iOS's `BrowserTests` and `BrowserResponseTests`: the in-app browser's proxy policy, heads, tunnel and failures. */
class BrowserTest {
    private class Bytes(vararg pending: String) : TransportSocket {
        val pending = pending.map { it.toByteArray() }.toMutableList()
        val writes = mutableListOf<ByteArray>()
        var closed = false
        override suspend fun read(maximumBytes: Int): ByteArray = if (pending.isEmpty()) ByteArray(0) else pending.removeAt(0)
        override suspend fun write(bytes: ByteArray) {
            writes += bytes
        }

        override fun close() {
            closed = true
        }
    }

    private class Sockets(val bytes: Bytes) : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)

        override suspend fun socket(): TransportSocket = bytes
        override suspend fun close() {}
    }

    private class Routing(val responses: Map<String, String>) : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) =
            TransportResponse(if (responses[path] == null) 404 else 200, body = (responses[path] ?: "{}").toByteArray())

        override suspend fun close() {}
    }

    private fun head(text: String) = HttpHead.parse(text.toByteArray())!!.first

    private fun throwsBrowser(kind: BrowserException.Kind? = null, block: () -> Unit) {
        try {
            block()
            fail("expected a BrowserException")
        } catch (e: BrowserException) {
            if (kind != null) assertEquals(kind, e.kind)
        }
    }

    @Test fun classification() {
        val hosts = listOf(
            "localhost", "localhost.", "a.localhost", "127.0.0.1", "127.1", "0x7f000001", "2130706433", "0.0.0.0", "Mac.local", "intranet",
            "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.2", "169.254.1.2", "100.64.0.1", "[::1]", "[fd00::1]", "[fe80::1]",
            "[::ffff:127.0.0.1]", "[::ffff:7f00:1]",
        )
        for (host in hosts) assertEquals(host, BrowserPolicy.Route.Web, BrowserPolicy.route("http://$host:5173/"))
        for (host in listOf("example.com", "172.32.0.1", "192.169.1.2", "8.8.8.8", "[2606:4700::1111]")) {
            assertEquals(host, BrowserPolicy.Route.Web, BrowserPolicy.route("https://$host/"))
        }
        assertEquals(BrowserPolicy.Route.Web, BrowserPolicy.route("https://preview.example.com"))
        assertEquals(BrowserPolicy.Route.System, BrowserPolicy.route("mailto:steve@example.com"))
        assertEquals(BrowserPolicy.Route.System, BrowserPolicy.route("tel:1234"))
    }

    @Test fun authority() {
        assertEquals("example.com:443", BrowserPolicy.Authority.of("https://EXAMPLE.com")?.text)
        assertEquals("[::1]:5173", BrowserPolicy.Authority.of("http://[::1]:5173")?.text)
        assertNull(BrowserPolicy.Authority.of("http://user:secret@localhost"))
        assertNull(BrowserPolicy.Authority.of("http://:80"))
        // Browsers canonicalize these before CONNECT; the proxy compares the same text.
        assertEquals("127.0.0.1:80", BrowserPolicy.Authority.of("http://0x7f000001")?.text)
        assertEquals("127.0.0.1:80", BrowserPolicy.Authority.of("http://127.1")?.text)
        assertEquals("[::1]:80", BrowserPolicy.Authority.parse("[0:0:0:0:0:0:0:1]:80")?.text)
        assertEquals("[fd00::1:0:0:1]:443", BrowserPolicy.Authority.parse("[FD00:0:0:0:1:0:0:1]:443")?.text)
        assertEquals(BrowserPolicy.Authority("abc.invalid", 80), BrowserPolicy.Authority.parse("abc.invalid:80"))
        assertNull(BrowserPolicy.Authority.parse("abc.invalid"))
        assertNull(BrowserPolicy.Authority.parse("abc.invalid:80/path"))
    }

    @Test fun workspaceSelectionUsesArtifactThenChatThenLocalHost() = runBlocking {
        val client = AgentClient(
            Routing(
                mapOf(
                    "/v0/artifacts/art1" to """{"artifact":{"updatedSource":{"workspaceId":"artifactworkspace"}}}""",
                    "/v0/agents/chat1" to """{"agent":{"id":"chat1","workspaceId":"chatworkspace","status":"idle"}}""",
                    "/v0/workspaces" to """{"workspaces":[{"id":"runnerworkspace","status":"active","compute":{"type":"host","runnerId":"runner1"}},{"id":"hostworkspace","status":"active","compute":{"type":"host"}}]}""",
                ),
            ),
            "test",
        )
        assertEquals("artifactworkspace", client.browserWorkspace(agentId = "chat1", artifactId = "art1"))
        assertEquals("chatworkspace", client.browserWorkspace(agentId = "chat1"))
        assertEquals("hostworkspace", client.browserWorkspace())
        val runnerOnly = AgentClient(
            Routing(mapOf("/v0/workspaces" to """{"workspaces":[{"id":"runnerworkspace","status":"active","compute":{"type":"host","runnerId":"runner1"}}]}""")),
            "test",
        )
        val error = runCatching { runnerOnly.browserWorkspace() }.exceptionOrNull()
        assertEquals("must not silently use a runner as the host fallback", BrowserException.Kind.Unavailable, (error as? BrowserException)?.kind)
    }

    @Test fun artifactBoundaryAndQueryArePreserved() {
        assertEquals("/v0/artifacts/art1/api/v1/kv/entry?key=a%2Fb", BrowserPolicy.artifactPath("/api/v1/kv/entry?key=a%2Fb", "art1", 2))
        assertEquals("/v0/artifacts/art1/versions/2/files/nested/app.js", BrowserPolicy.artifactPath("/nested/app.js", "art1", 2))
        for (target in listOf("//other/api/v1", "/api/../agents", "/api/%2e%2e/agents", "/api/%252e%252e/agents", "/api/a%2fb", "/api/a%5cb", "/api/a%00", "/api/a\r\nX:yes", "http://other/")) {
            throwsBrowser(BrowserException.Kind.Forbidden) { BrowserPolicy.artifactPath(target, "art1", 2) }
        }
        throwsBrowser(BrowserException.Kind.Forbidden) { BrowserPolicy.artifactPath("/a.js", "../agents", 2) }
    }

    @Test fun requestTranslationPreservesMethodsAndConditionsButReplacesCredentials() {
        val raw = "PUT /api/v1/kv/entry?key=a HTTP/1.1\r\nHost: page\r\nAuthorization: attacker\r\nProxy-Authorization: local\r\nX-Happy-Proxy-Route: attacker\r\n" +
            "If-Match: version1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
        val (head, rest) = HttpHead.parse(raw.toByteArray())!!
        val translated = head.artifactRequest("art1", 3, "native-token")
        assertEquals("PUT /v0/artifacts/art1/api/v1/kv/entry?key=a HTTP/1.1", translated.line)
        assertEquals("Bearer native-token", translated.value("Authorization"))
        assertEquals("version1", translated.value("If-Match"))
        assertEquals("close", translated.value("Connection"))
        assertNull(translated.value("Proxy-Authorization"))
        assertNull(translated.value("X-Happy-Proxy-Route"))
        assertArrayEquals("{}".toByteArray(), rest)
        throwsBrowser(BrowserException.Kind.Malformed) { head("CONNECT x:80 HTTP/1.1\r\n\r\n").artifactRequest("art1", 3, "t") }
    }

    @Test fun responsePreservesErrorStatusAndDuplicateCookies() {
        val raw = "HTTP/1.1 409 Conflict\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nETag: x\r\nRetry-After: 3\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n"
        val (head, rest) = HttpHead.parse(raw.toByteArray())!!
        val result = head.artifactResponse()
        assertEquals("HTTP/1.1 409 Conflict", result.line)
        assertEquals(2, result.fields.count { it.first == "Set-Cookie" })
        assertEquals("3", result.value("Retry-After"))
        assertEquals("chunked", result.value("Transfer-Encoding"))
        assertArrayEquals("2\r\n{}\r\n0\r\n\r\n".toByteArray(), rest)
    }

    @Test fun artifactSandboxAdjustmentPreservesOtherServerPolicies() {
        val sandboxed = head("HTTP/1.1 200 OK\r\nContent-Security-Policy: sandbox allow-scripts; default-src 'self'\r\n\r\n")
        assertEquals("sandbox allow-scripts allow-same-origin; default-src 'self'", sandboxed.artifactResponse().value("Content-Security-Policy"))
        // None: a sandbox that keeps the origin is added, so the page is isolated as iOS's is.
        assertTrue(head("HTTP/1.1 200 OK\r\n\r\n").artifactResponse().value("Content-Security-Policy")!!.startsWith("sandbox allow-scripts allow-same-origin"))
        assertEquals("Upgrade", head("HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\n\r\n").artifactResponse().value("Connection"))
    }

    @Test fun headsAreBoundedAndWellFormed() {
        assertNull(HttpHead.parse("GET / HTTP/1.1\r\nHost: a".toByteArray()))
        throwsBrowser(BrowserException.Kind.TooLarge) { HttpHead.parse(ByteArray(HttpHead.LIMIT + 1) { 'a'.code.toByte() }) }
        throwsBrowser(BrowserException.Kind.Malformed) { HttpHead.parse("GET / HTTP/1.1\r\nNo colon\r\n\r\n".toByteArray()) }
        throwsBrowser(BrowserException.Kind.Malformed) { HttpHead.parse("GET / HTTP/1.1\r\nBad Name: x\r\n\r\n".toByteArray()) }
    }

    @Test fun streamingForwardsEachChunkBeforeReadingAnother() = runBlocking {
        val source = Bytes("data: first\n\n", "data: update\n\n")
        val destination = Bytes()
        BrowserRelay.pipe(source, destination)
        assertEquals(listOf("data: first\n\n", "data: update\n\n"), destination.writes.map { it.decodeToString() })
    }

    @Test fun connectAuthenticatesOnlyOuterTunnelAndKeepsWorkspace() = runBlocking {
        val bytes = Bytes("HTTP/1.1 200 OK\r\n\r\n", "HTTP/1.1 200 OK\r\n\r\n")
        val client = AgentClient(Sockets(bytes), "native-token")
        val stream = BrowserTunnel.open(client, "runnerworkspace", BrowserPolicy.Authority.of("http://localhost:5173")!!)
        stream.close()
        val written = bytes.writes.map { it.decodeToString() }
        assertTrue(written[0].startsWith("CONNECT /v0/workspaces/runnerworkspace/proxy"))
        assertTrue(written[0].contains("Authorization: Bearer native-token"))
        assertTrue(written[1].startsWith("CONNECT localhost:5173"))
        assertFalse(written[1].contains("native-token"))
    }

    @Test fun connectErrorClosesStream() = runBlocking {
        val bytes = Bytes("HTTP/1.1 403 Forbidden\r\n\r\n")
        val client = AgentClient(Sockets(bytes), "token")
        val error = runCatching { BrowserTunnel.open(client, "work1", BrowserPolicy.Authority.of("http://localhost")!!) }.exceptionOrNull() as BrowserException
        assertEquals(BrowserException.Kind.Upstream, error.kind)
        assertEquals(403, error.status)
        assertTrue(bytes.closed)
    }

    @Test fun chunkedRequestIsBoundedAndCannotSmuggleAnotherRequest() = runBlocking {
        val chunked = head("PUT /api/v1/kv/entry HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
        val stream = Bytes("2\r\n{}\r\n0\r\n\r\nGET /v0/config HTTP/1.1\r\n\r\n")
        val (request, body) = BrowserRelay.requestBody(chunked, ByteArray(0), stream)
        assertArrayEquals("{}".toByteArray(), body)
        assertEquals("2", request.value("Content-Length"))
        assertNull(request.value("Transfer-Encoding"))
        val bad = head("PUT /api/v1/kv/entry HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n")
        val error = runCatching { BrowserRelay.requestBody(bad, ByteArray(0), stream) }.exceptionOrNull()
        assertEquals(BrowserException.Kind.Malformed, (error as? BrowserException)?.kind)
    }

    @Test fun aResponseIsReadByItsLengthItsChunksOrToTheClose() = runBlocking {
        val (_, length, status) = BrowserRelay.response(Bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe", "llo", "extra"), 100)
        assertEquals(200, status)
        assertEquals("hello", length.decodeToString())
        val (_, chunks, _) = BrowserRelay.response(Bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n", "3\r\ntwo\r\n0\r\n\r\n"), 100)
        assertEquals("onetwo", chunks.decodeToString())
        val (_, closed, _) = BrowserRelay.response(Bytes("HTTP/1.1 200 OK\r\n\r\nstream"), 100)
        assertEquals("stream", closed.decodeToString())
        val tooLarge = runCatching { BrowserRelay.response(Bytes("HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n"), 100) }.exceptionOrNull()
        assertEquals(BrowserException.Kind.TooLarge, (tooLarge as? BrowserException)?.kind)
        val truncated = runCatching { BrowserRelay.response(Bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe"), 100) }.exceptionOrNull()
        assertEquals(BrowserException.Kind.Malformed, (truncated as? BrowserException)?.kind)
    }

    @Test fun thirdPartyFramesCannotBorrowArtifactApi() {
        val authority = BrowserPolicy.Authority.of("http://artifact.invalid")!!
        for (origin in listOf("https://attacker.example", "null", "http://artifact.invalid:1234")) {
            throwsBrowser(BrowserException.Kind.Forbidden) {
                BrowserPolicy.checkArtifactOrigin(head("POST /api/v1/debug/log HTTP/1.1\r\nOrigin: $origin\r\n\r\n"), authority)
            }
        }
        BrowserPolicy.checkArtifactOrigin(head("POST /api/v1/debug/log HTTP/1.1\r\nOrigin: http://artifact.invalid\r\nSec-Fetch-Site: same-origin\r\n\r\n"), authority)
        throwsBrowser(BrowserException.Kind.Forbidden) {
            BrowserPolicy.checkArtifactOrigin(head("GET /api/v1/x HTTP/1.1\r\nSec-Fetch-Site: cross-site\r\n\r\n"), authority)
        }
    }

    @Test fun failuresDistinguishLocalValidationFromUpstreamTransport() {
        val cases = listOf(
            BrowserException(BrowserException.Kind.Forbidden) to (403 to "forbidden"),
            BrowserException(BrowserException.Kind.Malformed) to (400 to "request_invalid"),
            BrowserException(BrowserException.Kind.TooLarge) to (413 to "request_too_large"),
            BrowserException(BrowserException.Kind.Unavailable) to (503 to "route_unavailable"),
            BrowserException(BrowserException.Kind.Timeout) to (408 to "request_timeout"),
            BrowserException(BrowserException.Kind.Upstream, 403) to (403 to "upstream_refused"),
        )
        for ((error, expected) in cases) {
            val failure = BrowserFailure.of(error)
            assertEquals(expected.first, failure.status)
            assertEquals("browser_proxy_" + expected.second, failure.code)
            assertTrue(failure.bytes.decodeToString().contains("X-Happy-Proxy-Error: " + failure.code))
        }
        assertEquals(504, BrowserFailure.of(BrowserUpstreamException(BrowserException(BrowserException.Kind.Timeout))).status)
        assertEquals(502, BrowserFailure.of(BrowserUpstreamException(java.io.IOException("closed"))).status)
        assertEquals("browser_proxy_upstream_response_invalid", BrowserFailure.of(BrowserUpstreamException(BrowserException(BrowserException.Kind.Malformed))).code)
        assertEquals(500, BrowserFailure.of(IllegalStateException()).status)
    }
}
