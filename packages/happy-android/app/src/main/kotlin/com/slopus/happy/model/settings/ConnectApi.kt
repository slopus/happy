package com.slopus.happy.model.settings

import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HappyJson
import com.slopus.happy.net.HttpStatusException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A failed connect call, with the server's message where it gave one. */
class ConnectException(message: String) : Exception(message)

/**
 * Connected accounts: happy-app sync/apiGithub.ts and sync/apiServices.ts.
 * Every call needs a signed-in account.
 */
interface ConnectApi {
    /** getGitHubOAuthParams: the URL that starts GitHub's OAuth flow. */
    suspend fun gitHubOAuthUrl(): String

    /** disconnectGitHub. */
    suspend fun disconnectGitHub()

    /** connectService: registers [token] (sent as its JSON text) for [service]. */
    suspend fun connectService(service: String, token: JsonElement)

    /** disconnectService (`anthropic` for Claude Code). */
    suspend fun disconnectService(service: String)
}

@Serializable private data class OAuthParams(val url: String)
@Serializable private data class Success(val success: Boolean = false)
@Serializable private data class RegisterBody(val token: String)

/** [ConnectApi] over [HappyHttp] with the account's [token]. */
class HttpConnectApi(private val http: HappyHttp, private val token: () -> String?) : ConnectApi {
    private fun bearer() = token() ?: throw ConnectException("Not signed in")

    override suspend fun gitHubOAuthUrl(): String = try {
        HappyJson.decodeFromString(OAuthParams.serializer(), http.send("GET", "/v1/connect/github/params", bearer())).url
    } catch (e: HttpStatusException) {
        throw if (e.status == 400) ConnectException(errorOf(e) ?: "GitHub OAuth not configured") else ConnectException("Failed to get GitHub OAuth params: ${e.status}")
    }

    override suspend fun disconnectGitHub() = disconnect("/v1/connect/github", "GitHub account not connected", "GitHub")

    override suspend fun disconnectService(service: String) = disconnect("/v1/connect/$service", "$service account not connected", service)

    override suspend fun connectService(service: String, token: JsonElement) {
        val result = try {
            val body = HappyJson.encodeToString(RegisterBody.serializer(), RegisterBody(token.toString()))
            HappyJson.decodeFromString(Success.serializer(), http.send("POST", "/v1/connect/$service/register", bearer(), body))
        } catch (e: HttpStatusException) {
            throw ConnectException("Failed to connect $service: ${e.status}")
        }
        if (!result.success) throw ConnectException("Failed to connect $service account")
    }

    private suspend fun disconnect(path: String, notConnected: String, name: String) {
        val result = try {
            HappyJson.decodeFromString(Success.serializer(), http.send("DELETE", path, bearer()))
        } catch (e: HttpStatusException) {
            throw if (e.status == 404) ConnectException(errorOf(e) ?: notConnected) else ConnectException("Failed to disconnect $name: ${e.status}")
        }
        if (!result.success) throw ConnectException("Failed to disconnect $name account")
    }

    private fun errorOf(e: HttpStatusException): String? = try {
        (HappyJson.parseToJsonElement(e.body) as? JsonObject)?.get("error")?.jsonPrimitive?.content
    } catch (_: Exception) {
        null
    }
}
