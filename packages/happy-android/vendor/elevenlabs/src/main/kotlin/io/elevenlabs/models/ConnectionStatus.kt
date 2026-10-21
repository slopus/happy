package io.elevenlabs.models

/**
 * Base interface for all status enums to provide common functionality
 * and ensure consistent naming across different status types.
 */
interface Status {
    /**
     * Returns true if this status represents an active/connected state
     */
    val isActive: Boolean

    /**
     * Returns true if this status represents a transitional state
     */
    val isTransitioning: Boolean

    /**
     * Returns true if this status represents an error or failed state
     */
    val hasError: Boolean
}

/**
 * Extension function to convert ConnectionState to ConversationStatus
 * Centralizes the mapping logic and makes it more maintainable.
 */
fun io.elevenlabs.network.ConnectionState.toConversationStatus(): ConversationStatus {
    return when (this) {
        io.elevenlabs.network.ConnectionState.CONNECTED -> ConversationStatus.CONNECTED
        io.elevenlabs.network.ConnectionState.CONNECTING -> ConversationStatus.CONNECTING
        io.elevenlabs.network.ConnectionState.DISCONNECTED -> ConversationStatus.DISCONNECTED
        io.elevenlabs.network.ConnectionState.ERROR -> ConversationStatus.ERROR
        // IDLE and RECONNECTING map to DISCONNECTED for conversation purposes
        else -> ConversationStatus.DISCONNECTED
    }
}
