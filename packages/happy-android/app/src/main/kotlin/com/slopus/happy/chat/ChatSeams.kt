package com.slopus.happy.chat

import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.sync.MessageSync
import com.slopus.happy.sync.PermissionDecision as SyncPermissionDecision
import com.slopus.happy.sync.Presence
import com.slopus.happy.sync.SessionOps
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The chat's seams to the rest of the app. The chat reads a session's stored
// records and its live state through these, and acts on the session through
// ChatActions; Sync implements them over the socket, the outbox and RPC.
// Sync* adapt AccountSync; Store* read the store alone.

/** The stored records of one session, oldest first, and the paging state for older ones. */
data class ChatPage(
    val records: List<MessageRecord>,
    /** The server has records older than the oldest in [records]. */
    val hasMoreOlder: Boolean = false,
    val isLoadingOlder: Boolean = false,
    /** False until the first read from the store finished. */
    val loaded: Boolean = true,
)

interface ChatMessagesSource {
    fun messages(sessionId: String): Flow<ChatPage>

    /** Fetches one older page. True if it reached further back. */
    suspend fun loadOlder(sessionId: String): Boolean
}

/** The session row the chat reads: its metadata and agent state, decrypted JSON. */
interface ChatSessionSource {
    /** Null when the session is not on this device (deleted, or not synced yet). */
    fun session(sessionId: String): Flow<SessionRecord?>
}

/** Ephemeral session state from the socket (happy-app `session.presence`, `thinking`). */
data class SessionPresenceState(val online: Boolean, val thinking: Boolean = false, val activeAt: Long = 0)

interface ChatPresenceSource {
    /** Null until the socket has said anything about the session. */
    fun presence(sessionId: String): Flow<SessionPresenceState?>
}

/** A permission answer (ops.ts `sessionAllow` / `sessionDeny`). */
data class PermissionAnswer(
    /** The request id (`ToolPermission.id`). */
    val requestId: String,
    val approved: Boolean,
    /** Switch the session to this permission mode as part of the answer. */
    val mode: String? = null,
    /** "Don't ask again" grants (`allowTools`). */
    val allowedTools: List<String>? = null,
    val decision: PermissionDecision? = null,
)

/**
 * What the chat does to a session. Sync implements these; each suspends
 * until the action is accepted locally (queued in the outbox, or the RPC sent)
 * and throws on failure so the screen can say so.
 */
interface ChatActions {
    /** Sends a user message; [meta] is the record's `meta` (typesMessageMeta.ts). */
    suspend fun send(sessionId: String, text: String, meta: JsonObject? = null)

    suspend fun abort(sessionId: String)

    suspend fun answerPermission(sessionId: String, answer: PermissionAnswer)

    /** Answers an agent question form ([buildAnswers]); [kind] is the one the agent published. */
    suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String = "form")

    suspend fun cancelQuestion(sessionId: String, communicationId: String, kind: String = "form")

    /** Persists the composer's per-session mode picks (permission, model, effort); null leaves a pick as it is. */
    suspend fun setModes(sessionId: String, permissionMode: String?, modelMode: String?, effortLevel: String?) = Unit
}

/**
 * The session's records through [MessageSync]: collecting opens the chat
 * (newest page, catch-up, background history) and pages back on demand.
 */
class SyncChatMessagesSource(private val sync: MessageSync) : ChatMessagesSource {
    override fun messages(sessionId: String): Flow<ChatPage> =
        combine(sync.messages(sessionId), sync.paging(sessionId)) { records, paging ->
            ChatPage(records, paging.hasMoreOlder, paging.isLoadingOlder, loaded = paging.isLoaded)
        }.distinctUntilChanged()

    override suspend fun loadOlder(sessionId: String): Boolean = sync.loadOlder(sessionId)
}

/** Every stored record of the session, without fetching: for signed-out previews and tests. */
class StoreChatMessagesSource(private val store: HappyStore) : ChatMessagesSource {
    override fun messages(sessionId: String): Flow<ChatPage> =
        store.messageChanges(sessionId).map { ChatPage(store.messages(sessionId)) }.distinctUntilChanged().flowOn(Dispatchers.IO)

    override suspend fun loadOlder(sessionId: String): Boolean = false
}

class StoreChatSessionSource(private val store: HappyStore) : ChatSessionSource {
    override fun session(sessionId: String): Flow<SessionRecord?> =
        store.versions.map { it.sessions }.distinctUntilChanged().map { store.session(sessionId) }.distinctUntilChanged()
            .flowOn(Dispatchers.IO)
}

/** The socket's activity and thinking flags ([Presence.sessions]). */
class SyncChatPresenceSource(private val presence: Presence) : ChatPresenceSource {
    override fun presence(sessionId: String): Flow<SessionPresenceState?> =
        presence.sessions.map { sessions ->
            sessions[sessionId]?.let { SessionPresenceState(online = it.active, thinking = it.thinking, activeAt = it.activeAt) }
        }.distinctUntilChanged()
}

/** No socket: the stored `active` flag stands in for presence. */
object NoLivePresence : ChatPresenceSource {
    override fun presence(sessionId: String): Flow<SessionPresenceState?> = flowOf(null)
}

/** Actions that only fail, for builds without Sync's sender. */
object UnavailableChatActions : ChatActions {
    private fun unavailable(): Nothing = throw UnsupportedOperationException("Sending is not available in this build yet")
    override suspend fun send(sessionId: String, text: String, meta: JsonObject?) = unavailable()
    override suspend fun abort(sessionId: String) = unavailable()
    override suspend fun answerPermission(sessionId: String, answer: PermissionAnswer) = unavailable()
    override suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) =
        unavailable()
    override suspend fun cancelQuestion(sessionId: String, communicationId: String, kind: String) = unavailable()
}

/**
 * The chat's actions over Sync's [SessionOps] RPCs, read at call time so a
 * new sign-in is picked up. Sending stays unavailable until Sync's sender
 * lands; per-session mode picks stay with the composer (happy-app keeps them
 * in local storage and sends them with the next message).
 */
class SyncChatActions(private val ops: () -> SessionOps?) : ChatActions {
    private fun ops(): SessionOps = ops.invoke() ?: throw IllegalStateException("Not signed in")

    override suspend fun send(sessionId: String, text: String, meta: JsonObject?) = UnavailableChatActions.send(sessionId, text, meta)

    override suspend fun abort(sessionId: String) = ops().abort(sessionId)

    override suspend fun answerPermission(sessionId: String, answer: PermissionAnswer) {
        val decision = answer.decision?.let { d -> SyncPermissionDecision.entries.first { it.wire == d.wire } }
        if (answer.approved) {
            ops().allow(sessionId, answer.requestId, answer.mode, answer.allowedTools, decision)
        } else {
            ops().deny(sessionId, answer.requestId, answer.mode, answer.allowedTools, decision)
        }
    }

    override suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) =
        ops().answerQuestion(sessionId, communicationId, answersJson(answers), kind)

    override suspend fun cancelQuestion(sessionId: String, communicationId: String, kind: String) =
        ops().cancelCommunication(sessionId, communicationId, kind)

    companion object {
        /** `Record<string, AgentQuestionAnswer>` as JSON.stringify writes it: no `custom` when there is none. */
        fun answersJson(answers: Map<String, AgentQuestionAnswer>): JsonObject = buildJsonObject {
            for ((id, answer) in answers) {
                put(id, buildJsonObject {
                    put("options", JsonArray(answer.options.map(::JsonPrimitive)))
                    answer.custom?.let { put("custom", it) }
                })
            }
        }
    }
}

/** Per-session composer drafts, kept for the life of the process (happy-app `session.draft`). */
class ChatDrafts {
    private val drafts = MutableStateFlow<Map<String, String>>(emptyMap())
    val all: StateFlow<Map<String, String>> = drafts.asStateFlow()

    fun get(sessionId: String): String = drafts.value[sessionId].orEmpty()

    fun set(sessionId: String, text: String) {
        drafts.value = if (text.isEmpty()) drafts.value - sessionId else drafts.value + (sessionId to text)
    }
}
