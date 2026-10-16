package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// What the chat shows once the reducer has folded a session's records
// together: a port of happy-app's sync/typesMessage.ts. One row per block,
// tool results joined to their calls, permissions joined to their tools.
// This is the contract between the reducer (which produces it) and the chat
// UI (which only reads it).

/**
 * Send-time options that travel inside the encrypted record
 * (typesMessageMeta.ts). Kept as the JSON it arrived in so fields from newer
 * producers survive; the accessors read the ones the app uses.
 */
@Immutable
data class MessageMeta(val raw: JsonObject) {
    val sentFrom: String? get() = raw["sentFrom"].str
    val expectsAcceptance: Boolean get() = raw["expectsAcceptance"].bool == true
    val queuedWhileBusy: Boolean get() = raw["queuedWhileBusy"].bool == true
    val permissionMode: String? get() = raw["permissionMode"].str
    val model: String? get() = raw["model"].str
    val effort: String? get() = raw["effort"].str
    /** Shown in the bubble instead of the text that was sent. */
    val displayText: String? get() = raw["displayText"].str

    companion object {
        fun of(value: JsonElement?): MessageMeta? = value.obj?.let(::MessageMeta)
    }
}

/**
 * Who wrote a user-role envelope, for sessions with more than one
 * participant. `owner` marks the account the session belongs to: the reader.
 */
@Immutable
data class SessionAuthor(val id: String, val name: String, val owner: Boolean? = null)

/** Model usage from an agent record (typesRaw.ts `usageDataSchema`). */
@Immutable
data class UsageData(
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheCreationInputTokens: Long? = null,
    val cacheReadInputTokens: Long? = null,
    val contextWindow: Double? = null,
    val serviceTier: String? = null,
) {
    companion object {
        fun parse(value: JsonElement?): UsageData? {
            val o = value.obj ?: return null
            return UsageData(
                inputTokens = o["input_tokens"].num?.toLong() ?: return null,
                outputTokens = o["output_tokens"].num?.toLong() ?: return null,
                cacheCreationInputTokens = o["cache_creation_input_tokens"].num?.toLong(),
                cacheReadInputTokens = o["cache_read_input_tokens"].num?.toLong(),
                contextWindow = o["context_window"].num,
                serviceTier = o["service_tier"].str,
            )
        }
    }
}

/** An agent event (typesRaw.ts `agentEventSchema`). */
@Immutable
sealed interface AgentEvent {
    data class Switch(val mode: String) : AgentEvent
    data class Message(val message: String) : AgentEvent
    data class LimitReached(val endsAt: Long) : AgentEvent
    data object Ready : AgentEvent
    /** The agent took the message with server id [ref] into context. Never rendered. */
    data class UserMessageAccepted(val ref: String) : AgentEvent
    data class UserMessageRejected(val ref: String, val reason: String) : AgentEvent

    companion object {
        fun parse(value: JsonElement?): AgentEvent? {
            val o = value.obj ?: return null
            return when (o["type"].str) {
                "switch" -> o["mode"].str?.takeIf { it == "local" || it == "remote" }?.let(::Switch)
                "message" -> o["message"].str?.let(::Message)
                "limit-reached" -> o["endsAt"].long?.let(::LimitReached)
                "ready" -> Ready
                "user-message-accepted" -> o["ref"].str?.let(::UserMessageAccepted)
                "user-message-rejected" -> {
                    val ref = o["ref"].str ?: return null
                    val reason = o["reason"].str ?: return null
                    UserMessageRejected(ref, reason)
                }
                else -> null
            }
        }
    }
}

enum class ToolState { Running, Completed, Error }

enum class PermissionStatus(val wire: String) {
    Pending("pending"), Approved("approved"), Denied("denied"), Canceled("canceled");

    companion object {
        fun of(wire: String?): PermissionStatus? = entries.firstOrNull { it.wire == wire }
    }
}

enum class PermissionDecision(val wire: String) {
    Approved("approved"), ApprovedForSession("approved_for_session"), Denied("denied"), Abort("abort");

    companion object {
        fun of(wire: String?): PermissionDecision? = entries.firstOrNull { it.wire == wire }
    }
}

@Immutable
data class ToolPermission(
    /** The request id the CLI expects back in the permission response. */
    val id: String,
    val status: PermissionStatus,
    val reason: String? = null,
    val mode: String? = null,
    val allowedTools: List<String>? = null,
    val decision: PermissionDecision? = null,
    val date: Long? = null,
)

@Immutable
data class ToolCall(
    /** Provider tool-call id, for joining side-channel state (questions). */
    val callId: String? = null,
    val name: String,
    /** Human-readable title from the session protocol. */
    val title: String? = null,
    val state: ToolState,
    val input: JsonElement?,
    val createdAt: Long,
    val startedAt: Long? = null,
    val completedAt: Long? = null,
    val description: String? = null,
    val result: JsonElement? = null,
    val permission: ToolPermission? = null,
)

/** One chat row. [sortKey] orders the list (`messageSortKey`). */
@Immutable
sealed interface ChatMessage {
    val id: String
    val createdAt: Long
    val sortKey: Long get() = createdAt

    data class UserText(
        override val id: String,
        val localId: String?,
        override val createdAt: Long,
        val text: String,
        /** Shown instead of [text] when set. */
        val displayText: String? = null,
        val meta: MessageMeta? = null,
        /** Claude transcript uuid: the rewind point for fork and duplicate. */
        val claudeUuid: String? = null,
        val codexItemId: String? = null,
        /** Sent, but the agent has not taken it into context yet; pinned to the bottom. */
        val pending: Boolean = false,
        /** Terminal refusal from the daemon; this message never started a turn. */
        val sendError: String? = null,
        /** Position in the chat when that differs from [createdAt]. */
        val sortAt: Long? = null,
        val author: SessionAuthor? = null,
    ) : ChatMessage {
        override val sortKey: Long get() = sortAt ?: createdAt

        /** Sent by someone other than this account (`isOtherParticipantMessage`). */
        val isOtherParticipant: Boolean get() = author != null && author.owner != true
    }

    data class AgentText(
        override val id: String,
        override val createdAt: Long,
        val text: String,
        val isThinking: Boolean = false,
        val turn: String? = null,
        val meta: MessageMeta? = null,
    ) : ChatMessage

    data class ToolCallMessage(
        override val id: String,
        override val createdAt: Long,
        val tool: ToolCall,
        /** A sub-agent's work, nested under the call that started it. */
        val children: List<ChatMessage> = emptyList(),
        val turn: String? = null,
        val meta: MessageMeta? = null,
    ) : ChatMessage

    data class Event(
        override val id: String,
        override val createdAt: Long,
        val event: AgentEvent,
        val turn: String? = null,
        val meta: MessageMeta? = null,
    ) : ChatMessage

    /**
     * A stored record in a format the current CLI no longer writes, or one
     * that did not parse. Shown as a compact placeholder, never dropped or
     * allowed to crash the chat. [kind] names what it was, for bug reports.
     */
    data class Unsupported(
        override val id: String,
        override val createdAt: Long,
        val kind: String,
    ) : ChatMessage

    companion object {
        /**
         * Added to a pending message's timestamp to park it past every real
         * one, keeping pending messages at the bottom in send order
         * (`PENDING_SORT_OFFSET`).
         */
        const val PENDING_SORT_OFFSET = 8_000_000_000_000_000L
    }
}
