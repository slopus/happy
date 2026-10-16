package com.slopus.happy.chat

import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.MessageSender
import com.slopus.happy.sync.MessageSync
import com.slopus.happy.sync.PermissionDecision as SyncPermissionDecision
import com.slopus.happy.sync.Presence
import com.slopus.happy.sync.SendException
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.sync.SendResult
import com.slopus.happy.sync.SessionComposer
import com.slopus.happy.sync.SessionOps
import com.slopus.happy.sync.SpawnSessionResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
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
    /** This device's accepted sends not yet echoed back, oldest first. */
    val outbox: List<OutboxRecord> = emptyList(),
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
    /** The tool input as the user completed it (AskUserQuestion's answers). */
    val updatedInput: JsonObject? = null,
)

/**
 * What the chat does to a session. Sync implements these; each suspends
 * until the action is accepted locally (queued in the outbox, or the RPC sent)
 * and throws on failure so the screen can say so.
 */
interface ChatActions {
    /**
     * Queues a user message; [meta] is laid over the meta the sender resolves
     * (typesMessageMeta.ts); [attachments] are file records queued ahead of
     * the text. Returns once it is in the outbox, or with [awaitDelivery]
     * once the server has it. Throws [SendException] with a message for the
     * user when nothing was queued.
     */
    suspend fun send(
        sessionId: String,
        text: String,
        meta: JsonObject? = null,
        attachments: List<JsonObject> = emptyList(),
        awaitDelivery: Boolean = false,
    )

    /** A failed send goes back in the queue. */
    suspend fun retry(sessionId: String, localId: String) = Unit

    /** A failed send is dropped. */
    suspend fun discard(sessionId: String, localId: String) = Unit

    suspend fun abort(sessionId: String)

    suspend fun answerPermission(sessionId: String, answer: PermissionAnswer)

    /** Answers an agent question form ([buildAnswers]); [kind] is the one the agent published. */
    suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String = "form")

    suspend fun cancelQuestion(sessionId: String, communicationId: String, kind: String = "form")

    /** The composer's per-session mode picks, only the fields that changed; a null value resets that pick. */
    suspend fun setModes(sessionId: String, patch: Map<AgentModeField, String?>) = Unit

    /** The composer's text changed (a Happy Agent draft syncs to the session). */
    suspend fun setDraft(sessionId: String, text: String) = Unit

    /**
     * Resume a disconnected Happy CLI session on [machineId] (ops.ts
     * machineResumeSession), with the model and permission mode it would
     * send with; null leaves the agent's own.
     */
    suspend fun resume(sessionId: String, machineId: String, model: String?, permissionMode: String?): SpawnSessionResult =
        SpawnSessionResult.Error("Not signed in")

    /** sync.refreshSessions: the account's sessions fetched again, as after a resume. */
    suspend fun refreshSessions() = Unit
}

/**
 * The session's records through [MessageSync]: collecting opens the chat
 * (newest page, catch-up, background history) and pages back on demand.
 */
class SyncChatMessagesSource(private val sync: MessageSync, private val sender: MessageSender) : ChatMessagesSource {
    override fun messages(sessionId: String): Flow<ChatPage> =
        combine(sync.messages(sessionId), sync.paging(sessionId), sender.outbox(sessionId)) { records, paging, outbox ->
            ChatPage(records, paging.hasMoreOlder, paging.isLoadingOlder, loaded = paging.isLoaded, outbox = outbox)
        }.distinctUntilChanged()

    override suspend fun loadOlder(sessionId: String): Boolean = sync.loadOlder(sessionId)
}

/** Every stored record of the session, without fetching: for signed-out previews and tests. */
class StoreChatMessagesSource(private val store: HappyStore) : ChatMessagesSource {
    override fun messages(sessionId: String): Flow<ChatPage> =
        combine(store.messageChanges(sessionId), store.outboxChanges(sessionId)) { _, _ ->
            ChatPage(store.messages(sessionId), outbox = store.outbox(sessionId))
        }.distinctUntilChanged().flowOn(Dispatchers.IO)

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
    private fun unavailable(): Nothing = throw UnsupportedOperationException("Not signed in")
    override suspend fun send(sessionId: String, text: String, meta: JsonObject?, attachments: List<JsonObject>, awaitDelivery: Boolean) =
        unavailable()
    override suspend fun abort(sessionId: String) = unavailable()
    override suspend fun answerPermission(sessionId: String, answer: PermissionAnswer) = unavailable()
    override suspend fun answerQuestion(sessionId: String, communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) =
        unavailable()
    override suspend fun cancelQuestion(sessionId: String, communicationId: String, kind: String) = unavailable()
}

/**
 * The chat's actions over the signed-in account ([AccountSync]): sends
 * through its [MessageSender], mode picks and drafts through its
 * [SessionComposer], the rest as [SessionOps] RPCs. Read at call time so a
 * new sign-in is picked up.
 */
class SyncChatActions(private val account: () -> AccountSync?) : ChatActions {
    private fun account(): AccountSync = account.invoke() ?: throw SendException("Not signed in")
    private fun ops(): SessionOps = account().sessionOps

    override suspend fun send(sessionId: String, text: String, meta: JsonObject?, attachments: List<JsonObject>, awaitDelivery: Boolean) {
        val options = SendOptions(extraMeta = meta, attachments = attachments, awaitDelivery = awaitDelivery)
        val result = account().sender.send(sessionId, text, options)
        if (result is SendResult.NotSent) throw SendException(result.message ?: "The message was not sent.")
    }

    override suspend fun retry(sessionId: String, localId: String) = account().sender.retry(sessionId, localId)

    override suspend fun discard(sessionId: String, localId: String) = account().sender.discard(sessionId, localId)

    override suspend fun setModes(sessionId: String, patch: Map<AgentModeField, String?>) {
        if (patch.isNotEmpty()) account().composer.setAgentModes(sessionId, patch)
    }

    override suspend fun setDraft(sessionId: String, text: String) {
        account.invoke()?.composer?.setText(sessionId, text)
    }

    override suspend fun resume(sessionId: String, machineId: String, model: String?, permissionMode: String?): SpawnSessionResult =
        account().machineOps.resumeSession(machineId, sessionId, model = model, permissionMode = permissionMode)

    override suspend fun refreshSessions() {
        account.invoke()?.syncNow()
    }

    override suspend fun abort(sessionId: String) = ops().abort(sessionId)

    override suspend fun answerPermission(sessionId: String, answer: PermissionAnswer) {
        val decision = answer.decision?.let { d -> SyncPermissionDecision.entries.first { it.wire == d.wire } }
        if (answer.approved) {
            ops().allow(sessionId, answer.requestId, answer.mode, answer.allowedTools, decision, answer.updatedInput)
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
