package com.slopus.happy.voice

import android.content.Context
import io.elevenlabs.AgentOverrides
import io.elevenlabs.ClientTool
import io.elevenlabs.ClientToolResult
import io.elevenlabs.ConversationClient
import io.elevenlabs.ConversationConfig
import io.elevenlabs.ConversationSession
import io.elevenlabs.Language
import io.elevenlabs.Overrides
import io.elevenlabs.PromptOverrides
import io.elevenlabs.models.ConversationMode
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

data class VoiceSessionConfig(
    val sessionId: String,
    val initialContext: String,
    val agentId: String? = null,
    val token: String? = null,
    val userId: String? = null,
    val systemPrompt: String? = null,
    val firstMessage: String? = null,
    val language: String? = null,
)

interface VoiceConnection {
    val conversationId: String?
    suspend fun end()
    fun context(text: String)
    fun prompt(text: String)
    suspend fun mute(muted: Boolean)
}

interface VoiceEvents {
    fun disconnected()
    fun error()
    fun agentSpeaking(speaking: Boolean)
    fun vad(score: Float)
}

fun interface VoiceTransport {
    suspend fun connect(config: VoiceSessionConfig, events: VoiceEvents, tools: VoiceTools): VoiceConnection
}

/** Official ElevenLabs WebRTC SDK: JWTs, audio focus/routing, microphone tracks and teardown. */
class ElevenLabsTransport(private val context: Context) : VoiceTransport {
    override suspend fun connect(config: VoiceSessionConfig, events: VoiceEvents, tools: VoiceTools): VoiceConnection {
        var opened: ConversationSession? = null
        try {
            val session = ConversationClient.startSession(configuration(config, events, tools), context)
            opened = session
            return object : VoiceConnection {
                override val conversationId get() = session.getId()
                override suspend fun end() = session.endSession()
                override fun context(text: String) = session.sendContextualUpdate(text)
                override fun prompt(text: String) = session.sendUserMessage(text)
                override suspend fun mute(muted: Boolean) = session.setMicMuted(muted)
            }
        } catch (error: Throwable) {
            withContext(NonCancellable) { opened?.endSession() }
            throw error
        }
    }

    internal fun configuration(config: VoiceSessionConfig, events: VoiceEvents, tools: VoiceTools) = ConversationConfig(
        agentId = if (config.token == null) config.agentId else null,
        conversationToken = config.token,
        userId = config.userId,
        dynamicVariables = mapOf("sessionId" to config.sessionId, "initialConversationContext" to config.initialContext),
        overrides = Overrides(agent = AgentOverrides(
            prompt = config.systemPrompt?.let { PromptOverrides(it) },
            firstMessage = config.firstMessage,
            language = config.language?.let(Language::fromCode),
        )),
        clientTools = listOf("sendMessageToSession", "processPermissionRequest").associateWith { name ->
            object : ClientTool {
                override suspend fun execute(parameters: Map<String, Any>): ClientToolResult =
                    ClientToolResult.success(tools.execute(name, parameters))
            }
        },
        onDisconnect = { events.disconnected() },
        onError = { _, _ -> events.error() },
        onModeChange = { events.agentSpeaking(it == ConversationMode.SPEAKING) },
        onVadScore = events::vad,
    )
}