package io.elevenlabs.network

import io.elevenlabs.models.Status

/**
 * Represents the current state of a network connection
 *
 * This represents the low-level network connection state used internally
 * by connection implementations like WebRTCConnection.
 */
enum class ConnectionState : Status {
    /**
     * No connection established
     */
    IDLE,

    /**
     * In the process of connecting
     */
    CONNECTING,

    /**
     * Successfully connected and active
     */
    CONNECTED,

    /**
     * Attempting to reconnect after connection loss
     */
    RECONNECTING,

    /**
     * Disconnected (either intentionally or due to error)
     */
    DISCONNECTED,

    /**
     * Connection encountered an error
     */
    ERROR;

    /**
     * Returns true if the connection is in an active state
     */
    override val isActive: Boolean
        get() = this == CONNECTED

    /**
     * Returns true if the connection is in a transitional state
     */
    override val isTransitioning: Boolean
        get() = this == CONNECTING || this == RECONNECTING

    /**
     * Returns true if the connection has failed or is in error state
     */
    override val hasError: Boolean
        get() = this == ERROR
}