package com.slopus.happy.connection

import com.slopus.happy.crypto.CanonicalBase64Url
import com.slopus.happy.crypto.PairingCrypto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Pairing (happy-agent API.md "Mobile connector") against a fake daemon that does its own half. */
class PairingTest {
    private val now = PAIRING_NOW
    private val token = PAIRING_TOKEN
    private fun link(v: Any = 1, p: Any = 24781, t: String = CanonicalBase64Url.encode(token), a: String = "tcFixedVectorAddress", n: String = "Steve's Mac", e: Long = now + 300_000) =
        pairingCode(v = v, a = a, p = p, t = t, n = n, e = e)

    private fun reason(block: () -> Unit): AgentConnectionException.Reason? = try {
        block(); null
    } catch (e: AgentConnectionException) {
        e.reason
    }

    @Test
    fun aLinkParsesAndHidesItsSecrets() {
        val parsed = PairingLink.parse("  ${link()}\n", now)
        assertEquals("tcFixedVectorAddress", parsed.address)
        assertEquals(24781, parsed.port)
        assertArrayEquals(token, parsed.token)
        assertEquals("Steve's Mac", parsed.name)
        assertFalse(parsed.toString().contains("tcFixed"))
    }

    @Test
    fun badLinksSayWhy() {
        val invalid = AgentConnectionException.Reason.InvalidCode
        assertEquals(AgentConnectionException.Reason.UpdateRequired, reason { PairingLink.parse(link(v = 2), now) })
        assertEquals(AgentConnectionException.Reason.Expired, reason { PairingLink.parse(link(e = now), now) })
        assertEquals(invalid, reason { PairingLink.parse(link(v = "1"), now) })
        assertEquals(invalid, reason { PairingLink.parse(link(p = 0), now) })
        assertEquals(invalid, reason { PairingLink.parse(link(p = 70000), now) })
        assertEquals(invalid, reason { PairingLink.parse(link(t = "short"), now) })
        assertEquals(invalid, reason { PairingLink.parse(link(a = ""), now) })
        assertEquals(invalid, reason { PairingLink.parse(link(n = "a\nb"), now) })
        assertEquals(invalid, reason { PairingLink.parse("happy://direct?", now) })
        assertEquals(invalid, reason { PairingLink.parse("happy://direct?e30=", now) })
        assertEquals(invalid, reason { PairingLink.parse("happy://terminal?abc", now) })
    }

    @Test
    fun responsesAreFramedStrictlyAcrossAnyBoundaries() {
        val whole = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n".toByteArray()
        for (split in whole.indices) {
            val parser = HttpResponseParser()
            assertEquals(null, parser.append(whole.copyOf(split), eof = false))
            val response = parser.append(whole.copyOfRange(split, whole.size), eof = false)!!
            assertEquals("{\"a\":1}", response.text)
        }
        val sized = HttpResponseParser().append("HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}extra".toByteArray(), eof = false)!!
        assertEquals(401, sized.status)
        assertEquals("{}", sized.text)
        assertEquals(AgentConnectionException.Reason.InvalidResponse, reason { HttpResponseParser().append("HTTP/1.1 200 OK\r\nX: 1\r\nx: 2\r\n\r\n".toByteArray(), eof = true) })
        assertEquals(AgentConnectionException.Reason.InvalidResponse, reason { HttpResponseParser().append("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab".toByteArray(), eof = true) })
        assertEquals("ab", HttpResponseParser().append("HTTP/1.1 200 OK\r\n\r\nab".toByteArray(), eof = true)!!.text)
    }

    @Test
    fun requestHeadsCannotBeSplit() {
        val head = TailcatHttp.requestHead("POST", "/v0/x", 24781, "tok", "{}".toByteArray(), emptyMap()).toString(Charsets.UTF_8)
        assertEquals(
            "POST /v0/x HTTP/1.1\r\nHost: server.tailcat:24781\r\nAuthorization: Bearer tok\r\nConnection: close\r\n" +
                "Accept: application/json\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n",
            head,
        )
        assertEquals(AgentConnectionException.Reason.InvalidResponse, reason { TailcatHttp.requestHead("GET", "/a b", 1, "t", null, emptyMap()) })
        assertEquals(AgentConnectionException.Reason.InvalidResponse, reason { TailcatHttp.requestHead("GET", "/a", 1, "t\r\nX: y", null, emptyMap()) })
    }

    private fun service(daemon: FakeDaemon) = PairingService(
        PairingLink.parse(link(), now), daemon,
        PairingCrypto(privateKey = ByteArray(32) { 1 }, nonce = ByteArray(32) { 4 }),
        now = { now },
    )

    @Test
    fun aConfirmedPairingYieldsTheDerivedDeviceToken() = runBlocking {
        val daemon = FakeDaemon(desktopConfirmsAfterPolls = 2)
        val pairing = service(daemon)
        // API.md's fixed vectors give these emoji.
        assertEquals(listOf("🌀", "👗", "⏳", "👟"), pairing.start("Pixel 9"))
        val credentials = pairing.confirm()
        assertEquals("dv3n8k1m5q9r2t6w0y4z7a1c", credentials.deviceId)
        assertEquals("tcFixedVectorAddress", credentials.address)
        assertEquals(CanonicalBase64Url.encode(daemon.deviceToken), credentials.deviceToken)
        assertEquals("05bf38156a0b81046b4e15f584760e0e8996efe81239e5efe4560fef29c20aeb",
            com.slopus.happy.crypto.encodeHex(daemon.deviceToken).lowercase())
        assertEquals(2, daemon.calls.count { it.endsWith("?wait=25") })
        assertFalse(credentials.toString().contains(credentials.deviceToken))
    }

    @Test
    fun aDaemonThatCantProveItselfYieldsNothing() = runBlocking {
        val pairing = service(FakeDaemon(badDaemonMac = true))
        pairing.start("Pixel")
        assertEquals(AgentConnectionException.Reason.InvalidProof, try { pairing.confirm(); null } catch (e: AgentConnectionException) { e.reason })
    }

    @Test
    fun cancellingRejectsAndStopsTheHandshake() = runBlocking {
        val daemon = FakeDaemon()
        val pairing = service(daemon)
        pairing.start("Pixel")
        pairing.cancel()
        assertTrue(daemon.rejected)
        try {
            pairing.confirm(); fail()
        } catch (_: CancellationException) {
        }
    }
}
