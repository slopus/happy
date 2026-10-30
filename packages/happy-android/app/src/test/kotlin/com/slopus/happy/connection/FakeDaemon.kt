package com.slopus.happy.connection

import com.slopus.happy.crypto.CanonicalBase64Url
import com.slopus.happy.crypto.Sodium
import com.slopus.happy.crypto.hkdfSha256
import com.slopus.happy.crypto.hmacSha256
import com.slopus.happy.crypto.sha256
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals

/** A fixed time for pairing tests; codes from [pairingCode] expire five minutes after it. */
const val PAIRING_NOW = 1_755_400_000_000L

/** The pairing token in [pairingCode]. */
val PAIRING_TOKEN = ByteArray(32) { 3 }

/** A `happy://direct?` code, with fields that can be made wrong one at a time. */
fun pairingCode(
    v: Any = 1, a: String = "tcFixedVectorAddress", p: Any = 24781, t: String = CanonicalBase64Url.encode(PAIRING_TOKEN),
    n: String = "Steve's Mac", e: Long = PAIRING_NOW + 300_000,
) = PairingLink.bundle(buildJsonObject {
    if (v is Int) put("v", v) else put("v", v.toString())
    put("a", a)
    if (p is Int) put("p", p) else put("p", p.toString())
    put("t", t); put("n", n); put("e", e); put("extra", "ignored")
})

/**
 * The daemon's half of pairing (happy-agent API.md, "Mobile connector"):
 * consumes the token, checks the commitment and the phone's MAC, and proves
 * itself in turn. Once paired it answers health and config for the derived
 * device token, as [agentName], or 401 when [revoked].
 */
class FakeDaemon(
    private val desktopConfirmsAfterPolls: Int = 1,
    private val badDaemonMac: Boolean = false,
    var agentName: String? = "Studio",
    var revoked: Boolean = false,
    val deviceId: String = "dv3n8k1m5q9r2t6w0y4z7a1c",
) : Transport {
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
    var closed = 0

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): TransportResponse {
        calls += "$method $path"
        val json = body?.let { Json.parseToJsonElement(it.toString(Charsets.UTF_8)).jsonObject }
        fun ok(value: JsonObject) = TransportResponse(200, body = value.toString().toByteArray())
        fun status(): TransportResponse {
            val completed = phoneConfirmed && polls >= desktopConfirmsAfterPolls
            return ok(buildJsonObject {
                put("status", if (rejected) "rejected" else if (completed) "completed" else "verifying")
                if (completed) {
                    put("deviceId", deviceId)
                    val role = if (badDaemonMac) "mobile" else "daemon"
                    put("mac", CanonicalBase64Url.encode(hmacSha256(confirmKey, role.toByteArray() + transcript)))
                }
            })
        }
        fun paired(answer: () -> TransportResponse) =
            if (revoked || credential != CanonicalBase64Url.encode(deviceToken)) TransportResponse(401, body = "{}".toByteArray()) else answer()
        return when (path) {
            PairingService.ROUTE -> if (method == "POST") {
                assertEquals(CanonicalBase64Url.encode(PAIRING_TOKEN), credential)
                assertEquals("android", json!!["device"]!!.jsonObject["platform"]!!.jsonPrimitive.content)
                commitment = CanonicalBase64Url.decode(json["commitment"]!!.jsonPrimitive.content)!!
                ok(buildJsonObject {
                    put("handshakeId", handshake); put("publicKey", CanonicalBase64Url.encode(publicKey))
                    put("nonce", CanonicalBase64Url.encode(nonce)); put("expiresAt", PAIRING_NOW + 300_000)
                })
            } else error(path)
            "${PairingService.ROUTE}/reveal" -> {
                assertEquals(handshake, credential)
                val phoneKey = CanonicalBase64Url.decode(json!!["publicKey"]!!.jsonPrimitive.content)!!
                val phoneNonce = CanonicalBase64Url.decode(json["nonce"]!!.jsonPrimitive.content)!!
                assertArrayEquals(commitment, sha256("happy-mobile-pair-v1/commit".toByteArray() + phoneKey + phoneNonce))
                val shared = Sodium.scalarMult(privateKey, phoneKey)!!
                var t = "happy-mobile-pair-v1".toByteArray()
                for (f in listOf(PAIRING_TOKEN, commitment, phoneKey, publicKey, phoneNonce, nonce, "tcFixedVectorAddress".toByteArray(), byteArrayOf(0x60, 0xcd.toByte()))) {
                    t += byteArrayOf(0, 0, (f.size shr 8).toByte(), f.size.toByte()) + f
                }
                transcript = sha256(t)
                confirmKey = hkdfSha256(shared, transcript, "happy-mobile-pair-v1 confirm".toByteArray(), 32)
                deviceToken = hkdfSha256(shared, transcript, "happy-mobile-pair-v1 device-token".toByteArray(), 32)
                status()
            }
            "${PairingService.ROUTE}/confirm" -> {
                val mac = CanonicalBase64Url.decode(json!!["mac"]!!.jsonPrimitive.content)!!
                assertArrayEquals(hmacSha256(confirmKey, "mobile".toByteArray() + transcript), mac)
                phoneConfirmed = true
                status()
            }
            "${PairingService.ROUTE}?wait=25" -> { polls++; status() }
            "${PairingService.ROUTE}/reject" -> { rejected = true; status() }
            "/v0/health" -> paired {
                ok(buildJsonObject {
                    put("ready", true)
                    putJsonObject("version") { put("protocol", 32); put("daemon", "0.4.109") }
                })
            }
            "/v0/config" -> paired {
                ok(buildJsonObject {
                    putJsonObject("config") {
                        agentName?.let { name ->
                            putJsonObject("node") { put("name", name); putJsonObject("avatar") { put("thumbhash", "abc") } }
                        }
                    }
                })
            }
            else -> error(path)
        }
    }

    override suspend fun close() {
        closed++
    }
}
