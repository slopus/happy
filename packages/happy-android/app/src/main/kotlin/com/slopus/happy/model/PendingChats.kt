package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.sync.HappyAgentSpawnTarget
import com.slopus.happy.sync.rigReasoningSelection

// A checkout's chats as tabs (utils/worktreeTabs.ts), the chats being opened
// from the strip's `+` before a machine has answered (sync/pendingChats.ts),
// and the start that opens one beside another (utils/newSessionCheckout.ts).

enum class PendingChatStatus { Starting, Failed }

/**
 * pendingChats.ts `PendingChat`: a chat on screen before it exists on a
 * machine, standing in for itself under [id] (the route's id too).
 * [knownSessionIds] are the checkout's chats when `+` was pressed, so the
 * session that arrives first is recognised as this one; [queued] are
 * messages sent before the machine answered, in order.
 */
@Immutable
data class PendingChat(
    val id: String,
    val anchorSessionId: String,
    val sessionId: String? = null,
    val knownSessionIds: List<String>,
    val status: PendingChatStatus = PendingChatStatus.Starting,
    val draft: String = "",
    val queued: List<String> = emptyList(),
    val createdAt: Long,
)

const val PENDING_CHAT_PREFIX = "pending-chat:"

/** Tells a stand-in apart from a real session id. */
fun isPendingChatId(id: String): Boolean = id.startsWith(PENDING_CHAT_PREFIX)

/** What a checkout's strip draws: its real chats in tab order, then the stand-ins. */
@Immutable
data class WorktreeTabs(val tabs: List<SessionRowData>, val pending: List<PendingChat>)

/**
 * resolveWorktreeTabs: one chat is one tab. A session not in a stand-in's
 * [PendingChat.knownSessionIds] is the arrival that stand-in already
 * stands for, so it waits rather than doubling it; a named stand-in is
 * never drawn. [pending] oldest first, so concurrent starts take arrivals
 * in the order asked.
 */
fun resolveWorktreeTabs(tabs: List<SessionRowData>, pending: List<PendingChat>): WorktreeTabs {
    if (pending.isEmpty()) return WorktreeTabs(tabs, emptyList())
    val spokenFor = HashSet<String>()
    val visible = ArrayList<PendingChat>()
    for (chat in pending) {
        if (chat.sessionId != null) continue
        tabs.firstOrNull { it.id !in spokenFor && it.id !in chat.knownSessionIds }?.let { spokenFor += it.id }
        visible += chat
    }
    return WorktreeTabs(tabs.filter { it.id !in spokenFor }, visible)
}

/** The stand-ins of a checkout: still starting, opened beside one of [tabIds], oldest first. */
fun pendingChatsBeside(chats: Collection<PendingChat>, tabIds: Collection<String>): List<PendingChat> =
    chats.filter { it.status == PendingChatStatus.Starting && it.anchorSessionId in tabIds }.sortedBy { it.createdAt }

/**
 * A start with the draft it runs from and, for Happy Agent, the catalog
 * destination it already knows. [target] wraps the destination so "none
 * given" (resolve it from the draft) differs from "a plain directory".
 */
data class SessionStartRequest(val draft: NewSessionDraft, val target: SpawnTargetOverride? = null)

/** A Happy Agent destination fixed by the caller; [target] null forces a plain directory. */
data class SpawnTargetOverride(val target: HappyAgentSpawnTarget?)

/**
 * newSessionLikeSession: another chat exactly where [session] runs (its own
 * directory, not its project's), with its harness and its picks. Happy
 * Agent is told the workspace or project rather than the path. Nothing is
 * typed for it: the draft's text belongs to whatever is being written elsewhere.
 */
fun newSessionLikeSession(session: Session, mirror: ComposerMirror?): SessionStartRequest {
    val metadata = session.metadata
    val path = metadata?.path?.trim().orEmpty()
    val rig = metadata.isRig()
    val modelMode = mirror?.modelMode ?: if (rig) metadata.rigSelectedModel()?.let { (provider, id) -> qualifyRigModelKey(provider, id) } else null
    val permissionMode = mirror?.permissionMode
        ?: if (rig) metadata?.currentOperatingModeCode ?: metadata?.permissionMode ?: metadata?.session?.permissionMode else null
    val effortLevel = mirror?.effortLevel ?: if (rig) metadata.rigReasoningSelection(modelMode) else null
    val target = if (rig) {
        SpawnTargetOverride(
            metadata?.workspace?.id?.takeIf { it.isNotEmpty() }?.let { HappyAgentSpawnTarget.Workspace(it) }
                ?: metadata?.project?.id?.takeIf { it.isNotEmpty() }?.let { HappyAgentSpawnTarget.Project(it) },
        )
    } else {
        null
    }
    val agent = if (rig) AgentType.Rig else AgentType.entries.find { it.wire == metadata?.flavor && it != AgentType.Rig } ?: AgentType.Claude
    return SessionStartRequest(
        draft = NewSessionDraft(
            input = "",
            selectedMachineId = metadata?.machineId,
            selectedPath = if (path.isEmpty()) null else formatPathRelativeToHome(path, metadata?.homeDir),
            agentType = agent,
            permissionMode = permissionMode,
            modelMode = modelMode,
            effortLevel = effortLevel,
            sessionType = SessionType.Simple,
            worktreeKey = null,
        ),
        target = target,
    )
}
