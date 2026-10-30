package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.long
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.File
import kotlin.coroutines.CoroutineContext

/** What a conversation hears from the agent connection's event stream. */
sealed interface ConversationSignal {
    /** One journal event naming this agent: its `type` and `payload`. */
    data class Event(val type: String, val payload: JsonObject) : ConversationSignal

    /** The stream (re)connected: events may have been missed, so read again. */
    data object Resync : ConversationSignal
}

/** A request for the composer's focus, its cursor at [cursor]; [serial] tells requests apart. */
@Immutable
data class ComposerFocus(val serial: Int, val cursor: Int)

/** Everything a conversation screen draws. [rows] are newest first. */
@Immutable
data class ConversationState(
    /** The agent exists on the computer; false for a new chat until its first send makes it. */
    val created: Boolean = false,
    /** History has been read, or there is none to read yet. */
    val loaded: Boolean = false,
    /** Bootstrap and newest history are being refreshed, including after a reconnect. */
    val syncing: Boolean = false,
    val rows: List<ConversationRow> = emptyList(),
    val hasMore: Boolean = false,
    val loadingOlder: Boolean = false,
    /** The last page of older history failed; it waits for Retry rather than asking again by itself. */
    val olderFailed: Boolean = false,
    val agent: AgentInfo? = null,
    val mode: Mode? = null,
    /** What the composer can pick from; null until the computer's configuration is read. */
    val catalog: ModeCatalog? = null,
    val working: Boolean = false,
    val activity: Activity? = null,
    /** The composer's text as this conversation keeps it, and a count that moves only when it came from elsewhere. */
    val draft: String = "",
    val draftArrivals: Int = 0,
    /** The composer should take focus with its cursor here; a new value each time it's asked. */
    val composerFocus: ComposerFocus? = null,
    val question: Question? = null,
    val answering: Boolean = false,
    val stopping: Boolean = false,
    /** Why history could not be read. */
    val error: String? = null,
    /** A refused action, shown once. */
    val alert: String? = null,
    /** What home calls this conversation, so the screen has its name before the computer is asked. */
    val knownTitle: String? = null,
) {
    val title: String? get() = agent?.title?.takeIf { it.isNotBlank() } ?: knownTitle?.takeIf { it.isNotBlank() }
    /** A subagent is driven by its parent: it takes no messages. */
    val canSend: Boolean get() = agent?.isSubagent != true && agent?.archivedAt == null
}

/**
 * One conversation with a paired agent (happy-ios `Conversation`): its
 * history read by run, the connection's events applied on top, sends drawn
 * at once and delivered in order under their own ids, the draft kept with
 * the agent, and the open question. A new chat is [newTask]: nothing is read
 * until its first send makes the task, under the same [agentId], so the
 * screen becomes the real chat in place.
 *
 * All state lives on [lane], one coroutine at a time.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Conversation(
    private val api: ConversationApi,
    private val signals: Flow<ConversationSignal>,
    private val scope: CoroutineScope,
    val agentId: String,
    private var newTask: NewTask? = null,
    initialDraft: String = "",
    /** [ConversationState.knownTitle]. */
    knownTitle: String? = null,
    /** The answer to `POST /v0/tasks`, so home lists the task at once. */
    private val onTaskCreated: (JsonObject) -> Unit = {},
    private val lane: CoroutineContext = Dispatchers.Default.limitedParallelism(1),
    private val now: () -> Long = System::currentTimeMillis,
    private val draftDebounceMillis: Long = 300,
    private val retryDelayMillis: Long = 600,
) {
    private class Outgoing(val id: String, val text: String, val images: List<Block.Image>, var accepted: Boolean = false, var failure: String? = null)

    private val _state = MutableStateFlow(
        ConversationState(created = newTask == null, loaded = newTask != null, draft = initialDraft, knownTitle = knownTitle),
    )
    val state: StateFlow<ConversationState> = _state.asStateFlow()

    private var snapshot = _state.value
    private val builder = ConversationRowBuilder()
    private val runs = ArrayList<Pair<String, MutableList<String>>>()
    private val messages = HashMap<String, Message>()
    private val pending = ArrayList<String>()
    private val outgoing = ArrayList<Outgoing>()
    private var agent: AgentInfo? = null
    private var mode: Mode? = null
    private var picked: Mode? = null
    private var catalog: ModeCatalog? = null
    private var catalogRead: Deferred<ModeCatalog>? = null
    private var activeRunStartedAt: Long? = null
    /** A run is going: from `run.started` until it finishes or the agent goes idle. */
    private var running = false
    private var visible = false

    private var following: Job? = null
    private var reading: Job? = null
    private var pumping: Job? = null
    private var creating: Deferred<Unit>? = null
    /** Events that came while history was read, applied after it. */
    private var held: MutableList<ConversationSignal.Event>? = null

    private var draft = initialDraft
    private var draftUpdatedAt = 0L
    private var draftSynced = initialDraft.isEmpty()
    private var draftRevision = 0
    private var draftSave: Job? = null

    private val created: Boolean get() = newTask == null

    fun start() {
        if (following != null) return
        following = scope.launch(lane) {
            // The picker's choices; a failure here is asked again when a send needs the default.
            launch { try { readCatalog() } catch (e: CancellationException) { throw e } catch (_: Exception) {} }
            if (created) reload()
            signals.collect { signal ->
                if (!created) return@collect
                when (signal) {
                    ConversationSignal.Resync -> reload()
                    is ConversationSignal.Event -> held?.add(signal) ?: receive(signal)
                }
            }
        }
    }

    /** The screen is up: what arrives is read. */
    fun setVisible(visible: Boolean) {
        scope.launch(lane) {
            this@Conversation.visible = visible
            if (visible && created && snapshot.loaded) markRead()
        }
    }

    /** Leaves: a draft waiting for the pause is saved now. */
    fun close() {
        scope.launch(lane) {
            if (!draftSynced && created) saveDraftNow()
            following?.cancel()
            reading?.cancel()
        }
    }

    // Reads

    /** History that could not be read, asked for again. */
    fun retryLoad() {
        scope.launch(lane) {
            if (!created) return@launch
            publish { it.copy(loaded = it.rows.isNotEmpty(), error = null) }
            reload()
        }
    }

    private fun reload() {
        reading?.cancel()
        if (held == null) held = ArrayList()
        reading = scope.launch(lane) {
            publish { it.copy(syncing = true) }
            try {
                // Their own scope: a failed read is this read's failure, not the conversation's.
                val (start, page) = coroutineScope {
                    val bootstrap = async { api.bootstrap(agentId) }
                    val messages = async { api.messages(agentId) }
                    bootstrap.await() to messages.await()
                }
                adopt(start, page)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val events = held.orEmpty()
                held = null
                events.forEach(::receive)
                publish { it.copy(loaded = true, syncing = false, error = describe(e)) }
            }
        }
    }

    private fun adopt(start: Bootstrap, page: MessagesPage) {
        agent = start.agent
        mode = picked ?: start.draft?.mode ?: start.mode ?: mode
        start.draft?.let { adoptDraft(it) }
        runs.clear()
        messages.clear()
        pending.clear()
        for (run in page.runs) {
            runs += run.id to run.messages.mapTo(ArrayList()) { it.id }
            run.messages.forEach { messages[it.id] = it }
        }
        for (message in start.pending) {
            messages[message.id] = message
            pending += message.id
        }
        outgoing.removeAll { it.id in messages }
        running = start.agent.isWorking
        activeRunStartedAt = page.runs.lastOrNull()?.takeIf { start.agent.isWorking && it.status == "running" }?.startedAt
        val events = held.orEmpty()
        held = null
        events.forEach(::receive)
        publish { it.copy(loaded = true, syncing = false, hasMore = page.hasMore, error = null) }
        if (start.agent.pendingQuestionId != null) readQuestion() else publish { it.copy(question = null) }
        if (visible) markRead()
    }

    /** Runs older than the first one shown. After a failure only [retry] (Retry) asks again. */
    fun loadOlder(retry: Boolean = false) {
        scope.launch(lane) {
            val first = runs.firstOrNull()?.first ?: return@launch
            if (!snapshot.hasMore || snapshot.loadingOlder || held != null || (snapshot.olderFailed && !retry)) return@launch
            publish { it.copy(loadingOlder = true, olderFailed = false) }
            try {
                val page = api.messages(agentId, before = first)
                if (runs.firstOrNull()?.first == first) {
                    val known = runs.mapTo(HashSet()) { it.first }
                    val older = page.runs.filter { it.id !in known }
                    runs.addAll(0, older.map { run -> run.id to run.messages.mapTo(ArrayList()) { it.id } })
                    older.forEach { run -> run.messages.forEach { messages[it.id] = it } }
                }
                publish { it.copy(loadingOlder = false, hasMore = page.hasMore) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                publish { it.copy(loadingOlder = false, olderFailed = true) }
            }
        }
    }

    private fun readQuestion() {
        scope.launch(lane) {
            val question = try {
                api.question(agentId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return@launch
            }
            publish { it.copy(question = question?.takeIf { q -> q.status == "pending" }) }
        }
    }

    // Events

    private fun receive(event: ConversationSignal.Event) {
        val payload = event.payload
        when (event.type) {
            "message.created", "message.updated" -> {
                val message = Message.parse(payload["message"]) ?: return
                messages[message.id] = message
                outgoing.removeAll { it.id == message.id }
                val runId = payload["runId"].str
                if (runId != null) place(message.id, runId)
                else if (message.id !in pending && runs.none { message.id in it.second }) pending += message.id
            }
            "message.delta" -> {
                val id = payload["messageId"].str ?: return
                val index = payload["blockIndex"].num?.toInt() ?: return
                val append = payload["append"].str ?: return
                val message = messages[id]
                val grown = message?.let { grow(it, index, payload["offset"].num?.toInt(), append) }
                if (grown == null) {
                    reconcileSoon()
                    return
                }
                messages[id] = grown
                payload["runId"].str?.let { place(id, it) }
            }
            "message.deleted" -> {
                val id = payload["messageId"].str ?: return
                messages.remove(id)
                pending.remove(id)
                runs.forEach { it.second.remove(id) }
            }
            "run.started" -> {
                val run = payload["run"].obj ?: return
                accept(payload["acceptedMessageIds"].strings(), run["id"].str ?: return)
                activeRunStartedAt = run["startedAt"].long
                running = true
            }
            "run.boundary" -> {
                val run = payload["startedRun"].obj ?: return
                accept(payload["acceptedMessageIds"].strings(), run["id"].str ?: return)
                activeRunStartedAt = run["startedAt"].long
                running = true
            }
            "run.finished" -> {
                activeRunStartedAt = null
                running = false
                agent = agent?.copy(status = "idle")
                if (visible) markRead()
            }
            "agent.updated" -> {
                val changes = payload["changes"].obj ?: return
                val before = agent?.pendingQuestionId
                agent = agent?.merge(changes)
                if (agent?.isWorking == false && "status" in changes) {
                    activeRunStartedAt = null
                    running = false
                }
                if ("pendingQuestionId" in changes) {
                    val now = changes["pendingQuestionId"].str
                    if (now == null) publish { it.copy(question = null) } else if (now != before) readQuestion()
                }
            }
            "question.created" -> {
                val question = Question.parse(payload["question"]) ?: return
                publish { it.copy(question = question.takeIf { q -> q.status == "pending" }) }
            }
            "question.updated" -> {
                val id = payload["questionId"].str ?: return
                val status = payload["changes"].obj?.get("status").str
                if (snapshot.question?.id == id && status != null && status != "pending") publish { it.copy(question = null) }
            }
            "agent.draft.updated" -> Draft.parse(payload["draft"])?.let(::adoptDraft)
            else -> return
        }
        publish()
    }

    private fun kotlinx.serialization.json.JsonElement?.strings(): List<String> = arr.orEmpty().mapNotNull { it.str }

    private fun place(messageId: String, runId: String) {
        pending.remove(messageId)
        val run = runs.firstOrNull { it.first == runId }
        if (run == null) runs += runId to arrayListOf(messageId)
        else if (messageId !in run.second) run.second += messageId
    }

    /** The accepted messages open their run, in the order they were taken. */
    private fun accept(ids: List<String>, runId: String) {
        val run = runs.firstOrNull { it.first == runId } ?: (runId to ArrayList<String>()).also { runs += it }
        run.second.addAll(0, ids.filter { it !in run.second })
        pending.removeAll(ids.toSet())
        for (id in ids) messages[id]?.let { messages[id] = it.copy(status = "accepted") }
    }

    private var reconciling: Job? = null

    /** History disagreed with an event: read again once things settle. */
    private fun reconcileSoon() {
        reconciling?.cancel()
        reconciling = scope.launch(lane) {
            delay(300)
            reload()
        }
    }

    // Sending

    /**
     * Draws the message at once and delivers it, after making the task on a
     * new chat's first send. False when there is nothing to send.
     */
    fun send(text: String, images: List<Block.Image> = emptyList()): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && images.isEmpty()) return false
        val id = ConversationApi.clientId()
        scope.launch(lane) {
            outgoing += Outgoing(id, trimmed, images)
            setDraftNow("")
            publish()
            pump()
        }
        return true
    }

    /**
     * [send] with the pictures in [files], read in order with the sends
     * around it. Pictures that can't be read send nothing: the words go
     * back to an empty composer and an alert says why.
     */
    fun send(text: String, files: List<File>, readPictures: (List<File>) -> List<Block.Image> = InlinePictures::read): Boolean {
        if (files.isEmpty()) return send(text)
        val trimmed = text.trim()
        val id = ConversationApi.clientId()
        scope.launch(lane) {
            val images = try {
                readPictures(files)
            } catch (e: Exception) {
                val restore = draft.isBlank() && trimmed.isNotEmpty()
                if (restore) setDraftNow(trimmed)
                publish { it.copy(draftArrivals = it.draftArrivals + if (restore) 1 else 0, alert = "Couldn't read the pictures to send.") }
                return@launch
            }
            outgoing += Outgoing(id, trimmed, images)
            setDraftNow("")
            publish()
            pump()
        }
        return true
    }

    /**
     * Puts [prefix] in the composer, ready for the person to finish: alone
     * when the draft is blank, above the draft (two newlines between)
     * otherwise, and not again when the draft already starts with it. The
     * cursor goes to the prefix's end and the composer takes focus. Only
     * this screen sees it: nothing is saved or sent until the person types.
     * Waits for history, so the agent's own draft is the one kept.
     */
    fun prefill(prefix: String) {
        scope.launch(lane) {
            if (prefix.isEmpty()) return@launch
            state.first { it.loaded }
            val next = when {
                draft.isBlank() -> prefix
                draft.startsWith(prefix) -> draft
                else -> prefix + "\n\n" + draft
            }
            val arrived = next != draft
            draft = next
            publish {
                it.copy(
                    draftArrivals = it.draftArrivals + if (arrived) 1 else 0,
                    composerFocus = ComposerFocus((it.composerFocus?.serial ?: 0) + 1, prefix.length),
                )
            }
        }
    }

    /** A failed send, queued again under the same id. */
    fun retrySend(id: String) {
        scope.launch(lane) {
            val send = outgoing.firstOrNull { it.id == id && it.failure != null } ?: return@launch
            send.failure = null
            publish()
            pump()
        }
    }

    /** Drops a failed send; its words go back to the composer when that is empty. */
    fun discardSend(id: String) {
        scope.launch(lane) {
            val send = outgoing.firstOrNull { it.id == id && it.failure != null } ?: return@launch
            outgoing.remove(send)
            if (draft.isBlank() && send.text.isNotEmpty()) {
                setDraftNow(send.text)
                publish { it.copy(draftArrivals = it.draftArrivals + 1) }
            } else {
                publish()
            }
        }
    }

    /** Delivers what waits, oldest first, one at a time. */
    private fun pump() {
        if (pumping?.isActive == true) return
        pumping = scope.launch(lane) {
            while (true) {
                val next = outgoing.firstOrNull { !it.accepted && it.failure == null } ?: break
                try {
                    ensureCreated()
                    val mode = sendingMode() ?: throw IllegalStateException("No model is set up on this computer.")
                    val message = withRetries { api.send(agentId, next.id, next.text, next.images, mode) }
                    next.accepted = true
                    if (message != null && message.id !in messages) {
                        messages[message.id] = message
                        if (message.runId != null) place(message.id, message.runId)
                        else if (message.id !in pending && runs.none { message.id in it.second }) pending += message.id
                        outgoing.remove(next)
                    }
                    if (activeRunStartedAt == null) activeRunStartedAt = now()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    next.failure = describe(e)
                }
                publish()
            }
        }
    }

    /** The task a new chat lives in, made once: a retry repeats the same ids, which is the same task. */
    private suspend fun ensureCreated() {
        val task = newTask ?: return
        val work = creating ?: scope.async(lane) {
            val made = withRetries { api.createTask(task) }
            newTask = null
            onTaskCreated(made)
            made["task"].obj?.get("agent")?.let(AgentInfo::parse)?.let { agent = it }
            publish { it.copy(created = true) }
            // Typed while it was made: that goes up now under the real agent.
            if (!draftSynced) saveDraftSoon(0)
            reload()
        }.also { creating = it }
        try {
            work.await()
        } finally {
            if (creating === work && !work.isActive) creating = null
        }
    }

    private suspend fun <T> withRetries(block: suspend () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!transient(e) || ++attempt >= 3) throw e
                delay(retryDelayMillis * attempt)
            }
        }
    }

    private suspend fun sendingMode(): Mode? {
        mode?.let { return it }
        val found = readCatalog().defaults
        // A pick made while the default was read wins.
        return mode ?: found?.also { mode = it; publish() }
    }

    /** The computer's models, read once; a failed read is asked again next time. */
    private suspend fun readCatalog(): ModeCatalog {
        catalog?.let { return it }
        val read = catalogRead ?: scope.async(lane) { api.catalog() }.also { catalogRead = it }
        val found = try {
            read.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            catalogRead = null
            throw e
        }
        if (catalog == null) {
            catalog = found
            publish()
        }
        return found
    }

    /**
     * The composer picked a model, effort or permission mode: the next
     * message runs with it, and it is kept with the draft at once, as
     * desktop keeps it, so another device opening this chat sees it.
     */
    fun setMode(next: Mode) {
        scope.launch(lane) {
            if (next == mode) return@launch
            picked = next
            mode = next
            publish()
            if (created) {
                draftUpdatedAt = maxOf(now(), draftUpdatedAt + 1)
                draftSynced = false
                draftRevision++
                saveDraftSoon(0)
            }
        }
    }

    /** Stops the running turn. */
    fun stop() {
        scope.launch(lane) {
            if (snapshot.stopping || !created) return@launch
            publish { it.copy(stopping = true) }
            try {
                api.abort(agentId)
                publish { it.copy(stopping = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                publish { it.copy(stopping = false, alert = describe(e)) }
            }
        }
    }

    /** Runs a failed turn again; the continued run comes as events. */
    fun retryFailure(messageId: String) {
        scope.launch(lane) {
            try {
                api.retry(agentId, messageId)?.let { messages[it.id] = it }
                publish()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                publish { it.copy(alert = describe(e)) }
            }
        }
    }

    /**
     * Answers the open question; first answer wins across devices. Throws
     * when it was not taken, so the form keeps its picks; one answered
     * elsewhere meanwhile just closes.
     */
    suspend fun answer(questionId: String, answers: Map<String, List<String>>) {
        withContext(lane) {
            if (snapshot.answering) return@withContext
            publish { it.copy(answering = true) }
            try {
                api.answer(agentId, questionId, answers)
                publish { it.copy(answering = false, question = it.question?.takeIf { q -> q.id != questionId }) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ConversationApiException) {
                // Answered elsewhere or no longer asked: what stands now is read again.
                publish { it.copy(answering = false) }
                if (e.status != 409) throw e
                readQuestion()
            } catch (e: Exception) {
                publish { it.copy(answering = false) }
                throw e
            }
        }
    }

    fun dismissAlert() {
        scope.launch(lane) { publish { it.copy(alert = null) } }
    }

    /** A tool's presented item, read whole. */
    suspend fun media(ref: MediaRef): ByteArray = api.media(agentId, ref.toolCallId, ref.index)

    private fun markRead() {
        if (!created) return
        scope.launch(lane) {
            try {
                api.markRead(agentId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Unread stays: the next read clears it.
            }
        }
    }

    // Draft

    /** Typed here: kept, and saved with the agent after the keystrokes pause (a clear at once). */
    fun setDraft(text: String) {
        scope.launch(lane) {
            if (text == draft) return@launch
            setDraftNow(text)
            publish()
        }
    }

    private fun setDraftNow(text: String) {
        draft = text
        draftUpdatedAt = maxOf(now(), draftUpdatedAt + 1)
        draftSynced = false
        draftRevision++
        if (created) saveDraftSoon(if (text.isEmpty()) 0 else draftDebounceMillis)
    }

    private fun saveDraftSoon(delayMillis: Long) {
        draftSave?.cancel()
        val revision = draftRevision
        draftSave = scope.launch(lane) {
            if (delayMillis > 0) delay(delayMillis)
            saveDraft(revision)
        }
    }

    private suspend fun saveDraftNow() {
        draftSave?.cancel()
        saveDraft(draftRevision)
    }

    private suspend fun saveDraft(revision: Int) {
        val text = draft
        val stamp = draftUpdatedAt
        try {
            val mode = sendingMode() ?: return
            val saved = api.saveDraft(agentId, text, mode, stamp)
            if (revision != draftRevision) return
            if ((saved?.updatedAt ?: 0) > stamp) saved?.let(::adoptDraft) else draftSynced = true
            publish()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Kept unsynced here: it goes on the next keystroke or when the screen leaves.
        }
    }

    /** The agent's copy of the draft: it replaces this phone's unless this phone's is newer. */
    private fun adoptDraft(remote: Draft) {
        val stamp = remote.updatedAt ?: 0
        val text = remote.text.orEmpty()
        if (stamp < draftUpdatedAt || (stamp == draftUpdatedAt && text == draft)) {
            if (stamp == draftUpdatedAt) draftSynced = true
            return
        }
        draftSave?.cancel()
        draftRevision++
        remote.mode?.let { picked?.let { _ -> picked = remote.mode }; mode = it }
        draftUpdatedAt = stamp
        draftSynced = true
        if (text != draft) {
            draft = text
            publish { it.copy(draftArrivals = it.draftArrivals + 1) }
        }
    }

    // Snapshot

    private inline fun publish(change: (ConversationState) -> ConversationState = { it }) {
        snapshot = derive(change(snapshot))
        _state.value = snapshot
    }

    private fun derive(base: ConversationState): ConversationState {
        val agent = agent
        val working = running || agent?.isWorking == true || outgoing.any { it.accepted }
        val parentAgentId = agent?.parentAgentId
        val rows = ArrayList<ConversationRow>()
        val lastRun = runs.lastOrNull()?.first
        for ((runId, ids) in runs) {
            val streaming = working && runId == lastRun
            for (id in ids) messages[id]?.let { rows += builder.rows(it, agentId, parentAgentId, streaming && it.role == "agent") }
        }
        for (id in pending) messages[id]?.let { rows += builder.rows(it, agentId, parentAgentId, false) }
        for (send in outgoing) {
            val delivery = send.failure?.let(Delivery::Failed) ?: if (send.accepted) Delivery.Pending else Delivery.Sending
            rows += ConversationRow.User("${send.id}:user", send.id, send.text, com.slopus.happy.chat.markdown.parseMarkdown(send.text), send.images, delivery)
        }
        builder.forget(messages.keys)
        val produced = lastRun != null && running &&
            runs.last().second.any { id -> messages[id]?.let { it.role == "agent" && it.content.isNotEmpty() } == true }
        val activity = when {
            base.question != null -> Activity.AwaitingAnswer
            !working -> if ((agent?.subagentsRunning ?: 0) > 0) Activity.Delegating else null
            !produced && agent?.status in setOf(null, "idle", "queued", "thinking") -> Activity.WaitingForModel
            agent?.status == "thinking" -> Activity.Thinking
            agent?.status == "generating_tools" -> Activity.PreparingTools
            agent?.status == "running_tools" -> Activity.RunningTools
            else -> Activity.Working
        }
        return base.copy(
            created = created,
            rows = rows.asReversed().toList(),
            agent = agent,
            mode = mode,
            catalog = catalog,
            working = working,
            activity = activity,
            draft = draft,
        )
    }

    companion object {
        /** A failure worth trying again: the agent unreachable, or the daemon's own fault. */
        fun transient(e: Exception): Boolean = when (e) {
            is AgentConnectionException -> e.reason == AgentConnectionException.Reason.Unavailable
            is ConversationApiException -> e.status >= 500
            else -> false
        }

        /** What a person reads for a failure. */
        fun describe(e: Exception): String = when (e) {
            is AgentConnectionException -> e.reason.message
            is ConversationApiException -> e.message?.takeIf { it.isNotBlank() } ?: "The agent refused this (${e.status})."
            else -> e.message?.takeIf { it.isNotBlank() } ?: "Something went wrong."
        }

        /**
         * `message.delta` applied exactly as the API says (offsets in UTF-16
         * units, which Kotlin strings are), or null where the message must
         * be read again.
         */
        fun grow(message: Message, index: Int, offset: Int?, append: String): Message? {
            val block = message.content.getOrNull(index) ?: return null
            val current = when (block) {
                is Block.Text -> block.text
                is Block.Reasoning -> block.text
                else -> return null
            }
            val at = offset ?: current.length
            if (current.length < at) return null
            val after = current.substring(at)
            val grown = when {
                after.isEmpty() -> current + append
                after.length >= append.length -> return if (after.startsWith(append)) message else null
                append.startsWith(after) -> current + append.substring(after.length)
                else -> return null
            }
            val content = message.content.toMutableList()
            content[index] = if (block is Block.Reasoning) Block.Reasoning(grown) else Block.Text(grown)
            return message.copy(content = content)
        }
    }
}
