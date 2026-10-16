package com.slopus.happy.ui.home

import com.slopus.happy.model.PENDING_CHAT_PREFIX
import com.slopus.happy.model.PendingChat
import com.slopus.happy.model.PendingChatStatus
import com.slopus.happy.model.SessionStartRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/**
 * pendingChats.ts: the chats on screen before a machine has agreed to run
 * them. Memory only: an app that was restarted has no start in flight to
 * rejoin. A record outlives its screen and its chat's arrival; the screen
 * standing on it retires it on the way out ([dismiss]), and opening another
 * sweeps the failed ones no screen is left on.
 */
class PendingChatStore(
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val state = MutableStateFlow<Map<String, PendingChat>>(emptyMap())
    val chats: StateFlow<Map<String, PendingChat>> = state.asStateFlow()

    operator fun get(id: String): PendingChat? = state.value[id]

    /** openPendingChat: a chat that can be opened at once, running where [anchorSessionId] runs. */
    fun open(anchorSessionId: String, knownSessionIds: List<String>): PendingChat {
        val chat = PendingChat(
            id = PENDING_CHAT_PREFIX + newId(),
            anchorSessionId = anchorSessionId,
            knownSessionIds = knownSessionIds.toList(),
            createdAt = clock(),
        )
        state.update { chats -> chats.filterValues { it.status != PendingChatStatus.Failed } + (chat.id to chat) }
        return chat
    }

    /** Keystrokes in the stand-in's composer; ignored once the chat has a session, whose composer owns the text. */
    fun setDraft(id: String, draft: String) = change(id) { if (it.sessionId != null || it.draft == draft) it else it.copy(draft = draft) }

    /** Send on a chat that does not exist yet: the message waits in line for the handover. */
    fun submit(id: String, message: String) = change(id) {
        if (it.sessionId != null || message.isBlank()) it else it.copy(draft = "", queued = it.queued + message)
    }

    /** The machine answered: from here on the chat goes by its real session id. */
    fun settle(id: String, sessionId: String) = change(id) { if (it.sessionId != null) it else it.copy(sessionId = sessionId) }

    /** The start gave up; it has already said why. */
    fun fail(id: String) = change(id) { if (it.sessionId != null) it else it.copy(status = PendingChatStatus.Failed) }

    fun dismiss(id: String) = state.update { it - id }

    private fun change(id: String, transform: (PendingChat) -> PendingChat) = state.update { chats ->
        val chat = chats[id] ?: return@update chats
        val next = transform(chat)
        if (next == chat) chats else chats + (id to next)
    }
}

/** What the handover needs from the account: sending, the composer's drafts, and the user's alerts. */
interface PendingChatSessions {
    /** True once accepted; false when declined. @throws Exception with the user's words when it failed outright. */
    suspend fun send(sessionId: String, text: String): Boolean
    fun draft(sessionId: String): String?
    suspend fun writeDraft(sessionId: String, text: String)
    /** The session is known on this device (the anchor a failed start returns its text to). */
    fun exists(sessionId: String): Boolean
    fun alert(message: String)
}

/**
 * pendingChatHandover.ts: what was typed into a chat that did not exist yet
 * is moved onto the one that now does — its first messages if Send was
 * pressed, its draft if not. A send the chat declines hands its text back
 * into the draft, ahead of what is still being typed. Kept apart from the
 * screen, which may not be mounted when the machine answers.
 */
class PendingChatHandover(private val store: PendingChatStore, private val sessions: PendingChatSessions) {
    /** handOverPendingChat: the machine answered with [sessionId]. */
    suspend fun handOver(id: String, sessionId: String) {
        val chat = store[id]
        if (chat == null || chat.queued.isEmpty()) {
            chat?.let { writeDraft(sessionId, it.draft) }
            store.settle(id, sessionId)
            return
        }
        val unsent = ArrayList<String>()
        var failed = false
        for (message in chat.queued) {
            if (!failed) {
                try {
                    if (sessions.send(sessionId, message.trim())) continue
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    sessions.alert(e.message?.takeIf { it.isNotBlank() } ?: "Failed to send the first message")
                }
                // A message that failed must not be overtaken by the one written after it.
                failed = true
            }
            unsent += message
        }
        // Read again: keystrokes kept landing while the messages went out.
        val draft = store[id]?.draft.orEmpty()
        writeDraft(sessionId, (unsent + draft).filter { it.isNotBlank() }.joinToString("\n\n"))
        store.settle(id, sessionId)
    }

    /** retirePendingChat: the start is not coming; the writing goes back to the anchor, then the tab goes. */
    suspend fun retire(id: String) {
        returnDraft(id)
        store.fail(id)
    }

    /**
     * returnPendingChatDraft: queued messages and the draft go back onto the
     * anchor, in front of its own draft. Once: a failed record has nothing left.
     */
    suspend fun returnDraft(id: String) {
        val chat = store[id] ?: return
        if (chat.status == PendingChatStatus.Failed) return
        val text = (chat.queued + chat.draft).filter { it.isNotBlank() }.joinToString("\n\n")
        if (text.isEmpty() || !sessions.exists(chat.anchorSessionId)) return
        val existing = sessions.draft(chat.anchorSessionId)?.takeIf { it.isNotBlank() }
        sessions.writeDraft(chat.anchorSessionId, if (existing != null) "$text\n\n$existing" else text)
    }

    private suspend fun writeDraft(sessionId: String, text: String) {
        if (text.isNotBlank()) sessions.writeDraft(sessionId, text)
    }
}

/**
 * WorktreeTabStrip's `+`: a sibling chat started where the open one runs.
 * The tab is the user's on the press; starts run one after another behind
 * it (the starter takes one at a time), and each lands as a handover or a
 * retirement. A start that fails says why through [failed].
 */
class PendingChatStarter(
    private val store: PendingChatStore,
    private val handover: PendingChatHandover,
    private val scope: CoroutineScope,
    private val start: suspend (SessionStartRequest) -> StartResult,
    private val failed: (String) -> Unit,
) {
    private val queue = Mutex()

    fun open(anchorSessionId: String, knownSessionIds: List<String>, request: SessionStartRequest): PendingChat {
        val chat = store.open(anchorSessionId, knownSessionIds)
        scope.launch {
            queue.withLock {
                val result = try {
                    start(request)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    StartResult.Failed(e.message ?: "Failed to start session")
                }
                when (result) {
                    is StartResult.Started -> handover.handOver(chat.id, result.sessionId)
                    is StartResult.Failed -> {
                        failed(result.message)
                        handover.retire(chat.id)
                    }
                    is StartResult.Refused -> {
                        failed(result.refusal.message)
                        handover.retire(chat.id)
                    }
                    is StartResult.NotSent, StartResult.Abandoned -> handover.retire(chat.id)
                }
            }
        }
        return chat
    }
}
