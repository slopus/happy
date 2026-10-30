package com.slopus.happy.protocolv2

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A paired computer as the phone shows it: its own name and avatar, and how it answers now. */
data class ProtocolV2Computer(
    val name: String,
    val thumbhash: String? = null,
    val daemonVersion: String? = null,
    val protocol: Int? = null,
)

/**
 * Health, then `config.node` (happy-agent API.md, "Node configuration"),
 * with the paired device token. 401 or 403 means the phone was removed on
 * the computer: [ProtocolV2Exception.Reason.Revoked].
 */
object ProtocolV2Identity {
    /** The oldest daemon protocol the phone talks to. */
    const val MIN_PROTOCOL = 27

    @Serializable private class Version(val protocol: Int, val daemon: String? = null)
    @Serializable private class Health(val ready: Boolean, val version: Version)
    @Serializable private class Avatar(val thumbhash: String? = null)
    @Serializable private class Node(val name: String, val avatar: Avatar? = null)
    @Serializable private class Config(val node: Node? = null)
    @Serializable private class ConfigResponse(val config: Config)

    private val json = Json { ignoreUnknownKeys = true }

    suspend fun refresh(transport: ProtocolV2Transport, token: String, fallbackName: String): ProtocolV2Computer {
        val health = json.decodeOrInvalid<Health>(check(transport.request("GET", "/v0/health", token)))
        if (health.version.protocol < MIN_PROTOCOL) throw ProtocolV2Exception(ProtocolV2Exception.Reason.UpdateRequired)
        if (!health.ready) throw ProtocolV2Exception(ProtocolV2Exception.Reason.Unavailable)
        val node = json.decodeOrInvalid<ConfigResponse>(check(transport.request("GET", "/v0/config", token))).config.node
        val name = node?.name?.takeIf { it.isNotEmpty() && it.codePointCount(0, it.length) <= 128 && it.none(Char::isISOControl) }
        if (node != null && name == null) throw ProtocolV2Exception(ProtocolV2Exception.Reason.InvalidResponse)
        return ProtocolV2Computer(
            name = name ?: fallbackName,
            thumbhash = node?.avatar?.thumbhash,
            daemonVersion = health.version.daemon,
            protocol = health.version.protocol,
        )
    }

    private fun check(response: ProtocolV2Response): ProtocolV2Response {
        if (response.status == 401 || response.status == 403) throw ProtocolV2Exception(ProtocolV2Exception.Reason.Revoked)
        if (response.status != 200) throw ProtocolV2Exception(ProtocolV2Exception.Reason.Unavailable)
        return response
    }

    private inline fun <reified T> Json.decodeOrInvalid(response: ProtocolV2Response): T = try {
        decodeFromString<T>(response.text)
    } catch (_: Exception) {
        throw ProtocolV2Exception(ProtocolV2Exception.Reason.InvalidResponse)
    }
}
