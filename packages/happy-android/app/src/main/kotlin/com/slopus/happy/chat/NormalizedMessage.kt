package com.slopus.happy.chat

import kotlinx.serialization.json.JsonElement

/**
 * A stored record in canonical form, before the reducer joins it to the rest
 * of the session (typesRaw.ts `NormalizedMessage`).
 */
data class NormalizedMessage(
    val id: String,
    val localId: String?,
    val createdAt: Long,
    val body: Body,
    val isSidechain: Boolean = false,
    val meta: MessageMeta? = null,
    val usage: UsageData? = null,
    val claudeUuid: String? = null,
    val codexItemId: String? = null,
    /** Session-protocol turn id: agent rows that share one belong to the same answer. */
    val turn: String? = null,
    val author: SessionAuthor? = null,
) {
    sealed interface Body {
        data class User(val text: String) : Body
        data class Agent(val content: List<AgentContent>) : Body
        data class Event(val event: AgentEvent) : Body
        /** A retired or unrecognized record; see [ChatMessage.Unsupported]. */
        data class Unsupported(val kind: String) : Body
    }

    /** Agent blocks, each tagged with the uuids the sidechain tracer follows. */
    sealed interface AgentContent {
        val uuid: String
        val parentUUID: String?

        data class Text(val text: String, override val uuid: String, override val parentUUID: String?) : AgentContent

        data class Thinking(val thinking: String, override val uuid: String, override val parentUUID: String?) : AgentContent

        data class ToolUse(
            val id: String,
            val name: String,
            val title: String? = null,
            val input: JsonElement?,
            val description: String?,
            override val uuid: String,
            override val parentUUID: String?,
        ) : AgentContent

        data class ToolResult(
            val toolUseId: String,
            val content: JsonElement?,
            val isError: Boolean,
            override val uuid: String,
            override val parentUUID: String?,
            val permissions: ResultPermissions? = null,
        ) : AgentContent

        /** The prompt that opened a sub-agent's conversation. */
        data class Sidechain(val prompt: String, override val uuid: String) : AgentContent {
            override val parentUUID: String? get() = null
        }
    }

    /** Permission outcome a tool result reports for its own call. */
    data class ResultPermissions(
        val date: Long,
        val approved: Boolean,
        val mode: String? = null,
        val allowedTools: List<String>? = null,
        val decision: PermissionDecision? = null,
    )

    val agentContent: List<AgentContent> get() = (body as? Body.Agent)?.content.orEmpty()
}
