package com.slopus.happy.connection

import com.slopus.happy.crypto.CanonicalBase64Url
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject

/** Why pairing or a paired agent failed, in words the person can act on. */
class AgentConnectionException(val reason: Reason) : Exception(reason.message) {
    enum class Reason(val message: String) {
        InvalidCode("This code is invalid. Generate a new one in Happy Agent."),
        UpdateRequired("Update Happy to use this code."),
        Expired("This code has expired. Generate a new one in Happy Agent."),
        Rejected("The connection was rejected. Generate a new code and compare the emoji again."),
        InvalidProof("The agent could not be verified. Generate a new code."),
        InvalidResponse("The agent returned an invalid response."),
        Unavailable("Could not reach the agent. Check its connection and try again."),
        Revoked("This device is no longer authorized. Connect the agent again."),
    }
}

/**
 * A Happy Protocol V2 pairing code (happy-agent API.md, "The QR code"):
 * `happy://direct?<base64url(JSON {v, a, p, t, n, e})>`. The address `a` and
 * token `t` are secrets; [toString] leaves them out.
 */
class PairingLink private constructor(
    val address: String,
    val port: Int,
    val token: ByteArray,
    /** The agent's name as the code states it: for display only, unverified. */
    val name: String,
    val expiresAtMillis: Long,
) {
    override fun toString() = "PairingLink(name=$name, port=$port)"

    companion object {
        const val PREFIX = "happy://direct?"

        /** Throws [AgentConnectionException]: InvalidCode, UpdateRequired or Expired. */
        fun parse(raw: String, nowMillis: Long = System.currentTimeMillis()): PairingLink {
            val text = raw.trim()
            fun invalid(): Nothing = throw AgentConnectionException(AgentConnectionException.Reason.InvalidCode)
            if (!text.startsWith(PREFIX) || text.length > 16384) invalid()
            val bytes = CanonicalBase64Url.decode(text.removePrefix(PREFIX)) ?: invalid()
            val bundle = try {
                Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
            } catch (_: Exception) {
                invalid()
            }
            fun number(key: String) = (bundle[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            fun string(key: String) = (bundle[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            val version = number("v") ?: invalid()
            if (version != 1.0) throw AgentConnectionException(AgentConnectionException.Reason.UpdateRequired)
            val address = string("a")?.takeIf { it.isNotEmpty() && it.length <= 8192 && it.none(Char::isISOControl) } ?: invalid()
            val port = number("p")?.takeIf { it == Math.floor(it) && it in 1.0..65535.0 }?.toInt() ?: invalid()
            val token = string("t")?.let(CanonicalBase64Url::decode)?.takeIf { it.size == 32 } ?: invalid()
            val name = string("n")?.takeIf { it.isNotEmpty() && it.codePointCount(0, it.length) <= 128 && it.none(Char::isISOControl) } ?: invalid()
            val expires = number("e")?.takeIf { it.isFinite() && it > 0 } ?: invalid()
            if (expires.toLong() <= nowMillis) throw AgentConnectionException(AgentConnectionException.Reason.Expired)
            return PairingLink(address, port, token, name, expires.toLong())
        }

        internal fun bundle(json: JsonObject) = PREFIX + CanonicalBase64Url.encode(json.toString().toByteArray(Charsets.UTF_8))
    }
}
