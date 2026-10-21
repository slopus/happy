package com.slopus.happy.sync

import com.slopus.happy.chat.ChatNormalizer
import com.slopus.happy.chat.hasUnreceiptedUserMessage
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.model.Settings
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRigV1
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** A meta value JSON keeps as written, null included; a field left null in its parent is not written at all. */
data class Present<out T>(val value: T?)

/** messageMeta.ts `MessageModeMeta`: the picks a message runs with, resolved by the composer. */
data class MessageModeMeta(
    val permissionMode: String? = null,
    /** `Present(null)` asks for the agent's default model. */
    val model: Present<String>? = null,
    val modelProviderId: String? = null,
    val effort: Present<String>? = null,
    val serviceTier: Present<String>? = null,
)

/** messageMeta.ts `resolveMessageDeliveryMeta`: set only for a session that sends acceptance receipts. */
data class MessageDeliveryMeta(
    val expectsAcceptance: Boolean? = null,
    val queuedWhileBusy: Boolean? = null,
)

/** sync.ts `SendMessageOptions`. */
data class SendOptions(
    /** What the chat shows instead of [text] (a slash command's label, say). */
    val displayText: String? = null,
    /** chat, new_session, voice, ... (`MessageSentSource`). */
    val source: String = "chat",
    /** The picks to run with; null resolves them from the composer and agent defaults (messageMeta.ts). */
    val modeMeta: MessageModeMeta? = null,
    /** Null resolves it from the session (messageMeta.ts `resolveMessageDeliveryMeta`). */
    val deliveryMeta: MessageDeliveryMeta? = null,
    /** Meta fields laid over the built `meta`, replacing any of the same name. */
    val extraMeta: JsonObject? = null,
    /**
     * Pre-built plaintext records (session-protocol `file` events for uploaded
     * attachments) queued ahead of the text, in order, under the same
     * retry and delivery rules. Sealed with the session key here.
     */
    val attachments: List<JsonObject> = emptyList(),
    /** Return only once the server has stored it (or the send failed for good). */
    val awaitDelivery: Boolean = false,
    /** Checked up to the moment of acceptance: false means the user has moved on, and nothing is sent. */
    val isCurrent: () -> Boolean = { true },
    /** Called once the message is in the outbox; from then on it is going out. */
    val onAccepted: () -> Unit = {},
)

/** A message that was not queued; the message is for the user. */
class SendException(message: String) : IllegalStateException(message)

sealed interface SendResult {
    /** In the outbox; not necessarily delivered yet. */
    data class Accepted(val localId: String) : SendResult

    /** Nothing was queued. [message] is for the user, when there is something to tell them. */
    data class NotSent(val message: String?) : SendResult
}

/**
 * Sending (sync.ts `sendMessage` and `flushOutbox`). A message is built and
 * encrypted exactly as happy-app builds it, then put in the stored outbox in
 * one step; from there a per-session loop POSTs everything queued to
 * `/v3/sessions/:id/messages`, retrying with backoff. The server dedupes on
 * localId, so a retry or a send interrupted by the process dying is safe.
 *
 * Outbox rows go QUEUED, SENDING, SENT (stored, waiting for its echo) and
 * are removed when the echo is stored. FAILED is for the user to retry or
 * discard: a refusal the server will repeat, or a send still pending 30 s
 * after the app went to the background (sync.ts background watchdog).
 *
 * The POST answer does not move the message cursor: receipts or other
 * messages may come before ours, unread. It only asks for a catch-up.
 */
class MessageSender internal constructor(
    private val api: SyncApi,
    private val store: HappyStore,
    private val decoder: RecordDecoder,
    private val messages: MessageSync,
    private val composer: SessionComposer,
    /** Whether the agent is mid-turn (presence), for delivery meta. */
    private val isThinking: (sessionId: String) -> Boolean,
    private val scope: CoroutineScope,
    /** Pulls sessions in so a session just created can be sent to (sync.ts ensureSessionReady). */
    private val refreshSessions: suspend () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newLocalId: () -> String = { UUID.randomUUID().toString() },
    private val sentFrom: String = SENT_FROM,
) {
    private val flushes = ConcurrentHashMap<String, InvalidateSync>()

    @Volatile
    private var backgroundSince: Long? = null
    private var watchdog: Job? = null

    /** A session's outbox rows, oldest first. */
    fun outbox(sessionId: String): Flow<List<OutboxRecord>> =
        store.outboxChanges(sessionId).map { store.outbox(sessionId) }.distinctUntilChanged().flowOn(io)

    /** Whether a user message of this session is still waiting to reach the server (for delivery meta). */
    suspend fun hasUnsentUserMessage(sessionId: String): Boolean = withContext(io) {
        store.outbox(sessionId).any { it.kind == OutboxKind.USER && (it.state == OutboxState.QUEUED || it.state == OutboxState.SENDING) }
    }

    /**
     * Chat's entry point: queues [text] with the meta happy-app would give it,
     * [meta] laid over that, and returns the localId once it is in the
     * outbox. Delivery is the outbox's job from there ([outbox]).
     *
     * @throws SendException when nothing was queued.
     */
    suspend fun send(sessionId: String, text: String, meta: JsonObject?, attachments: List<JsonObject> = emptyList()): String =
        when (val result = send(sessionId, text, SendOptions(extraMeta = meta, attachments = attachments))) {
            is SendResult.Accepted -> result.localId
            is SendResult.NotSent -> throw SendException(result.message ?: "The message was not sent.")
        }

    /** sync.ts `sendMessage`. */
    suspend fun send(sessionId: String, text: String, options: SendOptions = SendOptions()): SendResult {
        if (!options.isCurrent()) return SendResult.NotSent(null)
        if (!ensureSessionReady(sessionId)) {
            return SendResult.NotSent(if (options.isCurrent()) NOT_SYNCED else null)
        }
        if (!options.isCurrent()) return SendResult.NotSent(null)

        val session = withContext(io) { store.session(sessionId) } ?: return SendResult.NotSent(null)
        val cipher = withContext(io) { decoder.cipher(session.wrappedDataKey) } ?: return SendResult.NotSent(NOT_SYNCED)
        // The draft this send spends, and the mode it runs with, are the composer's now.
        val mirror = composer.mirrors.value[sessionId] ?: ComposerMirror()
        val draftStamp = mirror.draftUpdatedAt
        val metadata = SessionMetadata.parse(session.metadataJson)
        val modeMeta = options.modeMeta ?: try {
            val overrides = withContext(io) { Settings.parse(store.effectiveSettings()).agentDefaultOverrides }
            MessageMetaResolver.mode(metadata, mirror, overrides)
        } catch (e: UnsupportedPermissionModeException) {
            return SendResult.NotSent(e.message)
        }
        val deliveryMeta = options.deliveryMeta ?: MessageMetaResolver.delivery(
            metadata,
            session.agentStateJson,
            thinking = isThinking(sessionId),
            isNewSession = options.source == "new_session",
            // Queued or in flight, or echoed with no receipt yet: happy-app holds all of them pending.
            hasPendingUserMessage = withContext(io) {
                store.outbox(sessionId).any { it.kind == OutboxKind.USER && it.state != OutboxState.FAILED } ||
                    hasUnreceiptedUserMessage(store.messages(sessionId, RECEIPT_WINDOW).mapNotNull(ChatNormalizer::normalize))
            },
        )

        val localId = newLocalId()
        val record = userRecord(text, sentFrom, options.copy(modeMeta = modeMeta, deliveryMeta = deliveryMeta))
        // Every record is sealed before any is queued: a failure here must not
        // leave file events in the outbox for a retry to send twice.
        val staged = withContext(io) {
            options.attachments.map { attachment -> Triple(newLocalId(), attachment, cipher.encryptToBase64(attachment)) }
        }
        val content = withContext(io) { cipher.encryptToBase64(record) }

        // Nothing suspends between this check and acceptance. A navigation,
        // deletion or Stop must never redirect or replay this send.
        val accepted = withContext(io) {
            if (!options.isCurrent() || store.session(sessionId) == null) return@withContext false
            val now = clock()
            fun row(id: String, kind: OutboxKind, json: JsonObject, sealed: String) = OutboxRecord(
                localId = id,
                sessionId = sessionId,
                kind = kind,
                recordJson = json.toString(),
                content = sealed,
                createdAt = now,
                state = OutboxState.QUEUED,
                attempts = 0,
                error = null,
                serverId = null,
                serverSeq = null,
            )
            store.transaction {
                // Attachments first, in order, then the text (sync.ts: file events precede the message).
                store.enqueueOutbox(
                    staged.map { (id, json, sealed) -> row(id, OutboxKind.ATTACHMENT, json, sealed) } +
                        row(localId, OutboxKind.USER, record, content),
                )
                // Local activity time: the opt-in activity sort follows the user, not agent output.
                store.markMessageSent(sessionId, now)
            }
            true
        }
        if (!accepted) return SendResult.NotSent(null)

        // Accepted is irreversible: what follows runs even if the caller stops waiting.
        withContext(NonCancellable) {
            spendDraft(sessionId, text, options.source, draftStamp)
            options.onAccepted()
        }
        val flush = flushFor(sessionId)
        if (options.awaitDelivery) flush.invalidateAndAwait() else flush.invalidate()
        maybeStartWatchdog()
        return SendResult.Accepted(localId)
    }

    /** A failed message goes back in the queue. */
    suspend fun retry(sessionId: String, localId: String) {
        withContext(io) { store.setOutboxState(sessionId, listOf(localId), OutboxState.QUEUED) }
        flushFor(sessionId).invalidate()
        maybeStartWatchdog()
    }

    /** A failed message is dropped without sending. */
    suspend fun discard(sessionId: String, localId: String) {
        withContext(io) {
            val row = store.outbox(sessionId).firstOrNull { it.localId == localId }
            if (row != null && row.state == OutboxState.FAILED) store.deleteOutbox(sessionId, localId)
        }
    }

    /** At start and on every connect: whatever is queued goes out (a send cut off by the process dying included). */
    suspend fun resume() {
        val sessions = withContext(io) {
            store.requeueInterruptedSends()
            store.outbox().filter { it.state == OutboxState.QUEUED }.map { it.sessionId }.distinct()
        }
        sessions.forEach { flushFor(it).invalidate() }
        maybeStartWatchdog()
    }

    /**
     * The app went to the background or came back (sync.ts background send
     * watchdog): what is still unsent 30 s into the background fails, so the
     * user sees it and can retry instead of assuming it went.
     */
    @Synchronized
    fun setForeground(active: Boolean) {
        if (!active) {
            if (backgroundSince == null) backgroundSince = clock()
            maybeStartWatchdog()
            return
        }
        val since = backgroundSince
        backgroundSince = null
        watchdog?.cancel()
        watchdog = null
        // The process may have been frozen past the deadline without the timer firing.
        if (since != null && clock() - since >= BACKGROUND_SEND_TIMEOUT_MS) {
            scope.launch { failPending(BACKGROUND_FAILURE) }
        }
    }

    /** Every unsent message fails with [reason], and in-flight sends stop. */
    suspend fun failPending(reason: String) {
        flushes.values.forEach { it.cancel() }
        flushes.clear()
        withContext(io) {
            store.transaction {
                store.outbox()
                    .filter { it.state == OutboxState.QUEUED || it.state == OutboxState.SENDING }
                    .groupBy { it.sessionId }
                    .forEach { (sessionId, rows) -> store.setOutboxState(sessionId, rows.map { it.localId }, OutboxState.FAILED, reason) }
            }
        }
    }

    @Synchronized
    private fun maybeStartWatchdog() {
        val since = backgroundSince ?: return
        if (watchdog?.isActive == true) return
        watchdog = scope.launch {
            if (!hasPending()) return@launch
            delay((since + BACKGROUND_SEND_TIMEOUT_MS - clock()).coerceAtLeast(0))
            if (backgroundSince != null && hasPending()) failPending(BACKGROUND_FAILURE)
        }
    }

    private suspend fun hasPending() = withContext(io) {
        store.outbox().any { it.state == OutboxState.QUEUED || it.state == OutboxState.SENDING }
    }

    /** sync.ts `ensureSessionReady`: a visible row alone is not enough to place a message safely; it needs its own key. */
    private suspend fun ensureSessionReady(sessionId: String): Boolean {
        val ready = suspend {
            withContext(io) {
                val session = store.session(sessionId)
                session != null && SessionMetadata.parse(session.metadataJson) != null && decoder.cipher(session.wrappedDataKey) != null
            }
        }
        var attempt = 0
        while (!ready() && attempt < 3) {
            if (attempt > 0) delay(300L * attempt)
            // The shared sync retries network failures forever; the send keeps its own budget.
            withTimeoutOrNull(4_000) { refreshSessions() }
            attempt++
        }
        return ready()
    }

    /**
     * The Happy Agent draft is spent once its text is accepted, unless the
     * composer moved on since the send began (a newer edit), or the message
     * never came from it (voice).
     */
    private suspend fun spendDraft(sessionId: String, text: String, source: String, draftStamp: Long?) {
        val session = withContext(io) { store.session(sessionId) } ?: return
        if (!SessionMetadata.parse(session.metadataJson).isRigV1() || source == "voice") return
        val mirror = composer.mirrors.value[sessionId] ?: return
        if (mirror.draftUpdatedAt != draftStamp) return
        if (mirror.draft.isNullOrEmpty() || mirror.draft == text) composer.clearDraft(sessionId)
    }

    private fun flushFor(sessionId: String): InvalidateSync =
        flushes.computeIfAbsent(sessionId) { InvalidateSync(scope) { flush(sessionId) } }

    /**
     * sync.ts `flushOutbox`: everything queued for the session, in order, in
     * POSTs of at most [MAX_BATCH] (the server refuses a longer body with a
     * 400, which would fail every row and fail again on Retry).
     */
    private suspend fun flush(sessionId: String) {
        while (flushBatch(sessionId)) Unit
    }

    /** One POST of the oldest queued rows; false once there is nothing left to send. */
    private suspend fun flushBatch(sessionId: String): Boolean = withContext(io) {
        // Read and claimed in one write transaction: a row failed meanwhile is not picked up again.
        val batch = store.transaction {
            store.outbox(sessionId).filter { it.state == OutboxState.QUEUED || it.state == OutboxState.SENDING }
                .take(MAX_BATCH)
                .also { rows -> store.setOutboxState(sessionId, rows.map { it.localId }, OutboxState.SENDING) }
        }
        if (batch.isEmpty()) return@withContext false
        val ids = batch.map { it.localId }
        val stored = try {
            api.sendMessages(sessionId, batch.map { ApiOutgoingMessage(it.localId, it.content) })
        } catch (e: CancellationException) {
            // Left SENDING: failPending or the next start settles it.
            throw e
        } catch (e: HttpStatusException) {
            if (e.status in 400..499 && e.status != 408 && e.status != 429) {
                // Asking again gets the same answer: the user decides.
                settleSending(sessionId, ids, OutboxState.FAILED, failureMessage(e))
                return@withContext true
            }
            settleSending(sessionId, ids, OutboxState.QUEUED, failureMessage(e))
            maybeStartWatchdog()
            throw e
        } catch (e: Exception) {
            settleSending(sessionId, ids, OutboxState.QUEUED, e.message)
            maybeStartWatchdog()
            throw e
        }
        val answered = stored.messages.mapNotNull { message -> message.localId?.let { it to (message.id to message.seq) } }.toMap()
        store.markOutboxSent(sessionId, ids.associateWith { answered[it] ?: ("" to 0L) }.filterValues { it.first.isNotEmpty() })
        // A batch the server answered without ids is still stored; it waits for its echo.
        val unanswered = ids.filter { it !in answered }
        if (unanswered.isNotEmpty()) store.setOutboxState(sessionId, unanswered, OutboxState.SENT)
        messages.invalidate(sessionId)
        true
    }

    /** Rows of a failed POST that are still SENDING; one failed meanwhile (the watchdog) stays failed. */
    private fun settleSending(sessionId: String, ids: List<String>, state: OutboxState, error: String?) = store.transaction {
        val sending = store.outbox(sessionId).filter { it.localId in ids && it.state == OutboxState.SENDING }.map { it.localId }
        store.setOutboxState(sessionId, sending, state, error)
    }

    companion object {
        /** sync.ts sentFrom for `Platform.OS === 'android'`. */
        const val SENT_FROM = "android"
        const val BACKGROUND_SEND_TIMEOUT_MS = 30_000L
        const val BACKGROUND_FAILURE = "Message failed to send in background after 30s. Please retry."
        const val NOT_SYNCED = "The message was not sent: this session has not finished syncing. Please try again."
        /**
         * The newest rows searched for a send still waiting on its receipt: a
         * chat's first page, as much as happy-app has loaded when it asks.
         */
        const val RECEIPT_WINDOW = MessageSync.PAGE_SIZE

        /** v3SessionRoutes.ts sendMessagesBodySchema: `messages` holds 1 to 100. */
        const val MAX_BATCH = 100

        private fun failureMessage(e: HttpStatusException) = "Server error: ${e.status}"

        /**
         * The user record exactly as sync.ts `sendMessage` builds it, key for
         * key: it is what the agent parses, and what the byte-compatibility
         * test compares with happy-app's own output.
         */
        fun userRecord(text: String, sentFrom: String, options: SendOptions): JsonObject = buildJsonObject {
            put("role", "user")
            put("content", buildJsonObject {
                put("type", "text")
                put("text", text)
            })
            val meta = buildJsonObject {
                put("sentFrom", sentFrom)
                options.deliveryMeta?.expectsAcceptance?.let { put("expectsAcceptance", it) }
                options.deliveryMeta?.queuedWhileBusy?.let { put("queuedWhileBusy", it) }
                put("appendSystemPrompt", SYSTEM_PROMPT)
                val mode = options.modeMeta ?: MessageModeMeta()
                mode.permissionMode?.let { put("permissionMode", it) }
                mode.model?.let { put("model", it.value?.let(::JsonPrimitive) ?: JsonNull) }
                mode.modelProviderId?.let { put("modelProviderId", it) }
                mode.effort?.let { put("effort", it.value?.let(::JsonPrimitive) ?: JsonNull) }
                mode.serviceTier?.let { put("serviceTier", it.value?.let(::JsonPrimitive) ?: JsonNull) }
                // `...(displayText && { displayText })`: an empty one is left out.
                options.displayText?.takeIf { it.isNotEmpty() }?.let { put("displayText", it) }
            }
            put("meta", options.extraMeta?.let { JsonObject(meta + it) } ?: meta)
        }

        /** prompt/systemPrompt.ts, after trimIdent. */
        val SYSTEM_PROMPT = """
            # Options

            You have a way to give a user a easy way to answer your questions if you know possible answers. To provide this, you need to output in your final response an XML:

            <options>
                <option>Option 1</option>
                ...
                <option>Option N</option>
            </options>

            You must output this in the very end of your response, not inside of any other text. Do not wrap it into a codeblock. Always dedicate "<options>" and "</options>" to a dedicated line. Never output anything like "custom", user always have an option to send a custom message. Do not enumerate options in both text and options block.
            Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.

            # Plan mode with options

            When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.
        """.trimIndent()
    }
}
