package io.elevenlabs.models

/**
 * Enum representing the current mode of the conversation
 */
enum class ConversationMode {
    /**
     * The agent is listening for user input
     */
    LISTENING,

    /**
     * The agent is currently speaking
     */
    SPEAKING;

    /**
     * Returns true if the agent is currently listening
     */
    val isListening: Boolean
        get() = this == LISTENING

    /**
     * Returns true if the agent is currently speaking
     */
    val isSpeaking: Boolean
        get() = this == SPEAKING
}