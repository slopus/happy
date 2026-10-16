package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import com.slopus.happy.data.MachineRecord
import com.slopus.happy.data.SessionRecord
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** sessionState.ts `SessionState`. */
enum class SessionState { Disconnected, Thinking, Waiting, PermissionRequired, InputRequired }

/**
 * The two things the session list reads out of a session's agent state:
 * whether a permission request is open, and whether the agent has asked a
 * question it is waiting on (agentCommunications.ts `selectPendingCommunications`).
 * The chat owns the typed AgentState; this reads only what [resolveSessionState] needs.
 */
@Immutable
data class AgentAttention(val permissionRequests: Int, val pendingCommunications: Int) {
    companion object {
        val None = AgentAttention(0, 0)

        fun parse(agentStateJson: String?): AgentAttention {
            val state = parseJsonObject(agentStateJson) ?: return None
            val requests = (state["requests"] as? JsonObject)?.size ?: 0
            val communications = state["communications"] as? JsonObject ?: return AgentAttention(requests, 0)
            val completed = state["completedCommunications"] as? JsonObject
            val pending = communications.count { (id, value) ->
                val communication = value as? JsonObject ?: return@count false
                if (completed?.get(id) != null && completed[id] !is JsonNull) return@count false
                val kind = (communication["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@count false
                // An unknown kind still waits on the user; a form needs a question to ask.
                kind != "form" || hasQuestions(communication)
            }
            return AgentAttention(requests, pending)
        }

        private fun hasQuestions(communication: JsonObject): Boolean {
            val form = communication["form"] as? JsonObject ?: return false
            val questions = form["questions"] as? JsonArray ?: return false
            return questions.any { (it as? JsonObject)?.get("question") is JsonPrimitive }
        }
    }
}

/**
 * sessionState.ts `resolveSessionState`: one precedence for every place that
 * presents a session. Permission requests block a tool, so they win over
 * questions; a question means the agent waits on the user even mid-turn.
 */
fun resolveSessionState(attention: AgentAttention, thinking: Boolean, isOnline: Boolean): SessionState = when {
    !isOnline -> SessionState.Disconnected
    attention.permissionRequests > 0 -> SessionState.PermissionRequired
    attention.pendingCommunications > 0 -> SessionState.InputRequired
    thinking -> SessionState.Thinking
    else -> SessionState.Waiting
}

/** A project avatar materialized as a local data URI (projectTypes.ts `ProjectAvatar`). */
@Immutable
data class ProjectAvatar(val ref: String, val version: Long, val mimeType: String, val thumbhash: String, val uri: String)

/** projectTypes.ts `Project`: decrypted project data. */
@Immutable
data class Project(
    val id: String,
    val externalId: String,
    val name: String,
    val kind: String?,
    val metadataVersion: Long,
    val avatar: ProjectAvatar?,
    val createdAt: Long,
    val updatedAt: Long,
)

/** storageTypes.ts `Session`, as far as the screens outside the chat read it. */
@Immutable
data class Session(
    val id: String,
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val active: Boolean,
    val activeAt: Long,
    /** Account-scoped project linkage supplied beside the encrypted session. */
    val projectId: String?,
    val metadata: SessionMetadata?,
    val metadataVersion: Long,
    val attention: AgentAttention,
    val agentStateVersion: Long,
    val thinking: Boolean = false,
    val thinkingAt: Long = 0,
    /** Device-local draft text (or the synced Happy Agent draft). */
    val draft: String? = null,
    /** This device's record of when it last sent a message here. */
    val lastMessageSentAt: Long? = null,
    val avatar: ProjectAvatar? = null,
) {
    /** "online" when active, else the last-seen time (storage.ts resolveSessionOnlineState). */
    val isOnline: Boolean get() = active

    val state: SessionState get() = resolveSessionState(attention, thinking, isOnline)

    companion object {
        fun from(record: SessionRecord): Session = Session(
            id = record.id,
            seq = record.seq,
            createdAt = record.createdAt,
            updatedAt = record.updatedAt,
            active = record.active,
            activeAt = record.activeAt,
            projectId = record.projectId,
            metadata = SessionMetadata.parse(record.metadataJson),
            metadataVersion = record.metadataVersion,
            attention = AgentAttention.parse(record.agentStateJson),
            agentStateVersion = record.agentStateVersion,
        )
    }
}

/** storageTypes.ts `Machine`. */
@Immutable
data class Machine(
    val id: String,
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val active: Boolean,
    val activeAt: Long,
    val metadata: MachineMetadata?,
    val metadataVersion: Long,
    val daemonState: DaemonState?,
    val daemonStateVersion: Long,
) {
    /** machineUtils.ts `isMachineOnline`: the active flag, no timeouts. */
    val isOnline: Boolean get() = active

    companion object {
        fun from(record: MachineRecord): Machine = Machine(
            id = record.id,
            seq = record.seq,
            createdAt = record.createdAt,
            updatedAt = record.updatedAt,
            active = record.active,
            activeAt = record.activeAt,
            metadata = MachineMetadata.parse(record.metadataJson),
            metadataVersion = record.metadataVersion,
            daemonState = DaemonState.parse(record.daemonStateJson),
            daemonStateVersion = record.daemonStateVersion,
        )
    }
}
