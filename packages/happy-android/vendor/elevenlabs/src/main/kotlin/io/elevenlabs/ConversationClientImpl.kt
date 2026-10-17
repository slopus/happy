package io.elevenlabs

import android.content.Context
import android.util.Log
import io.elevenlabs.BuildConfig
import io.elevenlabs.audio.AudioSessionManager
import io.elevenlabs.audio.LiveKitAudioManager
import io.elevenlabs.audio.NoOpAudioManager
import io.elevenlabs.audio.SoftwareMuteProcessor
import io.elevenlabs.network.TokenService
import io.elevenlabs.network.WebRTCConnection
import io.elevenlabs.network.WebSocketConnection
import io.elevenlabs.ConversationSession
import io.elevenlabs.ConversationConfig
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.audio.AudioProcessorOptions

/**
 * Internal implementation of ConversationClient
 *
 * This class creates fully integrated conversation sessions with all components:
 * network layer, audio management, event handling, and client tools.
 */
internal object ConversationClientImpl {

    /**
     * Factory method to create and start a conversation session
     *
     * @param config Configuration for the conversation
     * @param context Android context for audio and network setup
     * @return A new ConversationSession instance
     */
    suspend fun startSession(
        config: ConversationConfig,
        context: Context
    ): ConversationSession {
        validateConfig(config)
        return if (config.textOnly) {
            startTextOnlySession(config, context)
        } else {
            startVoiceSession(config, context)
        }
    }

    /**
     * Start a voice session over LiveKit/WebRTC. Uses the existing token-fetch +
     * room creation path.
     */
    private suspend fun startVoiceSession(
        config: ConversationConfig,
        context: Context
    ): ConversationSession {
        // Generate token if needed for public agents
        val finalConfig = if (!config.isPrivateAgent) {
            val tokenService = TokenService(baseUrl = config.apiEndpoint)
            val tokenResponse = tokenService.fetchPublicAgentToken(
                config.agentId!!,
                config.overrides?.client?.source ?: "android_sdk",
                config.overrides?.client?.version ?: BuildConfig.SDK_VERSION,
                config.environment
            )
            config.copy(conversationToken = tokenResponse.token, agentId = null)
        } else {
            config
        }

        val softwareMuteProcessor = finalConfig.audioConfiguration
            ?.takeIf { it.useSoftwareMute }
            ?.let {
                SoftwareMuteProcessor(
                    onMutedSpeech = it.onMutedSpeech,
                    mutedSpeechThresholdInDb = it.mutedSpeechThreshold
                        ?: SoftwareMuteProcessor.DEFAULT_THRESHOLD_DB,
                )
            }

        // Create LiveKit room
        val room = LiveKit.create(
            appContext = context,
            overrides = LiveKitOverrides(
                audioOptions = AudioOptions(
                    // null lets LiveKit apply its own default (pre-existing behavior)
                    audioOutputType = if (finalConfig.useMediaStream) {
                        AudioType.MediaAudioType()
                    } else {
                        null
                    },
                    javaAudioDeviceModuleCustomizer = { builder ->
                        builder.setSampleRate(finalConfig.audioInputSampleRate)
                    },
                    audioProcessorOptions = softwareMuteProcessor?.let {
                        AudioProcessorOptions(capturePostProcessor = it)
                    }
                )
            )
        )
        Log.d("ConversationClient", "Created LiveKit room instance @${room.hashCode()}")

        val connection = WebRTCConnection(context, room)
        Log.d("ConversationClient", "WebRTCConnection initialized")

        val audioSessionManager = AudioSessionManager(context)
        val audioManager = LiveKitAudioManager(context, room, softwareMuteProcessor)
        Log.d("ConversationClient", "LiveKitAudioManager initialized")

        val toolRegistry = buildToolRegistry(finalConfig)

        audioSessionManager.configureForVoiceCall()

        val session = ConversationSessionImpl(
            context = context,
            config = finalConfig,
            room = room,
            connection = connection,
            audioManager = audioManager,
            toolRegistry = toolRegistry,
        )

        session.start()
        return session
    }

    /**
     * Start a text-only session over the ConvAI WebSocket transport.
     *
     * Skips LiveKit, audio session configuration, and the public-agent token fetch
     * because the WebSocket endpoint takes the agent_id directly. Private agents
     * pass a conversation signature via [ConversationConfig.conversationToken].
     */
    private suspend fun startTextOnlySession(
        config: ConversationConfig,
        context: Context
    ): ConversationSession {
        // No transport-specific validation needed: validateConfig() already enforces that public
        // agents have agentId and private agents have conversationToken (which, for text-only,
        // is the signed URL from /v1/convai/conversation/get-signed-url).
        val connection = WebSocketConnection()
        Log.d("ConversationClient", "WebSocketConnection initialized for text-only session")

        val audioManager = NoOpAudioManager()
        val toolRegistry = buildToolRegistry(config)

        val session = ConversationSessionImpl(
            context = context,
            config = config,
            room = null,
            connection = connection,
            audioManager = audioManager,
            toolRegistry = toolRegistry,
        )

        session.start()
        return session
    }

    private fun buildToolRegistry(config: ConversationConfig): ClientToolRegistry {
        val registry = ClientToolRegistry()
        config.clientTools.forEach { (name, tool) ->
            try {
                registry.registerTool(name, tool)
            } catch (e: Exception) {
                Log.d("ConversationClient", "Failed to register client tool '$name': ${e.message}")
            }
        }
        return registry
    }

    /**
     * Validate the conversation configuration
     *
     * @param config Configuration to validate
     * @throws IllegalArgumentException if configuration is invalid
     */
    private fun validateConfig(config: ConversationConfig) {
        val provided = listOfNotNull(
            config.agentId.takeUnless { it.isNullOrBlank() }?.let { "agentId" },
            config.conversationToken.takeUnless { it.isNullOrBlank() }?.let { "conversationToken" },
            config.signedUrl.takeUnless { it.isNullOrBlank() }?.let { "signedUrl" },
        )
        require(provided.size == 1) {
            "ConversationConfig requires exactly one of agentId / conversationToken / signedUrl, " +
                "got $provided"
        }

        if (config.textOnly) {
            require(config.conversationToken.isNullOrBlank()) {
                "Text-only sessions use signedUrl (private) or agentId (public), not conversationToken"
            }
        } else {
            require(config.signedUrl.isNullOrBlank()) {
                "Voice sessions use conversationToken (private) or agentId (public), not signedUrl"
            }
        }
    }

    /**
     * Create a conversation session builder for advanced configuration
     *
     * @param context Android context
     * @return ConversationSessionBuilder instance
     */
    fun builder(context: Context): ConversationSessionBuilder {
        return ConversationSessionBuilder(context)
    }
}

/**
 * Builder class for creating customized conversation sessions
 */
class ConversationSessionBuilder(private val context: Context) {

    private var config: ConversationConfig? = null
    private val customTools = mutableMapOf<String, ClientTool>()

    /**
     * Set the conversation configuration
     */
    fun config(config: ConversationConfig): ConversationSessionBuilder {
        this.config = config
        return this
    }

    /**
     * Add a custom client tool
     */
    fun addTool(name: String, tool: ClientTool): ConversationSessionBuilder {
        customTools[name] = tool
        return this
    }

    /**
     * Add a simple function-based tool
     */
    fun addTool(name: String, function: suspend (Map<String, Any>) -> String): ConversationSessionBuilder {
        customTools[name] = object : ClientTool {
            override suspend fun execute(parameters: Map<String, Any>): ClientToolResult? {
                return try {
                    val result = function(parameters)
                    ClientToolResult.success(result)
                } catch (e: Exception) {
                    ClientToolResult.failure("Function execution failed: ${e.message}")
                }
            }
        }
        return this
    }


    /**
     * Build the conversation session
     */
    suspend fun build(): ConversationSession {
        val sessionConfig = config ?: throw IllegalStateException("Configuration is required")

        // Create the basic session
        val session = ConversationClientImpl.startSession(sessionConfig, context)

        // Register custom tools
        customTools.forEach { (name, tool) ->
            session.registerTool(name, tool)
        }

        return session
    }
}