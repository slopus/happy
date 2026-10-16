package com.slopus.happy.chat

import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject

// The chat's seams to the rest of the app. The chat reads a session's stored
// records and its live state through these, and acts on the session through
// ChatActions; Sync implements them over the socket, the outbox and RPC.
// StoreChat* below are the implementations over what HappyStore holds today.

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

interface SessionPresence {
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

    /** Answers an agent question form ([buildAnswers]). */
    suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>)

    suspend fun cancelQuestion(sessionId: String, communicationId: String)

    /** Persists the composer's per-session mode picks (permission, model, effort). */
    suspend fun setModes(sessionId: String, permissionMode: String?, modelMode: String?, effortLevel: String?) = Unit
}

/** Every stored record of the session, re-read whenever the store changes. No paging: all of it is local. */
class StoreChatMessagesSource(private val store: HappyStore) : ChatMessagesSource {
    override fun messages(sessionId: String): Flow<ChatPage> =
        store.changes.map { ChatPage(store.messages(sessionId)) }.distinctUntilChanged().flowOn(Dispatchers.IO)

    override suspend fun loadOlder(sessionId: String): Boolean = false
}

class StoreChatSessionSource(private val store: HappyStore) : ChatSessionSource {
    override fun session(sessionId: String): Flow<SessionRecord?> =
        store.changes.map { store.session(sessionId) }.distinctUntilChanged().flowOn(Dispatchers.IO)
}

/** Until the socket exists: the server's `active` flag stands in for presence. */
object NoLivePresence : SessionPresence {
    override fun presence(sessionId: String): Flow<SessionPresenceState?> = flowOf(null)
}

/** Actions that only fail, for builds without Sync's sender. */
object UnavailableChatActions : ChatActions {
    private fun unavailable(): Nothing = throw UnsupportedOperationException("Sending is not available in this build yet")
    override suspend fun send(sessionId: String, text: String, meta: JsonObject?) = unavailable()
    override suspend fun abort(sessionId: String) = unavailable()
    override suspend fun answerPermission(sessionId: String, answer: PermissionAnswer) = unavailable()
    override suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>) = unavailable()
    override suspend fun cancelQuestion(sessionId: String, communicationId: String) = unavailable()
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
