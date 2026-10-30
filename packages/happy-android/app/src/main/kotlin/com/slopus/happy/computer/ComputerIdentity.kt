package com.slopus.happy.computer

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A paired computer as the phone shows it: its own name and avatar, and how it answers now. */
data class ComputerInfo(
    val name: String,
    val thumbhash: String? = null,
    val daemonVersion: String? = null,
    val protocol: Int? = null,
)

/**
 * Health, then `config.node` (happy-agent API.md, "Node configuration"),
 * with the paired device token. 401 or 403 means the phone was removed on
 * the computer: [ComputerException.Reason.Revoked].
 */
object ComputerIdentity {
    /** The oldest daemon protocol the phone talks to. */
    const val MIN_PROTOCOL = 27

    @Serializable private class Version(val protocol: Int, val daemon: String? = null)
    @Serializable private class Health(val ready: Boolean, val version: Version)
    @Serializable private class Avatar(val thumbhash: String? = null)
    @Serializable private class Node(val name: String, val avatar: Avatar? = null)
    @Serializable private class Config(val node: Node? = null)
    @Serializable private class ConfigResponse(val config: Config)

    private val json = Json { ignoreUnknownKeys = true }

    suspend fun refresh(transport: Transport, token: String, fallbackName: String): ComputerInfo {
        val health = json.decodeOrInvalid<Health>(check(transport.request("GET", "/v0/health", token)))
        if (health.version.protocol < MIN_PROTOCOL) throw ComputerException(ComputerException.Reason.UpdateRequired)
        if (!health.ready) throw ComputerException(ComputerException.Reason.Unavailable)
        val node = json.decodeOrInvalid<ConfigResponse>(check(transport.request("GET", "/v0/config", token))).config.node
        val name = node?.name?.takeIf { it.isNotEmpty() && it.codePointCount(0, it.length) <= 128 && it.none(Char::isISOControl) }
        if (node != null && name == null) throw ComputerException(ComputerException.Reason.InvalidResponse)
        return ComputerInfo(
            name = name ?: fallbackName,
            thumbhash = node?.avatar?.thumbhash,
            daemonVersion = health.version.daemon,
            protocol = health.version.protocol,
        )
    }

    private fun check(response: TransportResponse): TransportResponse {
        if (response.status == 401 || response.status == 403) throw ComputerException(ComputerException.Reason.Revoked)
        if (response.status != 200) throw ComputerException(ComputerException.Reason.Unavailable)
        return response
    }

    private inline fun <reified T> Json.decodeOrInvalid(response: TransportResponse): T = try {
        decodeFromString<T>(response.text)
    } catch (_: Exception) {
        throw ComputerException(ComputerException.Reason.InvalidResponse)
    }
}
