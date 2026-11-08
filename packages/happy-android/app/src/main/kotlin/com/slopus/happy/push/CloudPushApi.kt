package com.slopus.happy.push

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.util.UUID

@Serializable
data class CloudPushRegistration(val id: String, val version: String, val expiresAt: Long)

/** Explicit agent notifications have only a per-member/server master switch. */
@Serializable
data class CloudPushSettings(val enabled: Boolean)

class CloudPushException(val status: Int? = null) : IOException("Cloud push request failed")

/** Per-server API; authority comes only from the client's bearer, never a supplied member/tenant. */
class CloudPushApi(private val client: AgentClient) {
    init { require(client.cloud) }

    suspend fun register(id: String, token: HappyPushToken, appId: String, locale: String?): CloudPushRegistration {
        require(appId in APP_IDS)
        val body = buildJsonObject {
            put("token", token.value)
            put("platform", "android")
            put("appId", appId)
            locale?.let { require(it.length <= 64 && it.all { c -> !c.isISOControl() }); put("locale", it) }
        }
        val response = request("PUT", path(id), body)
        return decode {
            val root = Json.parseToJsonElement(response.text) as JsonObject
            val registration = Json.decodeFromJsonElement(CloudPushRegistration.serializer(), root.getValue("registration"))
            require(registration.id == id && registration.expiresAt > 0)
            uuid(registration.version)
            registration
        }
    }

    suspend fun unregister(registration: CloudPushRegistration) {
        request("DELETE", path(registration.id), headers = version(registration))
    }

    suspend fun settings(): CloudPushSettings = readSettings(request("GET", "$ROOT/settings"))

    suspend fun settings(value: CloudPushSettings): CloudPushSettings = readSettings(request(
        "PUT", "$ROOT/settings", Json.encodeToJsonElement(CloudPushSettings.serializer(), value) as JsonObject,
    ))

    private fun readSettings(response: TransportResponse): CloudPushSettings = decode {
        Json.decodeFromString(CloudPushSettings.serializer(), response.text)
    }

    private suspend fun request(method: String, path: String, body: JsonObject? = null, headers: Map<String, String> = emptyMap()): TransportResponse = try {
        client.send(method, path, body, headers)
    } catch (e: CancellationException) {
        throw e
    } catch (e: AgentApiException) {
        // Preserve only the status needed for stale-version handling, never an echoed capability.
        throw CloudPushException(e.status)
    } catch (_: Exception) {
        throw CloudPushException()
    }

    private fun <T> decode(read: () -> T): T = try { read() } catch (_: Exception) { throw CloudPushException() }
    private fun path(id: String) = "$ROOT/registrations/${uuid(id)}"
    private fun version(registration: CloudPushRegistration) = mapOf("If-Match" to uuid(registration.version))

    companion object {
        private const val ROOT = "/v0/cloud/push"
        val APP_IDS = setOf("com.slopus.happy.dev", "com.slopus.happy.preview", "com.ex3ndr.happy")
        private fun uuid(value: String): String = UUID.fromString(value).toString().also { require(it == value) }
    }
}