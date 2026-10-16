package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.AgentAttention
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.displayName
import com.slopus.happy.model.isHappyAgent
import com.slopus.happy.model.resolveSessionState

/**
 * The session as the chat reads it: the shared typed [Session] plus the
 * chat's typed [AgentState] (permission requests and questions in full,
 * where [Session.attention] only counts them).
 */
@Immutable
data class ChatSessionInfo(val session: Session, val agentState: AgentState?) {
    val id: String get() = session.id
    val metadata: SessionMetadata? get() = session.metadata

    /** `metadata.bot.name`, then `metadata.summary.text`; null for an untitled chat. */
    val title: String? get() = session.displayName()

    /** Happy Agent (rig) session: `metadata.client.id == 'rig'`. */
    val isRig: Boolean get() = session.isHappyAgent()

    /** happy-app `usesControlledSessionUi`: not a rig session. */
    val usesControlledSessionUi: Boolean get() = !isRig

    /** Claude unless the metadata names another flavor. */
    val isClaudeFlavor: Boolean get() = metadata?.flavor.let { it == null || it == "claude" }

    /** A rig daemon that reports when a message enters the agent's context (rigCapabilities.ts). */
    val sendsMessageReceipts: Boolean
        get() = isRig && (metadata?.rigMetadataVersion ?: 0) >= 1 && metadata?.capabilities?.messageReceipts == true

    companion object {
        fun from(record: SessionRecord): ChatSessionInfo =
            ChatSessionInfo(Session.from(record), AgentState.parse(record.agentStateJson))
    }
}

/** sessionState.ts `resolveSessionState` over the chat's typed agent state. */
fun resolveSessionState(agentState: AgentState?, thinking: Boolean, online: Boolean): SessionState =
    resolveSessionState(
        AgentAttention(
            permissionRequests = agentState?.requests?.size ?: 0,
            pendingCommunications = selectPendingCommunications(agentState).size,
        ),
        thinking,
        online,
    )
