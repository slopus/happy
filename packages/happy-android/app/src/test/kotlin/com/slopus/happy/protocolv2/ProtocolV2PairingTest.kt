package com.slopus.happy.protocolv2

import com.slopus.happy.crypto.CanonicalBase64Url
import com.slopus.happy.crypto.ProtocolV2PairingCrypto
import com.slopus.happy.crypto.Sodium
import com.slopus.happy.crypto.hkdfSha256
import com.slopus.happy.crypto.hmacSha256
import com.slopus.happy.crypto.sha256
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Pairing (happy-agent API.md "Mobile connector") against a fake daemon that does its own half. */
class ProtocolV2PairingTest {
    private val now = 1_755_400_000_000L
    private val token = ByteArray(32) { 3 }

    private fun link(
        v: Any = 1, a: String = "tcFixedVectorAddress", p: Any = 24781, t: String = CanonicalBase64Url.encode(token),
        n: String = "Steve's Mac", e: Long = now + 300_000,
    ) = ProtocolV2PairingLink.bundle(buildJsonObject {
        if (v is Int) put("v", v) else put("v", v.toString())
        put("a", a)
        if (p is Int) put("p", p) else put("p", p.toString())
        put("t", t); put("n", n); put("e", e); put("extra", "ignored")
    })

    private fun reason(block: () -> Unit): ProtocolV2Exception.Reason? = try {
        block(); null
    } catch (e: ProtocolV2Exception) {
        e.reason
    }

    @Test
    fun aLinkParsesAndHidesItsSecrets() {
        val parsed = ProtocolV2PairingLink.parse("  ${link()}\n", now)
        assertEquals("tcFixedVectorAddress", parsed.address)
        assertEquals(24781, parsed.port)
        assertArrayEquals(token, parsed.token)
        assertEquals("Steve's Mac", parsed.name)
        assertFalse(parsed.toString().contains("tcFixed"))
    }

    @Test
    fun badLinksSayWhy() {
        val invalid = ProtocolV2Exception.Reason.InvalidCode
        assertEquals(ProtocolV2Exception.Reason.UpdateRequired, reason { ProtocolV2PairingLink.parse(link(v = 2), now) })
        assertEquals(ProtocolV2Exception.Reason.Expired, reason { ProtocolV2PairingLink.parse(link(e = now), now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse(link(v = "1"), now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse(link(p = 0), now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse(link(p = 70000), now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse(link(t = "short"), now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse(link(a = ""), now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse(link(n = "a\nb"), now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse("happy://direct?", now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse("happy://direct?e30=", now) })
        assertEquals(invalid, reason { ProtocolV2PairingLink.parse("happy://terminal?abc", now) })
    }

    @Test
    fun responsesAreFramedStrictlyAcrossAnyBoundaries() {
        val whole = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n".toByteArray()
        for (split in whole.indices) {
            val parser = ProtocolV2HttpParser()
            assertEquals(null, parser.append(whole.copyOf(split), eof = false))
            val response = parser.append(whole.copyOfRange(split, whole.size), eof = false)!!
            assertEquals("{\"a\":1}", response.text)
        }
        val sized = ProtocolV2HttpParser().append("HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}extra".toByteArray(), eof = false)!!
        assertEquals(401, sized.status)
        assertEquals("{}", sized.text)
        assertEquals(ProtocolV2Exception.Reason.InvalidResponse, reason { ProtocolV2HttpParser().append("HTTP/1.1 200 OK\r\nX: 1\r\nx: 2\r\n\r\n".toByteArray(), eof = true) })
        assertEquals(ProtocolV2Exception.Reason.InvalidResponse, reason { ProtocolV2HttpParser().append("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab".toByteArray(), eof = true) })
        assertEquals("ab", ProtocolV2HttpParser().append("HTTP/1.1 200 OK\r\n\r\nab".toByteArray(), eof = true)!!.text)
    }

    @Test
    fun requestHeadsCannotBeSplit() {
        val head = ProtocolV2Http.requestHead("POST", "/v0/x", 24781, "tok", "{}".toByteArray(), emptyMap()).toString(Charsets.UTF_8)
        assertEquals(
            "POST /v0/x HTTP/1.1\r\nHost: server.tailcat:24781\r\nAuthorization: Bearer tok\r\nConnection: close\r\n" +
                "Accept: application/json\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n",
            head,
        )
        assertEquals(ProtocolV2Exception.Reason.InvalidResponse, reason { ProtocolV2Http.requestHead("GET", "/a b", 1, "t", null, emptyMap()) })
        assertEquals(ProtocolV2Exception.Reason.InvalidResponse, reason { ProtocolV2Http.requestHead("GET", "/a", 1, "t\r\nX: y", null, emptyMap()) })
    }

    /** The daemon's half, from API.md: consumes the token, checks the commitment and the phone's MAC. */
    private inner class FakeDaemon(
        private val desktopConfirmsAfterPolls: Int = 1,
        private val badDaemonMac: Boolean = false,
    ) : ProtocolV2Transport {
        val calls = mutableListOf<String>()
        private val privateKey = ByteArray(32) { 2 }
        private val publicKey = Sodium.scalarMultBase(privateKey)
        private val nonce = ByteArray(32) { 5 }
        private val handshake = CanonicalBase64Url.encode(ByteArray(32) { 9 })
        private var commitment = ByteArray(0)
        private var confirmKey = ByteArray(0)
        private var transcript = ByteArray(0)
        var deviceToken = ByteArray(0)
        private var phoneConfirmed = false
        private var polls = 0
        var rejected = false

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): ProtocolV2Response {
            calls += "$method $path"
            val json = body?.let { Json.parseToJsonElement(it.toString(Charsets.UTF_8)).jsonObject }
            fun ok(value: JsonObject) = ProtocolV2Response(200, body = value.toString().toByteArray())
            fun status(): ProtocolV2Response {
                val completed = phoneConfirmed && polls >= desktopConfirmsAfterPolls
                return ok(buildJsonObject {
                    put("status", if (rejected) "rejected" else if (completed) "completed" else "verifying")
                    if (completed) {
                        put("deviceId", "dv3n8k1m5q9r2t6w0y4z7a1c")
                        val role = if (badDaemonMac) "mobile" else "daemon"
                        put("mac", CanonicalBase64Url.encode(hmacSha256(confirmKey, role.toByteArray() + transcript)))
                    }
                })
            }
            return when (path) {
                ProtocolV2PairingService.ROUTE -> if (method == "POST") {
                    assertEquals(CanonicalBase64Url.encode(token), credential)
                    assertEquals("android", json!!["device"]!!.jsonObject["platform"]!!.jsonPrimitive.content)
                    commitment = CanonicalBase64Url.decode(json["commitment"]!!.jsonPrimitive.content)!!
                    ok(buildJsonObject {
                        put("handshakeId", handshake); put("publicKey", CanonicalBase64Url.encode(publicKey))
                        put("nonce", CanonicalBase64Url.encode(nonce)); put("expiresAt", now + 300_000)
                    })
                } else error(path)
                "${ProtocolV2PairingService.ROUTE}/reveal" -> {
                    assertEquals(handshake, credential)
                    val phoneKey = CanonicalBase64Url.decode(json!!["publicKey"]!!.jsonPrimitive.content)!!
                    val phoneNonce = CanonicalBase64Url.decode(json["nonce"]!!.jsonPrimitive.content)!!
                    assertArrayEquals(commitment, sha256("happy-mobile-pair-v1/commit".toByteArray() + phoneKey + phoneNonce))
                    val shared = Sodium.scalarMult(privateKey, phoneKey)!!
                    var t = "happy-mobile-pair-v1".toByteArray()
                    for (f in listOf(token, commitment, phoneKey, publicKey, phoneNonce, nonce, "tcFixedVectorAddress".toByteArray(), byteArrayOf(0x60, 0xcd.toByte()))) {
                        t += byteArrayOf(0, 0, (f.size shr 8).toByte(), f.size.toByte()) + f
                    }
                    transcript = sha256(t)
                    confirmKey = hkdfSha256(shared, transcript, "happy-mobile-pair-v1 confirm".toByteArray(), 32)
                    deviceToken = hkdfSha256(shared, transcript, "happy-mobile-pair-v1 device-token".toByteArray(), 32)
                    status()
                }
                "${ProtocolV2PairingService.ROUTE}/confirm" -> {
                    val mac = CanonicalBase64Url.decode(json!!["mac"]!!.jsonPrimitive.content)!!
                    assertArrayEquals(hmacSha256(confirmKey, "mobile".toByteArray() + transcript), mac)
                    phoneConfirmed = true
                    status()
                }
                "${ProtocolV2PairingService.ROUTE}?wait=25" -> { polls++; status() }
                "${ProtocolV2PairingService.ROUTE}/reject" -> { rejected = true; status() }
                else -> error(path)
            }
        }

        override suspend fun close() {}
    }

    private fun service(daemon: FakeDaemon) = ProtocolV2PairingService(
        ProtocolV2PairingLink.parse(link(), now), daemon,
        ProtocolV2PairingCrypto(privateKey = ByteArray(32) { 1 }, nonce = ByteArray(32) { 4 }),
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
        assertEquals(ProtocolV2Exception.Reason.InvalidProof, try { pairing.confirm(); null } catch (e: ProtocolV2Exception) { e.reason })
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
