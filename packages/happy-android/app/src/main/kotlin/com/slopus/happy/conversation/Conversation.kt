package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.attachments.AttachmentPreview
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
import kotlinx.coroutines.NonCancellable
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

/** A new chat before its first send has made it: what it will be, and whether it is being made now. */
@Immutable
data class NewWork(val choice: WorkChoice, val making: Boolean = false)

/** The composer's words and pictures went with the first message: [text] leaves the composer, unless edited since. */
@Immutable
data class ComposerTaken(val serial: Int, val text: String)

/** New work that could not be made: nothing was sent, and the composer keeps everything. */
@Immutable
data class WorkFailure(val kind: WorkKind, val reason: Problem)

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
    val error: Problem? = null,
    /** A refused action, shown once. */
    val alert: Problem? = null,
    /** What home calls this conversation, so the screen has its name before the computer is asked. */
    val knownTitle: String? = null,
    /** A new chat's Task or Bot and name; null once it is made. */
    val newWork: NewWork? = null,
    /** The first message took the composer's words and pictures. */
    val taken: ComposerTaken? = null,
    /** Why new work could not be made, shown once. */
    val workFailure: WorkFailure? = null,
) {
    val title: String? get() = agent?.title?.takeIf { it.isNotBlank() } ?: knownTitle?.takeIf { it.isNotBlank() }
    /** As the agent says ([AgentInfo.sendable]): an internal subagent, driven by its parent, or an archived chat takes no messages. */
    val canSend: Boolean get() = agent?.sendable != false
}

/**
 * One conversation with a paired agent (happy-ios `Conversation`): its
 * history read by run, the connection's events applied on top, sends drawn
 * at once and delivered in order under their own ids, the draft kept with
 * the agent, and the open question. A new chat is [newTask]: nothing is read
 * until its first send makes it, a task or a bot as [setChoice] last said,
 * under the same [agentId], so the screen becomes the real chat in place.
 * That first send waits in the composer while the work is made; a refusal
 * leaves it there ([ConversationState.workFailure]).
 *
 * Offline first: with a [keeper], the newest runs are kept on the phone
 * ([KeptConversation]) and shown as soon as the disk read returns; the agent
 * is then asked only for what came after the newest finished run.
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
    /** A new chat's Task or Bot and name, as last left. */
    initialChoice: WorkChoice = WorkChoice(),
    /** The answer to `POST /v0/tasks` or `/v0/bots`, so home lists it at once. */
    private val onTaskCreated: (JsonObject) -> Unit = {},
    private val lane: CoroutineContext = Dispatchers.Default.limitedParallelism(1),
    /** Where a send's files are read before they go up. */
    private val io: CoroutineContext = Dispatchers.IO,
    private val now: () -> Long = System::currentTimeMillis,
    private val draftDebounceMillis: Long = 300,
    private val retryDelayMillis: Long = 600,
    /** Where the newest history is kept on this phone; null keeps nothing. */
    private val keeper: ConversationKeeper? = null,
    /** Where [keeper] is read and written: never the main thread. */
    private val disk: CoroutineContext = Dispatchers.IO,
    private val keepDelayMillis: Long = 1_000,
    /** Lays out the rows' text on [lane] before each publish, so the screen only draws it; null leaves it to the screen. */
    private val typesetter: RowTypesetter? = null,
) {
    /**
     * A send on its way: the person's [text] and its [files] for the
     * workspace, pictures included; [shown] are those pictures read from the
     * phone's copies, drawn in the bubble while it goes but never sent.
     * [wire] is the text that goes, naming the files
     * ([WorkspaceUploads.text]), and the one drawn, so the message reads the
     * same before and after the computer has it.
     */
    private class Outgoing(
        val id: String,
        val text: String,
        val shown: List<Block.Image> = emptyList(),
        val files: List<OutgoingFile> = emptyList(),
        var accepted: Boolean = false,
        var failure: Problem? = null,
    ) {
        val wire: String = WorkspaceUploads.text(text, files)
    }

    private val _state = MutableStateFlow(
        ConversationState(
            created = newTask == null,
            loaded = newTask != null,
            draft = initialDraft,
            knownTitle = knownTitle,
            newWork = newTask?.let { NewWork(initialChoice) },
            // New work opens with the keyboard up, in its composer (iOS's focus with the push).
            composerFocus = newTask?.let { ComposerFocus(1, initialDraft.length) },
        ),
    )
    val state: StateFlow<ConversationState> = _state.asStateFlow()

    private var snapshot = _state.value
    private val builder = ConversationRowBuilder(typesetter = typesetter)
    private val runs = ArrayList<Pair<String, MutableList<String>>>()
    /** Each run's status and start as last read, so it is kept as it came. */
    private val runInfo = HashMap<String, Pair<String, Long?>>()
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
    private var observing = true
    private var closed = false

    private var following: Job? = null
    private var reading: Job? = null
    private var olderReading: Job? = null
    private var questionReading: Job? = null
    private var pumping: Job? = null
    private var creating: Deferred<Unit>? = null
    private var choice = initialChoice
    /** The first send is making the new work: the choice is fixed and another send waits. */
    private var making = false
    /** Events that came while history was read, applied after it. */
    private var held: MutableList<ConversationSignal.Event>? = null

    private var draft = initialDraft
    private var draftUpdatedAt = 0L
    private var draftSynced = initialDraft.isEmpty()
    private var draftRevision = 0
    private var draftSave: Job? = null

    private val created: Boolean get() = newTask == null

    fun start() {
        if (closed || !observing || following != null) return
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

    /**
     * A covered page keeps its rows but stops its own subscription and reads.
     * Revealing it catches up from the kept history anchor. Accepted sends,
     * uploads, task creation and draft writes are deliberately independent.
     */
    fun setObserving(value: Boolean) {
        scope.launch(lane) {
            if (closed || observing == value) return@launch
            observing = value
            if (value) start() else {
                visible = false
                following?.cancel()
                following = null
                reading?.cancel()
                reading = null
                olderReading?.cancel()
                questionReading?.cancel()
                reconciling?.cancel()
                held = null
                publish { it.copy(syncing = false, loadingOlder = false) }
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
            closed = true
            observing = false
            if (!draftSynced && created) saveDraftNow()
            keeping?.cancel()
            keepNow()
            following?.cancel()
            reading?.cancel()
            olderReading?.cancel()
            questionReading?.cancel()
            reconciling?.cancel()
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

    /** The kept history has been read from [keeper], or there was none to read. */
    private var restored = false

    /**
     * Catches up with the agent. The first read starts from what this phone
     * kept, shown as soon as the disk answers; then the agent is asked only
     * for what came after the newest finished run ([anchor]), not the whole
     * history again.
     */
    private fun reload() {
        if (!observing || closed) return
        reading?.cancel()
        if (held == null) held = ArrayList()
        reading = scope.launch(lane) {
            if (!restored) restore()
            publish { it.copy(syncing = true) }
            try {
                // Their own scope: a failed read is this read's failure, not the conversation's.
                val (start, read) = coroutineScope {
                    val bootstrap = async { api.bootstrap(agentId) }
                    val messages = async { readHistory() }
                    bootstrap.await() to messages.await()
                }
                adopt(start, read)
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

    /** What [readHistory] read: the newest page whole, or the runs after [anchor] to lay over the kept ones. */
    private class HistoryRead(val runs: List<Run>, val hasMore: Boolean, val anchor: String?)

    /**
     * The last message of the newest run that has finished, where a catch-up
     * starts (API.md `after`). The newest run may still be going, so it is
     * read whole again unless it is known to have finished.
     */
    private fun anchor(): String? {
        val finished = if (running || runInfo[runs.lastOrNull()?.first]?.first == "running") runs.dropLast(1) else runs
        return finished.lastOrNull { it.second.isNotEmpty() }?.second?.last()
    }

    private suspend fun readHistory(): HistoryRead {
        val anchor = anchor() ?: return api.messages(agentId).let { HistoryRead(it.runs, it.hasMore, null) }
        val runs = ArrayList<Run>()
        var after: String = anchor
        repeat(MAX_CATCH_UP_PAGES) {
            val page = try {
                api.messages(agentId, after = after)
            } catch (e: ConversationApiException) {
                // A daemon that can't read from a message: the newest page whole, as before.
                if (e.status != 400) throw e
                return api.messages(agentId).let { HistoryRead(it.runs, it.hasMore, null) }
            }
            // A daemon that ignored `after` sent the newest page, anchor and all: that is a whole read.
            if (page.runs.any { run -> run.messages.any { it.id == anchor } }) return HistoryRead(page.runs, page.hasMore, null)
            runs += page.runs
            val last = page.runs.lastOrNull { it.messages.isNotEmpty() }?.messages?.last()?.id
            if (!page.hasMore || last == null) return HistoryRead(runs, snapshot.hasMore, anchor)
            after = last
        }
        // Too far behind to catch up page by page: the newest page whole.
        return api.messages(agentId).let { HistoryRead(it.runs, it.hasMore, null) }
    }

    /** The kept history, read off the main thread and shown at once; the agent's answer follows. */
    private suspend fun restore() {
        val keeper = keeper ?: run { restored = true; return }
        val kept = try {
            withContext(disk) { KeptConversation.parse(keeper.read()) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        // Cancellation before the disk answered must allow a later restore.
        restored = true
        kept ?: return
        // Something came in while the disk was read: that is newer than what was kept.
        if (runs.isNotEmpty() || pending.isNotEmpty()) return
        for (run in kept.runs) putRun(run)
        for (message in kept.pending) {
            messages[message.id] = message
            pending += message.id
        }
        agent = agent ?: kept.agent
        mode = picked ?: mode ?: kept.mode
        publish { it.copy(loaded = true, hasMore = kept.hasMore) }
    }

    private fun putRun(run: Run) {
        runs += run.id to run.messages.mapTo(ArrayList()) { it.id }
        runInfo[run.id] = run.status to run.startedAt
        run.messages.forEach { messages[it.id] = it }
    }

    private fun adopt(start: Bootstrap, read: HistoryRead) {
        agent = start.agent
        mode = picked ?: start.draft?.mode ?: start.mode ?: mode
        start.draft?.let { adoptDraft(it) }
        val anchorRun = read.anchor?.let { id -> runs.indexOfFirst { id in it.second } }?.takeIf { it >= 0 }
        if (anchorRun != null) {
            // A catch-up: the runs after the anchor's are replaced by what the agent sent; those before stay.
            while (runs.size > anchorRun + 1) runInfo.remove(runs.removeAt(runs.size - 1).first)
            for (run in read.runs) {
                val known = runs.firstOrNull { it.first == run.id }
                if (known == null) {
                    putRun(run)
                } else {
                    val came = run.messages.map { it.id }
                    known.second.retainAll { it !in came }
                    known.second += came
                    runInfo[run.id] = run.status to run.startedAt
                    run.messages.forEach { messages[it.id] = it }
                }
            }
            val shown = runs.flatMapTo(HashSet()) { it.second }
            messages.keys.retainAll { it in shown }
        } else {
            runs.clear()
            runInfo.clear()
            messages.clear()
            read.runs.forEach(::putRun)
        }
        pending.clear()
        for (message in start.pending) {
            messages[message.id] = message
            pending += message.id
        }
        outgoing.removeAll { it.id in messages }
        running = start.agent.isWorking
        activeRunStartedAt = runs.lastOrNull()?.first?.let(runInfo::get)?.takeIf { start.agent.isWorking && it.first == "running" }?.second
        val events = held.orEmpty()
        held = null
        events.forEach(::receive)
        publish { it.copy(loaded = true, syncing = false, hasMore = read.hasMore, error = null) }
        if (start.agent.pendingQuestionId != null) readQuestion() else publish { it.copy(question = null) }
        if (visible) markRead()
        keepSoon()
    }

    private var keeping: Job? = null

    /** The history as it stands now goes to [keeper] after a pause; changes meanwhile go with it. */
    private fun keepSoon() {
        if (keeper == null || !created || keeping?.isActive == true) return
        keeping = scope.launch(lane) {
            delay(keepDelayMillis)
            keepNow()
        }
    }

    private suspend fun keepNow() {
        val keeper = keeper ?: return
        if (!created || !snapshot.loaded || runs.isEmpty() && pending.isEmpty()) return
        val newest = runs.takeLast(KeptConversation.KEPT_RUNS)
        val kept = KeptConversation(
            runs = newest.map { (id, ids) ->
                val (status, startedAt) = runInfo[id] ?: ("completed" to null)
                Run(id, status, startedAt, ids.mapNotNull(messages::get))
            },
            pending = pending.mapNotNull(messages::get),
            hasMore = snapshot.hasMore || newest.size < runs.size,
            agent = agent,
            mode = mode,
        )
        try {
            withContext(disk + NonCancellable) { keeper.write(kept.json()) }
        } catch (_: Exception) {
            // Kept next time; the agent still has it all.
        }
    }

    /** Runs older than the first one shown. After a failure only [retry] (Retry) asks again. */
    fun loadOlder(retry: Boolean = false) {
        scope.launch(lane) {
            if (!observing || olderReading?.isActive == true) return@launch
            val first = runs.firstOrNull()?.first ?: return@launch
            if (!snapshot.hasMore || snapshot.loadingOlder || held != null || (snapshot.olderFailed && !retry)) return@launch
            olderReading = launch {
            publish { it.copy(loadingOlder = true, olderFailed = false) }
            try {
                val page = api.messages(agentId, before = first)
                if (runs.firstOrNull()?.first == first) {
                    val known = runs.mapTo(HashSet()) { it.first }
                    val older = page.runs.filter { it.id !in known }
                    runs.addAll(0, older.map { run -> run.id to run.messages.mapTo(ArrayList()) { it.id } })
                    older.forEach { run -> runInfo[run.id] = run.status to run.startedAt }
                    older.forEach { run -> run.messages.forEach { messages[it.id] = it } }
                }
                publish { it.copy(loadingOlder = false, hasMore = page.hasMore) }
                keepSoon()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                publish { it.copy(loadingOlder = false, olderFailed = true) }
            }
            }
        }
    }

    private fun readQuestion() {
        if (!observing || closed) return
        questionReading?.cancel()
        questionReading = scope.launch(lane) {
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
                val placed = payload["runId"].str?.let { place(id, it) } == true
                // Words for a block that already streams in its row go to that row alone: no new state.
                if (!placed && builder.grow(grown, index)) {
                    keepSoon()
                    return
                }
            }
            "message.deleted" -> {
                val id = payload["messageId"].str ?: return
                messages.remove(id)
                pending.remove(id)
                runs.forEach { it.second.remove(id) }
            }
            "run.started" -> {
                val run = payload["run"].obj ?: return
                runs.lastOrNull()?.first?.let { last -> runInfo[last]?.let { runInfo[last] = "completed" to it.second } }
                accept(payload["acceptedMessageIds"].strings(), run["id"].str ?: return)
                activeRunStartedAt = run["startedAt"].long
                running = true
                runInfo[run["id"].str!!] = "running" to run["startedAt"].long
            }
            "run.boundary" -> {
                val run = payload["startedRun"].obj ?: return
                runs.lastOrNull()?.first?.let { last -> runInfo[last]?.let { runInfo[last] = "completed" to it.second } }
                accept(payload["acceptedMessageIds"].strings(), run["id"].str ?: return)
                activeRunStartedAt = run["startedAt"].long
                running = true
                runInfo[run["id"].str!!] = "running" to run["startedAt"].long
            }
            "run.finished" -> {
                runs.lastOrNull()?.first?.let { last -> runInfo[last] = "completed" to runInfo[last]?.second }
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
        keepSoon()
    }

    private fun kotlinx.serialization.json.JsonElement?.strings(): List<String> = arr.orEmpty().mapNotNull { it.str }

    /** Puts the message in its run; true when that moved it. */
    private fun place(messageId: String, runId: String): Boolean {
        var moved = pending.remove(messageId)
        val run = runs.firstOrNull { it.first == runId }
        if (run == null) {
            runs += runId to arrayListOf(messageId)
            moved = true
        } else if (messageId !in run.second) {
            run.second += messageId
            moved = true
        }
        return moved
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
        if (!observing || closed) return
        reconciling?.cancel()
        reconciling = scope.launch(lane) {
            delay(300)
            reload()
        }
    }

    // Sending

    /**
     * Draws the message at once and delivers it. False when there is nothing
     * to send, and on a new chat's first send, which waits in the composer
     * while the task or bot is made ([startWork]).
     */
    fun send(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return false
        if (!created) {
            startWork(ConversationApi.clientId(), trimmed, emptyList()) { emptyList() }
            return false
        }
        val id = ConversationApi.clientId()
        scope.launch(lane) {
            outgoing += Outgoing(id, trimmed)
            setDraftNow("")
            publish()
            pump()
        }
        return true
    }

    /**
     * [send] with [attachments] (staged copies on this phone): all of them
     * are written into the agent's workspace before the message goes, which
     * names their paths ([WorkspaceUploads]); the pictures the phone draws
     * are read, in order with the sends around it, to show while it goes.
     * Pictures that can't be read send nothing: the words go back to an
     * empty composer and an alert says why.
     */
    fun send(
        text: String,
        attachments: List<AttachmentPreview>,
        readPictures: (List<File>) -> List<Block.Image> = InlinePictures::read,
    ): Boolean {
        if (attachments.isEmpty()) return send(text)
        val trimmed = text.trim()
        val id = ConversationApi.clientId()
        val (drawn, files) = WorkspaceUploads.split(id, attachments)
        val pictures = drawn.map { WorkspaceUploads.localFile(it.uri) }
        if (!created) {
            startWork(id, trimmed, files) { if (pictures.isEmpty()) emptyList() else readPictures(pictures) }
            return false
        }
        scope.launch(lane) {
            val images = try {
                if (pictures.isEmpty()) emptyList() else readPictures(pictures)
            } catch (e: Exception) {
                val restore = draft.isBlank() && trimmed.isNotEmpty()
                if (restore) setDraftNow(trimmed)
                publish { it.copy(draftArrivals = it.draftArrivals + if (restore) 1 else 0, alert = Problem.PicturesUnreadable) }
                return@launch
            }
            outgoing += Outgoing(id, trimmed, images, files)
            setDraftNow("")
            publish()
            pump()
        }
        return true
    }

    /**
     * A new chat's first send (iOS's NewTask): the task or bot is made as
     * chosen, once, and only then does the message go, the composer giving
     * up its words and pictures ([ConversationState.taken]). Until then they
     * stay in the composer, and a refusal leaves them there and says why. A
     * send while it is being made is dropped, as the button can't send then.
     */
    private fun startWork(id: String, text: String, files: List<OutgoingFile>, pictures: () -> List<Block.Image>) {
        scope.launch(lane) {
            if (created || making) return@launch
            val images = try {
                pictures()
            } catch (e: Exception) {
                publish { it.copy(alert = Problem.PicturesUnreadable) }
                return@launch
            }
            val kind = choice.kind
            making = true
            publish()
            try {
                ensureCreated()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                making = false
                publish { it.copy(workFailure = WorkFailure(kind, describe(e))) }
                return@launch
            }
            making = false
            outgoing += Outgoing(id, text, images, files)
            setDraftNow("")
            publish { it.copy(taken = ComposerTaken((it.taken?.serial ?: 0) + 1, text)) }
            pump()
        }
    }

    /** A new chat's Task or Bot and name, as picked; fixed once its first send is making it. */
    fun setChoice(next: WorkChoice) {
        scope.launch(lane) {
            if (created || making || next == choice) return@launch
            choice = next
            publish()
        }
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
                    upload(next.files)
                    val message = withRetries { api.send(agentId, next.id, next.wire, emptyList(), mode) }
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

    /**
     * Writes a send's [files] into the agent's workspace, each once: a retry
     * skips what went up, and the same bytes again count as written. The
     * folder is kept out of git first, best effort.
     */
    private suspend fun upload(files: List<OutgoingFile>) {
        if (files.all { it.uploaded }) return
        val workspaceId = agent?.workspaceId
            ?: withRetries { api.bootstrap(agentId) }.agent.workspaceId
            ?: throw IllegalStateException("This chat has no folder on the computer to put files in.")
        api.ignoreUploads(workspaceId)
        for (file in files) {
            if (file.uploaded) continue
            val bytes = withContext(io) { file.file.readBytes() }
            withRetries { api.uploadFile(workspaceId, file.path, bytes) }
            file.uploaded = true
        }
    }

    /** The task or bot a new chat lives in, made once: a retry repeats the same ids, which is the same one. */
    private suspend fun ensureCreated() {
        val task = newTask ?: return
        val work = creating ?: scope.async(lane) {
            val made = withRetries { api.createWork(task, choice) }
            newTask = null
            onTaskCreated(made)
            (made["task"] ?: made["bot"]).obj?.get("agent")?.let(AgentInfo::parse)?.let { agent = it }
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
        scope.launch(lane) { publish { it.copy(alert = null, workFailure = null) } }
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
            rows += ConversationRow.User("${send.id}:user", send.id, send.wire, com.slopus.happy.chat.markdown.parseMarkdown(send.wire), send.shown, delivery)
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
        val newestFirst = rows.asReversed().toList()
        typesetter?.prepare(newestFirst)
        return base.copy(
            created = created,
            newWork = if (created) null else NewWork(choice, making),
            rows = newestFirst,
            agent = agent,
            mode = mode,
            catalog = catalog,
            working = working,
            activity = activity,
            draft = draft,
        )
    }

    companion object {
        /** Pages of catch-up read after the kept history before reading the newest page whole instead. */
        const val MAX_CATCH_UP_PAGES = 4

        /** A failure worth trying again: the agent unreachable, or the daemon's own fault. */
        fun transient(e: Exception): Boolean = when (e) {
            is AgentConnectionException -> e.reason == AgentConnectionException.Reason.Unavailable
            is ConversationApiException -> e.status >= 500
            else -> false
        }

        /** Why [e] happened, for the person: the agent's own words where it gave some. */
        fun describe(e: Exception): Problem = when (e) {
            is AgentConnectionException -> Problem.Link(e.reason)
            is ConversationApiException -> e.message?.takeIf { it.isNotBlank() }?.let(Problem::Said) ?: Problem.Refused(e.status)
            else -> e.message?.takeIf { it.isNotBlank() }?.let(Problem::Said) ?: Problem.Unknown
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
