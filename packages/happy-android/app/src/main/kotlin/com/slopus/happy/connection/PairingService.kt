package com.slopus.happy.connection

import com.slopus.happy.crypto.CanonicalBase64Url
import com.slopus.happy.crypto.PairingCrypto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** What a paired phone keeps to reach its agent. Every field is a secret but [deviceId]. */
@Serializable
data class AgentConnectionCredentials(
    val address: String,
    val port: Int,
    val deviceId: String,
    val deviceToken: String,
) {
    override fun toString() = "AgentConnectionCredentials(deviceId=$deviceId, port=$port)"
}

/**
 * The phone's side of pairing (happy-agent API.md, "Pairing"): commit,
 * reveal, then both people compare the emoji; [confirm] waits for the
 * desktop's confirmation and checks the daemon's MAC before anything is
 * kept. An unfinished pairing stores nothing; [cancel] rejects it.
 */
class PairingService(
    private val link: PairingLink,
    private val transport: Transport,
    private val crypto: PairingCrypto = PairingCrypto(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var handshakeId: String? = null
    private var secrets: PairingCrypto.Secrets? = null
    private var expiresAt = link.expiresAtMillis
    @Volatile private var cancelled = false

    @Serializable
    private class Started(val handshakeId: String, val publicKey: String, val nonce: String, val expiresAt: Double)

    @Serializable
    private class Status(val status: String, val deviceId: String? = null, val mac: String? = null) {
        fun check() = when (status) {
            "verifying", "completed" -> Unit
            "expired" -> throw AgentConnectionException(AgentConnectionException.Reason.Expired)
            "rejected" -> throw AgentConnectionException(AgentConnectionException.Reason.Rejected)
            else -> throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        }
    }

    /** Starts the handshake and returns the four emoji to compare with the agent's. */
    suspend fun start(deviceName: String): List<String> {
        checkActive()
        val name = deviceName.filterNot(Char::isISOControl).take(128).ifEmpty { "Android" }
        val body = buildJsonObject {
            put("commitment", CanonicalBase64Url.encode(crypto.commitment))
            putJsonObject("device") { put("name", name); put("platform", "android") }
        }
        val started: Started = decode(transport.request("POST", ROUTE, CanonicalBase64Url.encode(link.token), body.bytes()))
        val key = CanonicalBase64Url.decode(started.publicKey)?.takeIf { it.size == 32 }
        val nonce = CanonicalBase64Url.decode(started.nonce)?.takeIf { it.size == 32 }
        if (CanonicalBase64Url.decode(started.handshakeId)?.size != 32 || key == null || nonce == null || !started.expiresAt.isFinite()) {
            throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        }
        // Kept even if cancelled meanwhile, so cancel can reject a handshake whose token was used.
        handshakeId = started.handshakeId
        expiresAt = minOf(link.expiresAtMillis, started.expiresAt.toLong())
        checkActive()
        val derived = crypto.derive(key, nonce, link.token, link.address, link.port)
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        val reveal = buildJsonObject {
            put("publicKey", CanonicalBase64Url.encode(crypto.publicKey))
            put("nonce", CanonicalBase64Url.encode(crypto.nonce))
        }
        val status: Status = decode(transport.request("POST", "$ROUTE/reveal", started.handshakeId, reveal.bytes()))
        checkActive()
        status.check()
        if (status.status != "verifying") throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        secrets = derived
        return derived.emoji
    }

    /** The person says the emoji match. Returns once the agent has confirmed too. */
    suspend fun confirm(): AgentConnectionCredentials {
        checkActive()
        val id = handshakeId ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        val derived = secrets ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        val body = buildJsonObject { put("mac", CanonicalBase64Url.encode(derived.mac("mobile"))) }
        var status: Status = decode(transport.request("POST", "$ROUTE/confirm", id, body.bytes()))
        while (true) {
            checkActive()
            status.check()
            if (status.status == "completed") {
                val deviceId = status.deviceId?.takeIf { it.isNotEmpty() && it.length <= 128 }
                val mac = status.mac?.let(CanonicalBase64Url::decode)
                if (deviceId == null || mac == null || !derived.verifyDaemon(mac)) {
                    throw AgentConnectionException(AgentConnectionException.Reason.InvalidProof)
                }
                secrets = null
                return AgentConnectionCredentials(link.address, link.port, deviceId, CanonicalBase64Url.encode(derived.deviceToken))
            }
            status = decode(transport.request("GET", "$ROUTE?wait=25", id))
        }
    }

    /** The emoji don't match, or the person gave up: rejected at best effort, within 2 seconds. */
    suspend fun cancel() {
        if (cancelled) return
        cancelled = true
        secrets = null
        val id = handshakeId ?: return
        withContext(NonCancellable) {
            withTimeoutOrNull(2_000) {
                try {
                    transport.request("POST", "$ROUTE/reject", id)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun checkActive() {
        if (cancelled) throw CancellationException("Pairing cancelled")
        if (expiresAt <= now()) throw AgentConnectionException(AgentConnectionException.Reason.Expired)
    }

    private inline fun <reified T> decode(response: TransportResponse): T {
        // A handshake the daemon no longer knows answers 401: treated as expired.
        if (response.status == 401) throw AgentConnectionException(AgentConnectionException.Reason.Expired)
        if (response.status != 200) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        return try {
            json.decodeFromString<T>(response.text)
        } catch (_: Exception) {
            throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        }
    }

    private fun kotlinx.serialization.json.JsonObject.bytes() = toString().toByteArray(Charsets.UTF_8)

    companion object {
        const val ROUTE = "/v0/mobile-connector/handshake"
        private val json = Json { ignoreUnknownKeys = true }
    }
}
