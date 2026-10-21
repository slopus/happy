package io.elevenlabs.models

/**
 * Enum representing the current status of a conversation session
 *
 * This represents the high-level conversation lifecycle that app developers
 * interact with, abstracting away low-level network connection details.
 */
enum class ConversationStatus : Status {
    /**
     * The session is not connected
     */
    DISCONNECTED,

    /**
     * The session is in the process of connecting
     */
    CONNECTING,

    /**
     * The session is connected and active
     */
    CONNECTED,

    /**
     * The session is in the process of disconnecting
     */
    DISCONNECTING,

    /**
     * The session encountered an error
     */
    ERROR;

    /**
     * Returns true if the session is in an active state (connected)
     */
    override val isActive: Boolean
        get() = this == CONNECTED

    /**
     * Returns true if the session is in a transitional state
     */
    override val isTransitioning: Boolean
        get() = this == CONNECTING || this == DISCONNECTING

    /**
     * Returns true if the session is in an error state
     */
    override val hasError: Boolean
        get() = this == ERROR
}