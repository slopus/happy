package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The parts of a session's decrypted agent state the chat reads
 * (storageTypes.ts `AgentStateSchema`): permission requests, agent
 * communications, and whether the user drives the agent from the terminal.
 *
 * Parsing is per entry: a malformed request or communication is skipped
 * without losing the rest, where zod would reject the whole state.
 */
@Immutable
data class AgentState(
    val controlledByUser: Boolean = false,
    val requests: Map<String, PermissionRequest> = emptyMap(),
    val completedRequests: Map<String, CompletedPermissionRequest> = emptyMap(),
    val communications: Map<String, AgentCommunication> = emptyMap(),
    val completedCommunications: Map<String, CompletedAgentCommunication> = emptyMap(),
) {
    @Immutable
    data class PermissionRequest(
        val tool: String,
        val arguments: JsonElement?,
        val createdAt: Long? = null,
        /** Raw provider tool-use id when the request id is scoped (`agentID:toolUseID`). */
        val toolUseId: String? = null,
    )

    @Immutable
    data class CompletedPermissionRequest(
        val tool: String,
        val arguments: JsonElement?,
        val createdAt: Long? = null,
        val completedAt: Long? = null,
        val status: PermissionStatus,
        val reason: String? = null,
        val mode: String? = null,
        /** `allowedTools`, or the CLI's `allowTools` spelling of the same grant. */
        val allowedTools: List<String>? = null,
        val decision: PermissionDecision? = null,
        val toolUseId: String? = null,
    )

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun parse(text: String?): AgentState? {
            text ?: return null
            return parse(runCatching { json.parseToJsonElement(text) }.getOrNull())
        }

        fun parse(value: JsonElement?): AgentState? {
            val o = value.obj ?: return null
            return AgentState(
                controlledByUser = o["controlledByUser"].bool == true,
                requests = entries(o["requests"]) { r ->
                    PermissionRequest(
                        tool = r["tool"].str ?: return@entries null,
                        arguments = r["arguments"],
                        createdAt = r["createdAt"].long,
                        toolUseId = r["toolUseId"].str,
                    )
                },
                completedRequests = entries(o["completedRequests"]) { r ->
                    val status = PermissionStatus.of(r["status"].str)
                        ?.takeIf { it != PermissionStatus.Pending } ?: return@entries null
                    CompletedPermissionRequest(
                        tool = r["tool"].str ?: return@entries null,
                        arguments = r["arguments"],
                        createdAt = r["createdAt"].long,
                        completedAt = r["completedAt"].long,
                        status = status,
                        reason = r["reason"].str,
                        mode = r["mode"].str,
                        allowedTools = r["allowedTools"].strings ?: r["allowTools"].strings,
                        decision = PermissionDecision.of(r["decision"].str),
                        toolUseId = r["toolUseId"].str,
                    )
                },
                communications = entries(o["communications"], AgentCommunication::parse),
                completedCommunications = entries(o["completedCommunications"], CompletedAgentCommunication::parse),
            )
        }

        private fun <T> entries(value: JsonElement?, parse: (JsonObject) -> T?): Map<String, T> {
            val o = value.obj ?: return emptyMap()
            val result = LinkedHashMap<String, T>()
            for ((key, entry) in o) {
                result[key] = parse(entry.obj ?: continue) ?: continue
            }
            return result
        }
    }
}

/** One option of an agent question (`AgentQuestionOptionSchema`). */
@Immutable
data class AgentQuestionOption(val label: String, val description: String? = null)

/** One question in a `form` communication (`AgentQuestionSchema`). */
@Immutable
data class AgentQuestion(
    val id: String,
    val header: String,
    val question: String,
    val options: List<AgentQuestionOption> = emptyList(),
    val multiSelect: Boolean = false,
    /** Null means the default: the user may write their own answer. */
    val allowCustom: Boolean? = null,
    /** False lets the user submit without choosing anything. */
    val required: Boolean? = null,
) {
    companion object {
        fun parse(o: JsonObject): AgentQuestion? {
            val options = o["options"]
            return AgentQuestion(
                id = o["id"].str ?: return null,
                header = o["header"].str ?: return null,
                question = o["question"].str ?: return null,
                options = if (options.isNullOrAbsent) {
                    emptyList()
                } else {
                    (options.arr ?: return null).map { option ->
                        val obj = option.obj ?: return null
                        AgentQuestionOption(obj["label"].str ?: return null, obj["description"].str)
                    }
                },
                multiSelect = o["multiSelect"].bool == true,
                allowCustom = o["allowCustom"].bool,
                required = o["required"].bool,
            )
        }
    }
}

/** An answer to one question (`AgentQuestionAnswerSchema`). */
@Immutable
data class AgentQuestionAnswer(val options: List<String> = emptyList(), val custom: String? = null)

/**
 * An agent-to-user communication (`AgentCommunicationSchema`). [kind] is an
 * open string: a kind this build does not know is still shown, so the agent
 * is not left waiting on an answer that never comes.
 */
@Immutable
data class AgentCommunication(
    val kind: String,
    val createdAt: Long? = null,
    val toolUseId: String? = null,
    val title: String? = null,
    /** The questions, when [kind] is `form`; null when there is no form. */
    val questions: List<AgentQuestion>? = null,
) {
    companion object {
        fun parse(o: JsonObject): AgentCommunication? = AgentCommunication(
            kind = o["kind"].str ?: return null,
            createdAt = o["createdAt"].long,
            toolUseId = o["toolUseId"].str,
            title = o["title"].str,
            questions = o["form"].obj?.let { form ->
                val questions = form["questions"]
                if (questions.isNullOrAbsent) {
                    emptyList()
                } else {
                    (questions.arr ?: return null).map { AgentQuestion.parse(it.obj ?: return null) ?: return null }
                }
            },
        )
    }
}

@Immutable
data class CompletedAgentCommunication(
    val communication: AgentCommunication,
    val completedAt: Long? = null,
    val answered: Boolean,
    val answers: Map<String, AgentQuestionAnswer>? = null,
) {
    companion object {
        fun parse(o: JsonObject): CompletedAgentCommunication? {
            val status = o["status"].str
            if (status != "answered" && status != "cancelled") return null
            return CompletedAgentCommunication(
                communication = AgentCommunication.parse(o) ?: return null,
                completedAt = o["completedAt"].long,
                answered = status == "answered",
                answers = o["answers"].obj?.let { answers ->
                    answers.mapNotNull { (key, value) ->
                        val answer = value.obj ?: return@mapNotNull null
                        val options = answer["options"]
                        key to AgentQuestionAnswer(
                            options = if (options.isNullOrAbsent) emptyList() else options.strings ?: return@mapNotNull null,
                            custom = answer["custom"].str,
                        )
                    }.toMap()
                },
            )
        }
    }
}
