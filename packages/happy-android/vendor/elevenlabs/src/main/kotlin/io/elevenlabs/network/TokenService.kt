package io.elevenlabs.network

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/**
 * Service for fetching conversation tokens from ElevenLabs API
 *
 * This service handles authentication with the ElevenLabs API to obtain
 * conversation tokens for private agents and connection details.
 */
class TokenService(
    private val baseUrl: String = "https://api.elevenlabs.io",
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val gson: Gson = Gson()
) {

    /**
     * Fetch a conversation token for a public agent (no API key required)
     *
     * @param agentId The ID of the public agent to get a token for
     * @param source Optional source identifier (defaults to "android_sdk")
     * @param version Optional version string (defaults to SDK version)
     * @param environment Optional environment name (defaults to "production" on the server)
     * @return TokenResponse containing the token and connection details
     * @throws TokenServiceException if the request fails or returns an error
     */
    suspend fun fetchPublicAgentToken(agentId: String, source: String, version: String, environment: String? = null): TokenResponse = withContext(Dispatchers.IO) {
        val url = buildTokenUrl(agentId, source, version, environment)

        val request = Request.Builder()
            .url(url)
            .addHeader("Accept", "application/json")
            .get()
            .build()

        try {
            val response = httpClient.newCall(request).execute()

            if (!response.isSuccessful) {
                val errorBody = response.body?.string() ?: "Unknown error"
                throw TokenServiceException(
                    "Failed to fetch public agent token: HTTP ${response.code} - $errorBody"
                )
            }

            val responseBody = response.body?.string()
                ?: throw TokenServiceException("Empty response body")

            try {
                val parsed = gson.fromJson(responseBody, TokenResponse::class.java)
                    ?: throw TokenServiceException("Failed to parse token response")
                parsed
            } catch (e: Exception) {
                throw TokenServiceException("Failed to parse token response: ${e.message}", e)
            }

        } catch (e: IOException) {
            throw TokenServiceException("Network error: ${e.message}", e)
        }
    }

    /**
     * Build the URL for fetching conversation tokens
     *
     * @param agentId The agent ID to include in the request
     * @param environment Optional environment name
     * @return Complete URL for the token request
     */
    private fun buildTokenUrl(agentId: String, source: String, version: String, environment: String? = null): String {
        var url = "$baseUrl/v1/convai/conversation/token?agent_id=$agentId&source=$source&version=$version"
        environment?.let { url += "&environment=$it" }
        return url
    }
}

/**
 * Response from the ElevenLabs token API
 *
 * @param token The conversation token to use for authentication
 */
data class TokenResponse(
    @SerializedName("token")
    val token: String,
)

/**
 * Exception thrown when token service operations fail
 */
class TokenServiceException(
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)