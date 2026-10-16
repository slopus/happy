package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.AgentState
import com.slopus.happy.chat.selectPendingCommunications
import com.slopus.happy.data.MachineRecord
import com.slopus.happy.data.SessionRecord

/** sessionState.ts `SessionState`. */
enum class SessionState { Disconnected, Thinking, Waiting, PermissionRequired, InputRequired }

/**
 * The two things the session list reads out of a session's agent state:
 * how many permission requests are open, and how many communications the
 * agent is waiting on. Both come from the chat's typed [AgentState] and
 * agentCommunications.ts `selectPendingCommunications`, so the list and the
 * chat agree on "Input required".
 */
@Immutable
data class AgentAttention(val permissionRequests: Int, val pendingCommunications: Int) {
    companion object {
        val None = AgentAttention(0, 0)

        fun parse(agentStateJson: String?): AgentAttention = of(AgentState.parse(agentStateJson))

        fun of(state: AgentState?): AgentAttention =
            if (state == null) None
            else AgentAttention(state.requests.size, selectPendingCommunications(state).size)
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
    /** The session's own avatar as the server describes it; [avatar] once it is downloaded. */
    val avatarDescriptor: SessionAvatarDescriptor? = null,
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
            lastMessageSentAt = record.lastMessageSentAt,
            avatarDescriptor = SessionAvatarDescriptor.parse(record.avatarJson),
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
