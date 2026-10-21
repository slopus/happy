package io.elevenlabs

/**
 * Main entry point for ElevenLabs Conversational AI SDK
 *
 * This interface provides the primary API for starting and managing conversations
 * with ElevenLabs AI agents. It supports both public and private agents,
 * text-only and voice conversations.
 *
 * Usage:
 * ```kotlin
 * val session = ConversationClient.startSession(
 *     ConversationConfig(agentId = "your-agent-id")
 * )
 * ```
 */
interface ConversationClient {
    /**
     * Start a new conversation session with the specified configuration
     *
     * @param config Configuration parameters for the conversation
     * @return A ConversationSession instance for managing the conversation
     * @throws IllegalArgumentException if the configuration is invalid
     * @throws RuntimeException if the session cannot be started
     */
    suspend fun startSession(config: ConversationConfig): ConversationSession

    /**
     * End the current conversation session
     */
    fun endSession()

    /**
     * Send a text message in the conversation
     *
     * @param message The message content to send
     */
    fun sendMessage(message: String)

    /**
     * Send feedback for the last agent response
     *
     * @param isPositive true for positive feedback, false for negative
     */
    fun sendFeedback(isPositive: Boolean)

    companion object {
        /**
         * Factory method to start a conversation session
         *
         * @param config Configuration for the conversation
         * @param context Android context required for audio and network setup
         * @return A new ConversationSession instance
         */
        suspend fun startSession(config: ConversationConfig, context: android.content.Context): ConversationSession {
            return ConversationClientImpl.startSession(config, context)
        }



        /**
         * Create a session builder for advanced configuration
         *
         * @param context Android context required for setup
         * @return ConversationSessionBuilder instance
         */
        fun builder(context: android.content.Context): ConversationSessionBuilder {
            return ConversationClientImpl.builder(context)
        }
    }
}