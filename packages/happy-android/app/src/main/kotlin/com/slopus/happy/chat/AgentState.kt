package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.AgentGoal
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The parts of a session's decrypted agent state the chat reads
 * (storageTypes.ts `AgentStateSchema`): permission requests, agent
 * communications, whether the user drives the agent from the terminal, the
 * plan's rate-limit windows, and the agent's active goal.
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
    /** Ephemeral; null when absent or malformed, without touching the rest. */
    val usageLimits: UsageLimits? = null,
    /** `agentGoalStatus` while active; null when absent, inactive or malformed, without touching the rest. */
    val agentGoal: AgentGoal? = null,
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
                usageLimits = UsageLimits.parse(o["usageLimits"]),
                agentGoal = AgentGoal.parse(o),
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

/**
 * storageTypes.ts `UsageLimitsSchema`: the plan's rate-limit windows
 * (`five_hour`, `seven_day`, provider-specific ones). [Window.utilization]
 * is percent used. As with zod's `.catch(undefined)`, one malformed window
 * drops the whole snapshot.
 */
@Immutable
data class UsageLimits(val capturedAt: Double, val windows: List<Window>) {
    @Immutable
    data class Window(
        val id: String,
        val label: String? = null,
        /** Kept as a string so statuses from newer CLIs degrade safely. */
        val status: String? = null,
        val utilization: Double? = null,
        val resetsAt: Double? = null,
    )

    companion object {
        fun parse(value: JsonElement?): UsageLimits? {
            val o = value.obj ?: return null
            val capturedAt = o["capturedAt"].num ?: return null
            val windows = ArrayList<Window>()
            for (entry in o["windows"].arr ?: return null) {
                val w = entry.obj ?: return null
                val label = w["label"]
                val status = w["status"]
                val utilization = w["utilization"]
                val resetsAt = w["resetsAt"]
                // label and status are optional (absent, not null); the numbers nullish.
                if (label != null && label.str == null) return null
                if (status != null && status.str == null) return null
                if (!utilization.isNullOrAbsent && utilization.num == null) return null
                if (!resetsAt.isNullOrAbsent && resetsAt.num == null) return null
                windows += Window(w["id"].str ?: return null, label.str, status.str, utilization.num, resetsAt.num)
            }
            return UsageLimits(capturedAt, windows)
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
