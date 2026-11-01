package com.slopus.happy.connection

import com.slopus.happy.crypto.CanonicalBase64Url
import com.slopus.happy.crypto.PairingCrypto
import com.slopus.happy.crypto.encodeHex
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class AgentOriginTest {
    @Test fun canonicalOriginsBecomeTheExactTranscriptAddress() {
        for ((value, port) in listOf("https://agent.example.com" to 443, "https://agent.example.com:8443" to 8443, "https://[2001:db8::1]:8443" to 8443)) {
            val link = PairingLink.parse(PairingLink.bundle(buildJsonObject {
                put("v", 2); put("u", value); put("t", CanonicalBase64Url.encode(ByteArray(32) { 3 }))
                put("n", "Mac"); put("e", 2_000_000_000_000L)
            }))
            assertEquals(value, link.address)
            assertEquals(value, link.publicUrl)
            assertEquals(port, link.port)
            assertTrue(agentTransport(link.address, link.port, link.publicUrl) is HttpsTransport)
        }
        assertTrue(agentTransport("tcAddress", 24781, null) is TailcatTransport)
    }

    @Test fun unsafeAndNoncanonicalOriginsAreRefused() {
        for (value in listOf("https://127.1", "https://0177.0.0.1", "https://0x7f000001", "https://[2001:0db8::1]", "https://[2001:db8:0:0:0:0:0:1]")) {
            assertThrows(value, AgentConnectionException::class.java) { AgentOrigin.parse(value) }
        }
        for (value in listOf("http://agent.example.com", "HTTPS://agent.example.com", "https://AGENT.example.com", "https://agent.example.com:443", "https://agent.example.com/", "https://agent.example.com/path", "https://agent.example.com?", "https://agent.example.com#", "https://user:pass@agent.example.com", "https://agent.example.com:0", "https://agent.example.com:65536", "https://agent.example.com:08443", "https://agent.example.com\n", " https://agent.example.com", "https://agent.example.com\\evil", "https://%61gent.example.com")) {
            assertThrows(value, AgentConnectionException::class.java) { AgentOrigin.parse(value) }
        }
    }

    @Test fun credentialsRetainTransportAcrossRelaunchAndOldEntriesRemainTailcat() {
        val credentials = AgentConnectionCredentials("https://agent.example.com:8443", 8443, "device", "token", "https://agent.example.com:8443")
        assertEquals(credentials, Json.decodeFromString<AgentConnectionCredentials>(Json.encodeToString(AgentConnectionCredentials.serializer(), credentials)))
        val old = Json.decodeFromString<AgentConnectionCredentials>("""{"address":"tcAddress","port":24781,"deviceId":"device","deviceToken":"token"}""")
        assertNull(old.publicUrl)
    }

    @Test fun publicRequestUsesOriginHostAndNeverFollowsRedirects() {
        val head = TailcatHttp.requestHead("GET", "/v0/health", 8443, "device-token", null, emptyMap(), "agent.example.com:8443").decodeToString()
        assertTrue(head.contains("Host: agent.example.com:8443\r\n"))
        assertTrue(head.contains("Authorization: Bearer device-token\r\n"))
        val response = HttpResponseParser().append("HTTP/1.1 302 Found\r\nLocation: http://elsewhere/\r\nContent-Length: 0\r\n\r\n".toByteArray(), false)!!
        assertEquals(302, response.status)
    }

    @Test fun publicPairingMatchesIndependentDaemonVectorAndKeepsOrigin() = runBlocking {
        val origin = "https://agent.example.com:8443"
        val link = PairingLink.parse(PairingLink.bundle(buildJsonObject {
            put("v", 2); put("u", origin); put("t", CanonicalBase64Url.encode(PAIRING_TOKEN))
            put("n", "Mac"); put("e", PAIRING_NOW + 300_000)
        }), PAIRING_NOW)
        val daemon = FakeDaemon(address = origin, port = 8443)
        val service = PairingService(link, daemon, PairingCrypto(privateKey = ByteArray(32) { 1 }, nonce = ByteArray(32) { 4 }), now = { PAIRING_NOW })
        assertEquals(listOf("🇨🇳", "✉️", "🚠", "🍼"), service.start("Phone"))
        val credentials = service.confirm()
        assertEquals(origin, credentials.publicUrl)
        assertEquals(false, credentials.tailcatAvailable)
        assertEquals(origin, credentials.address)
        assertEquals(8443, credentials.port)
        assertEquals("a175d3b4fea158aade7d1becf944f3d5eed2e62d7e73cbdcc4aec5e0a93a58a8", encodeHex(CanonicalBase64Url.decode(credentials.deviceToken)!!).lowercase())
    }
}