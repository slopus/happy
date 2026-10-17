package io.elevenlabs.models

import com.google.gson.annotations.SerializedName

/**
 * Base class for outgoing events that can be sent to the server
 */
sealed class OutgoingEvent {
    abstract val type: String

    /**
     * User message event
     */
    data class UserMessage(
        val text: String,
    ) : OutgoingEvent() {
        override val type = "user_message"
    }

    class UserActivity : OutgoingEvent() {
        override val type = "user_activity"
    }

    /**
     * Feedback event
     */
    data class Feedback(
        val score: String, // "like" or "dislike"
        @SerializedName("event_id")
        val eventId: Int
    ) : OutgoingEvent() {
        override val type = "feedback"
    }

    /**
     * Contextual update event
     */
    data class ContextualUpdate(
        val text: String,
    ) : OutgoingEvent() {
        override val type = "contextual_update"
    }

    /**
     * Tool result event
     * Note: result must be a String (plain text or JSON string), not a Map/Object.
     * The backend expects result as a string field.
     */
    data class ClientToolResult(
        @SerializedName("tool_call_id")
        val toolCallId: String,
        val result: String,
        @SerializedName("is_error")
        val isError: Boolean = false,
    ) : OutgoingEvent() {
        override val type = "client_tool_result"
    }

    /**
     * Pong reply for ping
     */
    data class Pong(
        @SerializedName("event_id")
        val eventId: Int
    ) : OutgoingEvent() {
        override val type: String = "pong"
    }
}
