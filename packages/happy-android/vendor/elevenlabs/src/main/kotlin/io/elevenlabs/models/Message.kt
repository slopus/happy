package io.elevenlabs.models

import java.util.UUID

/**
 * A single entry in the conversation transcript, reconciled by the SDK and exposed via
 * [io.elevenlabs.ConversationSession.messages].
 *
 * @param id Stable identifier, preserved across in-place updates so list diffing
 *   (e.g. `LazyColumn`/`RecyclerView` keys) stays consistent.
 * @param role Who produced the message (user or agent).
 * @param content The text content; grows as a partial message streams in.
 * @param timestamp Creation time in epoch milliseconds, preserved across updates.
 * @param eventId Server event id correlating updates for the same message; `null` for
 *   locally appended messages.
 * @param isPartial `true` while still being assembled (streaming agent response or
 *   in-progress user transcript); `false` once finalized. Local messages are always `false`.
 */
data class Message(
    val id: String = UUID.randomUUID().toString(),
    val role: MessageRole,
    val content: String,
    val timestamp: Long = System.currentTimeMillis(),
    val eventId: Int? = null,
    val isPartial: Boolean = false
)

/**
 * Enum representing who sent a message
 */
enum class MessageRole {
    /**
     * Message sent by the user
     */
    USER,

    /**
     * Message sent by the agent
     */
    AGENT;

    /**
     * Returns true if this message is from the user
     */
    val isUser: Boolean
        get() = this == USER

    /**
     * Returns true if this message is from the agent
     */
    val isAgent: Boolean
        get() = this == AGENT
}
