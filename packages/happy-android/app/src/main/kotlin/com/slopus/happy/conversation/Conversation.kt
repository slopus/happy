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

/** A new chat before its first send has made it: what it will be, and whether a first message has fixed it ([locked]). */
@Immutable
data class NewWork(val choice: WorkChoice, val locked: Boolean = false)

/** A run's status, when it began and ended, and why it ended (`run.*` metadata). */
internal data class RunInfo(val status: String, val startedAt: Long?, val endedAt: Long? = null, val reason: String? = null) {
    companion object {
        fun of(run: Run) = RunInfo(run.status, run.startedAt, run.endedAt, run.reason)

        /** An event's run object; [status] where it says none. */
        fun of(run: JsonObject, status: String) = RunInfo(run["status"].str ?: status, run["startedAt"].long, run["endedAt"].long, run["reason"].str)
    }
}

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
    /** The slash commands the agent offers, in its order; empty until read, and where it offers none. */
    val commands: List<SlashCommand> = emptyList(),
    /** The provider's latest measurement of the conversation's context; null until one. */
    val context: ContextMeasurement? = null,
    val working: Boolean = false,
    val activity: Activity? = null,
    /** The composer's text as this conversation keeps it, and a count that moves only when it came from elsewhere. */
    val draft: String = "",
    val draftArrivals: Int = 0,
    /** The composer should take focus with its cursor here; a new value each time it's asked. */
    val composerFocus: ComposerFocus? = null,
    val question: Question? = null,
    val answering: Boolean = false,
    /** Why the last answer to [question] didn't go; it may go again. */
    val answerFailure: Problem? = null,
    val stopping: Boolean = false,
    /** Why history could not be read. */
    val error: Problem? = null,
    /** A refused action, shown once. */
    val alert: Problem? = null,
    /** What home calls this conversation, so the screen has its name before the computer is asked. */
    val knownTitle: String? = null,
    /** A new chat's Task or Bot and name; null once it is made. */
    val newWork: NewWork? = null,
    /** A send the agent hasn't taken yet: on its way (its files going up first) or failed. */
    val unsettledSends: Boolean = false,
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
 * That first send is drawn at once and the composer cleared; the work is
 * made behind it (iOS c344a0cb3), and a refusal leaves the message failed,
 * its Retry asking for the same work again under the same ids.
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
    /** Reads the chat: the connection's outbox, kept until the computer hears ([com.slopus.happy.agent.AgentSession.markRead]); null asks [api] once. */
    private val read: (suspend (String) -> Unit)? = null,
    /** What the Happy references in its messages read as ([AgentSession.references][com.slopus.happy.agent.AgentSession.references]); null leaves the tags as written. */
    private val references: com.slopus.happy.references.ReferenceReader? = null,
) {
    /**
     * A send on its way: the person's [text], its pictures inline and its
     * [files] for the workspace; [wire] is the text that goes, naming the
     * files ([WorkspaceUploads.text]), and the one drawn, so the message
     * reads the same before and after the computer has it.
     */
    private class Outgoing(
        val id: String,
        val text: String,
        /** Fewer once a picture is taken out on its way ([removePicture]). */
        var images: List<Block.Image>,
        val files: List<OutgoingFile> = emptyList(),
        /** A tool the agent runs before it reads this (a skill's `read_skill`). */
        val toolRequest: ToolRequest? = null,
        var accepted: Boolean = false,
        var failure: Problem? = null,
        val sentAt: Long,
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
    private val builder = ConversationRowBuilder(typesetter = typesetter).apply {
        references = this@Conversation.references?.references?.value
        named = this@Conversation.references?.let { reader -> reader::read }
        pages = this@Conversation.references?.let { reader -> reader::readArtifacts }
    }
    private val runs = ArrayList<Pair<String, MutableList<String>>>()
    /** Each run's status, start and end as last read, so it is kept as it came. */
    private val runInfo = HashMap<String, RunInfo>()
    /** Finished turns opened on their work ([toggleTurn]). */
    private val expanded = HashSet<String>()
    /** A person's long messages opened past their first lines ([toggleMessage]), by row key. */
    private val opened = HashSet<String>()
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
    /** Questions answered while this was open, as the computer took them: they settle in their turn before history says so. */
    private val answered = HashMap<String, Question>()
    private var pumping: Job? = null

    /** The send [pump] is writing now. */
    private var writing: String? = null

    /** Each outgoing picture's way to the computer, for the ring on its tile. */
    val uploads = UploadBoard()
    private var creating: Deferred<Unit>? = null
    private var choice = initialChoice
    /** A first message is in: the new work's choice is fixed. */
    private var locked = false
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
            // A title or name read, or a conversation renamed: the rows that name it read it so.
            references?.let { reader ->
                launch {
                    reader.references.collect { now ->
                        if (builder.references !== now) {
                            builder.references = now
                            publish()
                        }
                    }
                }
            }
            if (created) reload()
            signals.collect { signal ->
                // The computer's models changed, or may have while away: the pickers read them again.
                if (signal == ConversationSignal.Resync || (signal as? ConversationSignal.Event)?.type == "config.updated") rereadCatalog()
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
        val finished = if (running || runInfo[runs.lastOrNull()?.first]?.status == "running") runs.dropLast(1) else runs
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
        publish { it.copy(loaded = true, hasMore = kept.hasMore, commands = kept.slashCommands ?: it.commands) }
    }

    private fun putRun(run: Run) {
        runs += run.id to run.messages.mapTo(ArrayList()) { it.id }
        runInfo[run.id] = RunInfo.of(run)
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
                    runInfo[run.id] = RunInfo.of(run)
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
        outgoing.filter { it.id in messages }.forEach { uploads.clear(it.id) }
        outgoing.removeAll { it.id in messages }
        running = start.agent.isWorking
        activeRunStartedAt = runs.lastOrNull()?.first?.let(runInfo::get)?.takeIf { start.agent.isWorking && it.status == "running" }?.startedAt
        // Before what came while reading, which is newer.
        snapshot = snapshot.copy(context = start.context)
        val events = held.orEmpty()
        held = null
        events.forEach(::receive)
        publish { it.copy(loaded = true, syncing = false, hasMore = read.hasMore, error = null, commands = start.slashCommands ?: it.commands) }
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
                val info = runInfo[id] ?: RunInfo("completed", null)
                Run(id, info.status, info.startedAt, ids.mapNotNull(messages::get), info.endedAt, info.reason)
            },
            pending = pending.mapNotNull(messages::get),
            hasMore = snapshot.hasMore || newest.size < runs.size,
            agent = agent,
            mode = mode,
            slashCommands = snapshot.commands,
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
                    older.forEach { run -> runInfo[run.id] = RunInfo.of(run) }
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
            publish { it.copy(question = question?.takeIf { q -> q.status == "pending" }, answerFailure = null) }
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
                uploads.clear(message.id)
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
                runs.lastOrNull()?.first?.let { last -> runInfo[last]?.let { runInfo[last] = it.copy(status = "completed") } }
                accept(payload["acceptedMessageIds"].strings(), run["id"].str ?: return)
                activeRunStartedAt = run["startedAt"].long
                running = true
                runInfo[run["id"].str!!] = RunInfo.of(run, "running")
            }
            "run.boundary" -> {
                val run = payload["startedRun"].obj ?: return
                // The steered run ended: when, and why.
                finish(payload["finishedRun"].obj)
                accept(payload["acceptedMessageIds"].strings(), run["id"].str ?: return)
                activeRunStartedAt = run["startedAt"].long
                running = true
                runInfo[run["id"].str!!] = RunInfo.of(run, "running")
            }
            "run.finished" -> {
                finish(payload["run"].obj)
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
                    // One whose answer is on its way stays until the answer settles it.
                    if (now == null) { if (!snapshot.answering) publish { it.copy(question = null) } } else if (now != before) readQuestion()
                }
            }
            "question.created" -> {
                val question = Question.parse(payload["question"]) ?: return
                publish { it.copy(question = question.takeIf { q -> q.status == "pending" }, answerFailure = null) }
            }
            "question.updated" -> {
                val id = payload["questionId"].str ?: return
                val changes = payload["changes"].obj
                val status = changes?.get("status").str
                val current = snapshot.question
                if (current?.id == id && status != null && status != "pending") {
                    // Answered here or elsewhere: it settles in its turn, as answered.
                    if (status == "answered") answered[id] = current.copy(status = status, answers = changes?.get("answers").obj?.let(Question::answersOf) ?: current.answers)
                    publish { it.copy(question = null) }
                }
            }
            "agent.draft.updated" -> Draft.parse(payload["draft"])?.let(::adoptDraft)
            "agent.context.updated" -> {
                // A whole replacement; null clears it (a fresh conversation). Only the meter moves: no rows to derive.
                val value = payload["context"] ?: return
                val context = if (value is kotlinx.serialization.json.JsonNull) null else ContextMeasurement.parse(value) ?: return
                if (context == snapshot.context) return
                snapshot = snapshot.copy(context = context)
                _state.value = snapshot
                return
            }
            // The whole catalog, which replaces what was known.
            "agent.slash_commands.updated" -> {
                val commands = SlashCommand.parseAll(payload["slashCommands"]) ?: return
                publish { it.copy(commands = commands) }
            }
            else -> return
        }
        publish()
        keepSoon()
    }

    private fun kotlinx.serialization.json.JsonElement?.strings(): List<String> = arr.orEmpty().mapNotNull { it.str }

    /** A run ended, as [run] says, else the newest one: no longer running. */
    private fun finish(run: JsonObject?) {
        val id = run?.get("id").str ?: runs.lastOrNull()?.first ?: return
        runInfo[id] = run?.let { RunInfo.of(it, "completed") } ?: runInfo[id]?.copy(status = "completed") ?: RunInfo("completed", null)
    }

    /** Opens a finished turn on its work, or folds it again. */
    fun toggleTurn(turn: String) {
        scope.launch(lane) {
            if (!expanded.remove(turn)) expanded += turn
            publish()
        }
    }

    /** Opens a person's long message whole, or cuts it back to its first lines, by its row's key. */
    fun toggleMessage(key: String) {
        scope.launch(lane) {
            if (!opened.remove(key)) opened += key
            publish()
        }
    }

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
     * Draws the message at once and delivers it; false when there is nothing
     * to send. A new chat's messages go once its task or bot is made
     * ([ensureCreated], in [pump]); the first fixes what it will be.
     */
    fun send(text: String, images: List<Block.Image> = emptyList()): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && images.isEmpty()) return false
        val id = ConversationApi.clientId()
        scope.launch(lane) {
            if (!created) locked = true
            outgoing += Outgoing(id, trimmed, images, sentAt = now())
            setDraftNow("")
            publish()
            pump()
        }
        return true
    }

    /**
     * [send] with [attachments] (staged copies on this phone): pictures the
     * model reads go inline, read in order with the sends around it; the
     * rest are written into the agent's workspace before the message goes
     * ([WorkspaceUploads]). Pictures that can't be read send nothing: the
     * words go back to an empty composer and an alert says why.
     */
    fun send(
        text: String,
        attachments: List<AttachmentPreview>,
        readPictures: (List<File>) -> List<Block.Image> = InlinePictures::read,
    ): Boolean {
        if (attachments.isEmpty()) return send(text)
        val trimmed = text.trim()
        val id = ConversationApi.clientId()
        val (inline, files) = WorkspaceUploads.split(id, attachments)
        val pictures = inline.map { WorkspaceUploads.localFile(it.uri) }
        scope.launch(lane) {
            val images = try {
                if (pictures.isEmpty()) emptyList() else readPictures(pictures)
            } catch (e: Exception) {
                val restore = draft.isBlank() && trimmed.isNotEmpty()
                if (restore) setDraftNow(trimmed)
                publish { it.copy(draftArrivals = it.draftArrivals + if (restore) 1 else 0, alert = Problem.PicturesUnreadable) }
                return@launch
            }
            if (!created) locked = true
            outgoing += Outgoing(id, trimmed, images, files, sentAt = now())
            setDraftNow("")
            publish()
            pump()
        }
        return true
    }

    /**
     * Runs a slash command as desktop does: a skill goes as the person's
     * message, `/name` and its arguments, asking the agent to read the skill
     * first (`read_skill`, desktop aa8a2529); any other command runs on the
     * module that offers it, under the composer's mode, and what it does
     * comes as events. Its words are never sent as a message otherwise. The
     * draft that ran it is cleared; a refusal says why
     * ([Problem.CommandGone], [Problem.CommandBusy]).
     */
    fun runCommand(name: String, arguments: String?): Boolean {
        if (!created) return false
        scope.launch(lane) {
            val command = snapshot.commands.firstOrNull { it.name == name }
            if (command == null) {
                publish { it.copy(alert = Problem.CommandGone(name)) }
                return@launch
            }
            val given = arguments?.trim()?.takeIf { it.isNotEmpty() && command.hasArguments }
            setDraftNow("")
            if (command.isSkill) {
                val text = if (given == null) "/$name" else "/$name $given"
                outgoing += Outgoing(ConversationApi.clientId(), text, emptyList(), toolRequest = ToolRequest(READ_SKILL, mapOf("name" to name)), sentAt = now())
                publish()
                pump()
                return@launch
            }
            publish()
            try {
                val mode = sendingMode() ?: throw IllegalStateException("No model is set up on this computer.")
                val answer = withRetries { api.invokeCommand(agentId, name, given, mode) }
                answer.agent?.let { agent = it }
                publish { it.copy(commands = answer.slashCommands ?: it.commands) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ConversationApiException) {
                val problem = when (e.status) {
                    404 -> Problem.CommandGone(name)
                    409 -> Problem.CommandBusy(name)
                    else -> describe(e)
                }
                publish { it.copy(alert = problem) }
            } catch (e: Exception) {
                publish { it.copy(alert = describe(e)) }
            }
            keepSoon()
        }
        return true
    }

    /** A new chat's Task or Bot and name, as picked; fixed once its first message is in. */
    fun setChoice(next: WorkChoice) {
        scope.launch(lane) {
            if (created || locked || next == choice) return@launch
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
                writing = next.id
                try {
                    next.images.indices.forEach { uploads.set(UploadBoard.pictureKey(next.id, it), UploadPhase.Preparing) }
                    ensureCreated()
                    val mode = sendingMode() ?: throw IllegalStateException("No model is set up on this computer.")
                    upload(next.files)
                    val images = next.images
                    val message = withRetries {
                        // The bytes of each picture's base64 written say how far it is.
                        var ranges: UploadRanges? = null
                        val progress = com.slopus.happy.connection.BodyProgress { body, sent ->
                            val found = ranges ?: UploadRanges(body, images.map { it.data }).also { ranges = it }
                            found.shares(sent).forEachIndexed { index, share ->
                                uploads.set(UploadBoard.pictureKey(next.id, index), if (share >= 1f) UploadPhase.Done else UploadPhase.Uploading(share))
                            }
                        }
                        withContext(progress) { api.send(agentId, next.id, next.wire, images, mode, next.toolRequest) }
                    }
                    // All there, whatever the transport told on the way; the echo clears them.
                    images.indices.forEach { uploads.set(UploadBoard.pictureKey(next.id, it), UploadPhase.Done) }
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
                    uploads.clear(next.id)
                    next.failure = describe(e)
                } finally {
                    writing = null
                }
                publish()
            }
        }
    }

    /**
     * Takes picture [index] out of message [id] while it is still on its
     * way (iOS `removeAttachment`): what is being written stops and the rest
     * goes again under the same id; a message left with nothing is taken
     * back whole. A picture already all written stays.
     */
    fun removePicture(id: String, index: Int) {
        scope.launch(lane) {
            val send = outgoing.firstOrNull { it.id == id && !it.accepted } ?: return@launch
            if (index !in send.images.indices || uploads.phase(UploadBoard.pictureKey(id, index)) == UploadPhase.Done) return@launch
            // Nothing still writing sends the message as it was.
            pumping?.takeIf { it.isActive && writing == id }?.let {
                it.cancel()
                it.join()
            }
            if (send.accepted) return@launch pump()
            send.images = send.images.filterIndexed { i, _ -> i != index }
            // What is left starts again under its new keys.
            uploads.clear(id)
            if (send.text.isEmpty() && send.images.isEmpty() && send.files.isEmpty() && send.toolRequest == null) outgoing.remove(send)
            publish()
            pump()
        }
    }

    /**
     * Writes a send's [files] into the agent's workspace, each once: a retry
     * skips what went up, and the same bytes again count as written.
     */
    private suspend fun upload(files: List<OutgoingFile>) {
        if (files.all { it.uploaded }) return
        val workspaceId = agent?.workspaceId
            ?: withRetries { api.bootstrap(agentId) }.agent.workspaceId
            ?: throw IllegalStateException("This chat has no folder on the computer to put files in.")
        for (file in files) {
            if (file.uploaded) continue
            withRetries { api.uploadFile(workspaceId, file.path, file.file, io) }
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

    /** Reads the computer's models again (`config.updated`, a reconnect): hidden accounts and models, names, windows. */
    private fun rereadCatalog() {
        scope.launch(lane) {
            val found = try {
                api.catalog()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return@launch
            }
            catalogRead = null
            if (found != catalog) {
                catalog = found
                publish()
            }
        }
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
            val asked = snapshot.question?.takeIf { it.id == questionId }
            publish { it.copy(answering = true, answerFailure = null) }
            try {
                api.answer(agentId, questionId, answers)
                asked?.let { answered[questionId] = it.copy(status = "answered", answers = answers) }
                publish { it.copy(answering = false, question = it.question?.takeIf { q -> q.id != questionId }) }
            } catch (e: CancellationException) {
                publish { it.copy(answering = false) }
                throw e
            } catch (e: ConversationApiException) {
                // Answered elsewhere or no longer asked: what stands now is read again.
                if (e.status != 409) {
                    publish { it.copy(answering = false, answerFailure = describe(e)) }
                    throw e
                }
                publish { it.copy(answering = false) }
                readQuestion()
            } catch (e: Exception) {
                publish { it.copy(answering = false, answerFailure = describe(e)) }
                throw e
            }
        }
    }

    fun dismissAlert() {
        scope.launch(lane) { publish { it.copy(alert = null) } }
    }

    /** A tool's presented item, read whole. */
    suspend fun media(ref: MediaRef): ByteArray = api.media(agentId, ref.toolCallId, ref.index)

    /** The tool call [callId] as this conversation holds it now, and where it is in history; null where it holds none. */
    suspend fun toolCall(callId: String): LocatedCall? = withContext(lane) {
        fun inMessage(id: String) = (messages[id]?.content?.firstOrNull { it is Block.ToolCall && it.id == callId } as? Block.ToolCall)
        runs.forEachIndexed { index, (runId, ids) ->
            for (id in ids) inMessage(id)?.let { return@withContext LocatedCall(it, runId, runs.getOrNull(index + 1)?.first) }
        }
        pending.firstNotNullOfOrNull(::inMessage)?.let { LocatedCall(it, null, null) }
    }

    /** The tool call [callId] read whole from history, its raw data included; [located] finds its run at once. */
    suspend fun fullToolCall(callId: String, located: LocatedCall? = null): Block.ToolCall? =
        ToolCallReader(api, agentId).read(callId, located ?: toolCall(callId))

    private fun markRead() {
        if (!created) return
        scope.launch(lane) {
            try {
                read?.invoke(agentId) ?: api.markRead(agentId)
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

    /** Each sent message's time as its bubble first showed it, by message id (iOS's ChatPlanner times, 65f9eb1a0). */
    private val shownAt = HashMap<String, Long>()

    /** [rows] with a person's message keeping the time its send showed: the echo's stamp is the computer's. */
    private fun sentAt(rows: List<ConversationRow>): List<ConversationRow> {
        val user = rows.singleOrNull() as? ConversationRow.User ?: return rows
        val shown = shownAt[user.messageId] ?: return rows
        return if (shown == user.createdAt) rows else listOf(user.copy(createdAt = shown))
    }

    /**
     * [rows] with their questions where they stand (iOS 7f6355041): the one
     * [waiting] is pinned to the end instead, one answered here settles as
     * answered before its result is read, and one still asked with nothing
     * to show yet is left out. Others are tool rows.
     */
    private fun settled(rows: List<ConversationRow>, waiting: Question?): List<ConversationRow> {
        if (rows.none { it is ConversationRow.Ask || (it is ConversationRow.Tool && it.name == Question.TOOL_NAME) }) return rows
        return rows.mapNotNull { row ->
            when {
                row is ConversationRow.Ask -> row.takeIf { it.question.id != waiting?.id }
                row is ConversationRow.Tool && row.name == Question.TOOL_NAME && row.callId != null -> {
                    val settles = answered[row.callId]
                    when {
                        row.callId == waiting?.id -> null
                        settles != null -> ConversationRow.Ask(ConversationRowBuilder.askKey(row.callId), settles, AskPhase.Answered)
                        row.status == "running" -> null
                        else -> row
                    }
                }
                else -> row
            }
        }
    }

    private fun derive(base: ConversationState): ConversationState {
        val agent = agent
        val working = running || agent?.isWorking == true || outgoing.any { it.accepted }
        val parentAgentId = agent?.parentAgentId
        val rows = ArrayList<ConversationRow>()
        val lastRun = runs.lastOrNull()?.first
        val waiting = base.question
        for ((runId, ids) in runs) {
            val streaming = working && runId == lastRun
            val turn = ArrayList<ConversationRow>()
            var tools = 0
            for (id in ids) messages[id]?.let { message ->
                if (message.role == "agent") tools += message.content.count { it is Block.ToolCall }
                turn += settled(sentAt(builder.rows(message, agentId, parentAgentId, streaming && message.role == "agent")), waiting)
            }
            // Ended: how, after how long, and the answer to copy (desktop's `turnStatus`); then it folds.
            val info = runInfo[runId]
            val endedAt = info?.endedAt
            if (endedAt != null) {
                val at = turn.indexOfLast { it is ConversationRow.Text }
                val answer = (turn.getOrNull(at) as? ConversationRow.Text)?.text
                val ended = ConversationRow.TurnEnd(
                    key = "$runId:status",
                    turn = runId,
                    reason = info.reason ?: "completed",
                    durationMs = info.startedAt?.let { maxOf(0, endedAt - it) },
                    tools = tools,
                    copyText = answer,
                )
                // Its copy is how the turn ended, as desktop's: the answer keeps no button of its own.
                if (ended.complete && answer != null) turn[at] = (turn[at] as ConversationRow.Text).copy(copies = false)
                turn += ended
            }
            rows += TurnFold.fold(runId, turn, runId in expanded)
        }
        // A question waiting on the person is pinned to the end, under the work; a secret's form stays over the composer.
        if (waiting != null && waiting.secret == null) {
            val phase = when {
                base.answering -> AskPhase.Submitting
                base.answerFailure != null -> AskPhase.Failed(base.answerFailure)
                else -> AskPhase.Pending
            }
            rows += ConversationRow.Ask(ConversationRowBuilder.askKey(waiting.id), waiting, phase)
        }
        for (id in pending) messages[id]?.let { rows += sentAt(builder.rows(it, agentId, parentAgentId, false)) }
        for (send in outgoing) {
            val delivery = send.failure?.let(Delivery::Failed) ?: if (send.accepted) Delivery.Pending else Delivery.Sending
            val time = shownAt.getOrPut(send.id) { send.sentAt }
            rows += ConversationRow.User("${send.id}:user", send.id, send.wire, com.slopus.happy.chat.markdown.parseMarkdown(send.wire), send.images, delivery, time)
        }
        if (opened.isNotEmpty()) rows.replaceAll { if (it is ConversationRow.User && it.key in opened) it.copy(opened = true) else it }
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
            newWork = if (created) null else NewWork(choice, locked),
            rows = newestFirst,
            agent = agent,
            mode = mode,
            catalog = catalog,
            working = working,
            activity = activity,
            draft = draft,
            unsettledSends = outgoing.any { !it.accepted },
        )
    }

    companion object {
        /** The tool a skill's invocation asks the agent to run first. */
        const val READ_SKILL = "read_skill"

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
