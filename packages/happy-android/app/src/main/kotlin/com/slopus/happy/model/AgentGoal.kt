package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// The agent's current goal, as the agent state publishes it
// (storageTypes.ts AgentGoalStatusSchema, components/agentGoalStatus.ts).

enum class AgentGoalAction(val wire: String) { Edit("edit"), Stop("stop"), Clear("clear") }

/**
 * An `active` agentGoalStatus: [source] is "claude" or "codex", whose
 * session ([sourceSessionId]) set it; [capabilities] are the actions the
 * agent accepts. Inactive and unavailable statuses show nothing, so they
 * are not kept.
 */
@Immutable
data class AgentGoal(
    val source: String,
    val sourceSessionId: String,
    val text: String,
    val capabilities: Set<AgentGoalAction> = emptySet(),
) {
    companion object {
        private val SOURCES = setOf("claude", "codex")

        /**
         * The schema's active branch: a known source, a non-blank id and
         * text, capabilities only as booleans. Anything else is no goal.
         */
        fun parse(state: JsonObject?): AgentGoal? {
            val goal = state?.get("agentGoalStatus") as? JsonObject ?: return null
            if (goal.string("status") != "active") return null
            val source = goal.string("source")?.takeIf { it in SOURCES } ?: return null
            val sourceSessionId = goal.string("sourceSessionId")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val text = goal.string("text")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val capabilities = (goal["capabilities"] as? JsonObject)?.let { caps ->
                AgentGoalAction.entries.filterTo(HashSet()) { (caps[it.wire] as? JsonPrimitive)?.booleanOrNull == true }
            }.orEmpty()
            return AgentGoal(source, sourceSessionId, text, capabilities)
        }

        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

/**
 * resolveVisibleAgentGoalStatus: only while the session is online, and only
 * when the goal comes from the agent session this chat runs now (its Claude
 * session or Codex thread), so a resumed chat never shows its last run's goal.
 */
fun visibleAgentGoal(goal: AgentGoal?, online: Boolean, metadata: SessionMetadata?): AgentGoal? {
    if (goal == null || !online) return null
    val expected = when (goal.source) {
        "claude" -> metadata?.claudeSessionId
        "codex" -> metadata?.codexThreadId
        else -> null
    }
    return goal.takeIf { expected != null && it.sourceSessionId == expected }
}

/** AgentGoalBar's actions in its order, as far as the agent offers them. */
fun AgentGoal.offeredActions(): List<AgentGoalAction> =
    listOf(AgentGoalAction.Edit, AgentGoalAction.Stop, AgentGoalAction.Clear).filter { it in capabilities }
