package com.slopus.happy.voice

import com.slopus.happy.auth.AuthApi
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.crypto.AuthChallenge
import com.slopus.happy.net.HappyHttp
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient

sealed interface VoiceCredentials {
    data class Granted(val conversationToken: String, val conversationId: String, val agentId: String, val userId: String) : VoiceCredentials
    data class Denied(val reason: String) : VoiceCredentials
}

interface VoiceService {
    suspend fun credentials(credentials: AuthCredentials): VoiceCredentials
    suspend fun usage(credentials: AuthCredentials): VoiceUsage
}

/** apiVoice.ts: re-authenticate with the account secret when voice uses a different server. */
class VoiceApi(
    private val client: OkHttpClient,
    private val clientId: String,
    private val serverUrl: () -> String,
    private val voiceServerUrl: () -> String,
    private val agentId: String,
) : VoiceService {
    private suspend fun endpoint(credentials: AuthCredentials): Pair<HappyHttp, String> {
        val url = voiceServerUrl()
        val http = HappyHttp(client, { url }, clientId)
        val token = if (url == serverUrl()) credentials.token
            else AuthApi(http).getToken(AuthChallenge.create(credentials.secretBytes()))
        return http to token
    }

    override suspend fun credentials(credentials: AuthCredentials): VoiceCredentials {
        require(agentId.isNotEmpty())
        val (http, token) = endpoint(credentials)
        return parseCredentials(http.send("POST", "/v1/voice/conversations", token,
            Json.encodeToString(AgentRequest.serializer(), AgentRequest(agentId))))
    }

    override suspend fun usage(credentials: AuthCredentials): VoiceUsage {
        val (http, token) = endpoint(credentials)
        val result = strictJson.decodeFromString(UsageResponse.serializer(), http.send("GET", "/v1/voice/usage", token))
        return VoiceUsage(result.usedSeconds.toInt(), result.limitSeconds.toInt(), result.conversationCount.toInt(), result.conversationLimit.toInt())
    }

    companion object {
        private val strictJson = Json { ignoreUnknownKeys = true }

        /** happy-wire voice.ts: reject a partial grant or an unknown denial reason. */
        fun parseCredentials(text: String): VoiceCredentials {
            val objectValue = strictJson.parseToJsonElement(text).jsonObject
            val envelope = strictJson.decodeFromJsonElement(Envelope.serializer(), objectValue)
            return if (envelope.allowed) {
                val value = strictJson.decodeFromJsonElement(Grant.serializer(), objectValue)
                VoiceCredentials.Granted(value.conversationToken, value.conversationId, value.agentId, value.elevenUserId)
            } else {
                val value = strictJson.decodeFromJsonElement(Denial.serializer(), objectValue)
                require(value.reason in setOf("voice_hard_limit_reached", "subscription_required", "voice_conversation_limit_reached"))
                VoiceCredentials.Denied(value.reason)
            }
        }
    }
}

@Serializable private data class AgentRequest(val agentId: String)
@Serializable private data class Envelope(val allowed: Boolean)
@Serializable private data class Grant(val conversationToken: String, val conversationId: String, val agentId: String, val elevenUserId: String, val usedSeconds: Double, val limitSeconds: Double)
@Serializable private data class Denial(val reason: String, val usedSeconds: Double, val limitSeconds: Double, val agentId: String)
@Serializable private data class UsageResponse(val usedSeconds: Double, val limitSeconds: Double, val conversationCount: Double, val conversationLimit: Double, val elevenUserId: String)