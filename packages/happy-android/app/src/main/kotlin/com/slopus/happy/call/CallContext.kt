package com.slopus.happy.call

import com.slopus.happy.agent.OrderKey
import com.slopus.happy.conversation.ConversationApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.coroutines.CoroutineContext

/** What a call adds to the hosted agent's context as things change: JSON lines it reads without answering. Nothing here asks it to speak. */
data class CallUpdate(val context: List<String> = emptyList()) {
    val isEmpty: Boolean get() = context.isEmpty()
}

/**
 * How a `readConversation` of a conversation that wasn't current goes on ([CallContext.onReading], iOS
 * `CallReading`): the agent answered from what the phone had and was told it is refreshing; then what is new since,
 * as a cue to tell once the moment is right, or, nothing new or no answer in time, a line of context it reads without
 * answering.
 */
sealed interface CallReading {
    data object Refreshing : CallReading
    data class Update(val cue: CallCue) : CallReading
    data class Context(val line: String) : CallReading
}

/**
 * Lives only during one call, bound to one connection (iOS `CallContext`).
 * It owns the opaque references the hosted agent knows conversations by, the
 * focus, and the last four conversations visited or messaged during the
 * call, which are the ones it hears from; it runs the tools one at a
 * time. A followed conversation says only what its agent writes from then on,
 * each piece once it is complete and whole, and an error that stopped it:
 * never its words as they stream, its tools, its state or the person's
 * messages.
 *
 * The call starts with the directory: home's bots, tasks, subtasks and
 * project conversations, in its order and nesting, as plain lines that give
 * each its reference, in the first context. It never goes whole again: what
 * came, went, was renamed or moved since follows as a `directory` update of
 * just that ([directoryUpdate]). A reference is an order key ([OrderKey]):
 * sorted as text, references give home's order, and a conversation that
 * comes later gets one between its neighbours', so none ever changes. Updates
 * name a conversation by its title and what it sits under, and by its
 * reference too when that alone leaves it unclear or the agent hasn't had it
 * yet.
 *
 * All state lives on [lane], one coroutine at a time: like iOS's actor, a
 * wait inside a tool lets other changes in, so what was checked before a
 * wait is checked again after it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallContext(
    private val targets: CallTargets,
    private val now: () -> Long = System::currentTimeMillis,
    private val toolDeadlineMillis: Long = Limits.TOOL_DEADLINE_MS,
    /** The person's clock, which times are said in. */
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val lane: CoroutineContext = Dispatchers.Default.limitedParallelism(1),
    /** How long a read of a conversation that isn't current goes on making it current, after its answer. */
    private val refreshMillis: Long = Limits.REFRESH_MS,
) {
    object Limits {
        /**
         * The first context, and half of it a resync. The prompt's override goes
         * beside it in the call's first message, which the data channel takes up
         * to 64 KB (LiveKit).
         */
        const val TOTAL_BYTES = 32 * 1024
        /**
         * A read (`readConversation`), as it goes on the wire ([escapedSize]):
         * one escaped string in a data channel message, which LiveKit takes up
         * to 65,535 bytes (64,000 on iOS), its envelope beside it. A read pages
         * and cuts its messages by words ([CallRead]) within it.
         */
        const val READ_BYTES = 56 * 1024
        /**
         * Turns the first context shows, the person's message still waiting for an answer
         * counted as one: each the person's message and the agent's last
         * words, or as much of the pair as there is.
         */
        const val TURNS = 5
        /** One of the agent's messages in the first context and in updates: a thousand words of technical prose, Markdown and all (6.3 to 7.3 bytes a word in this repository's docs). */
        const val REPLY_BYTES = 8 * 1024
        /** One of the person's own, a third of that. */
        const val USER_BYTES = 2 * 1024
        const val ERROR_BYTES = 1024
        /** Conversations the first context lists, and its directory's size. */
        const val DIRECTORY = 100
        const val DIRECTORY_BYTES = 12 * 1024
        /** What one `directory` update tells at most, and its size. */
        const val DIRECTORY_CHANGES = 20
        const val DIRECTORY_UPDATE_BYTES = 4 * 1024
        /** How long home's changes settle before they go, from the first: "New Task" and the name it gets a moment later go as one. */
        const val SETTLE_MS = 1_000L
        const val PAGE = 50
        /** Conversations the call hears from: the last ones visited or messaged, the one on screen included. */
        const val VISITED = 4
        /** The agent's messages looked at per change, newest last. */
        const val MESSAGES = 20
        const val TEXT_BYTES = 8 * 1024
        const val TOOL_DEADLINE_MS = 8_000L
        /** How long a read of a conversation that isn't current goes on making it current, after its answer, before it is let go as unconfirmed. */
        const val REFRESH_MS = 8_000L
        /**
         * How long a read waits for what the phone keeps of a conversation it doesn't hold now (read from its store);
         * past that it goes as the directory has it, with no turns, and the refresh tells them.
         */
        const val KEPT_WAIT_MS = 500L
        /** Models a read or a refusal lists. */
        const val MODELS = 30
        /** What earlier calls said, in the first context ([CallHistory]), and each of its lines' words. */
        const val RECAP_BYTES = 8 * 1024
        const val SLOT_BYTES = 1024
    }

    private val scope = CoroutineScope(SupervisorJob() + lane)
    private val refs = HashMap<String, String>()
    private val agents = HashMap<String, String>()
    /** Every order key handed out this call, sorted: none is handed out twice. */
    private val keys = ArrayList<String>()
    private var focus: String? = null
    private var focusRevision = 0
    /** Newest first. */
    private val visited = ArrayList<String>()
    /** Home's conversations as last seen, in order and by ID. */
    private var entries: List<CallTarget> = emptyList()
    private var directory: Map<String, CallTarget> = emptyMap()
    /** The directory as the agent has it: from the first context, then as each `directory` update left it. */
    private var listed: List<Listing> = emptyList()
    /** The first context's, which nothing can lose. */
    private var first: List<Listing> = emptyList()
    private var begun = false
    /** Work home doesn't list until its first message makes it: what `message` started, or compose's in front. */
    private val drafts = HashMap<String, CallTarget>()
    /** The conversations whose reference the agent has: from the first context, `listConversations`, a tool's answer or an update. */
    private val told = HashSet<String>()
    /** New work `message` started, by the ID its first message went under: the same words again reach it, never a second one. */
    private val startedBy = HashMap<String, String>()
    private val heard = HashMap<String, Heard>()
    private var spoken = 0
    /**
     * Sends whose answer the agent may not have had, by target and text: the
     * same words to the same conversation again go under the same ID, which
     * the conversation takes once.
     */
    private val unsettled = HashMap<String, String>()
    private val settling = HashMap<String, String>()
    private val results = HashMap<String, Deferred<CallToolResult>>()
    private var tail: Job? = null
    private var closed = false
    private var restart: (suspend () -> CallToolResult)? = null
    /**
     * Conversations read while they weren't current, being made current: the refresh, what the agent was last given
     * of it, and the most words a message of it was read with. Another read of one joins its refresh.
     */
    private val reading = HashMap<String, Pending>()

    private class Pending(val refresh: Deferred<CallTargetState?>, var given: CallTargetState, var words: Int)

    /** Each conversation as its last refresh in this call found it, current then: what a read gives when the phone can't read it in time again. */
    private val refreshedLast = HashMap<String, CallTargetState>()
    private var onReading: ((CallReading) -> Unit)? = null

    /**
     * What the agent has of one visited conversation: its agent's complete
     * messages, those there when it was first seen counted as had, and the
     * errors it knows of.
     */
    private class Heard(
        val had: HashSet<String> = HashSet(),
        /** The messages this call told of, with the event that told it, in the order told. */
        val said: HashMap<String, Pair<Int, String>> = HashMap(),
        var errors: Set<String> = emptySet(),
        /** The errors this call told of, by turn, with the event that told it. */
        var told: Map<String, String> = emptyMap(),
    )

    /** A conversation as the agent's directory has it: what a rename or a move changes. */
    private data class Listing(
        val agentId: String,
        val title: String,
        val kind: CallTarget.Kind,
        /** What it sits under, by home's IDs. */
        val under: List<String>,
    ) {
        constructor(target: CallTarget) : this(target.agentId, target.title, target.kind, target.parents.map { it.agentId ?: it.id })
    }

    /** The conversations the call hears from now, the latest visited or messaged first. */
    suspend fun followed(): List<String> = withContext(lane) { visited.toList() }

    suspend fun close() = withContext(lane) {
        closed = true
        for (task in results.values) task.cancel()
        for (pending in reading.values) pending.refresh.cancel()
        reading.clear()
        scope.cancel()
    }

    /**
     * Where a read of a conversation that wasn't current goes on: that it went out `refreshing`, then what the refresh
     * found (`conversation_update`, `conversation_current`, `conversation_unconfirmed`). Nothing once the call has
     * ended.
     */
    suspend fun onReading(handler: (CallReading) -> Unit) = withContext(lane) { onReading = handler }

    /** What `navigate` to [RESTART_URL] does: the call's to say. */
    suspend fun onRestart(handler: suspend () -> CallToolResult) = withContext(lane) { restart = handler }

    // The first context

    /**
     * `initialConversationContext`, the hosted prompt's one variable, as plain
     * text: the time and focusRevision, what earlier calls said ([previous],
     * [CallHistory]), the conversation on screen with its last five turns and
     * the models it can switch to, the directory, how new work starts and
     * where `navigate` goes. Within [Limits.TOTAL_BYTES]: the older turns give
     * way first, then the directory's tail, then the recap's older lines
     * (nothing else has them), and the newest turn only after that. A new
     * conversation's: the agent has no reference yet. In a team, [person]
     * names who it talks to ([personText]).
     */
    suspend fun initial(previous: List<CallSlot> = emptyList(), person: String? = null): String = withContext(lane) {
        told.clear()
        see(targets.directory())
        listed = entries.map(::Listing)
        first = listed
        begun = true
        val focused = targets.focused()
        focus = focused
        var state: CallTargetState? = null
        if (focused != null) {
            visit(focused)
            if (directory[focused] == null) targets.unlisted(focused)?.let { drafts[focused] = it }
            state = targets.state(focused)?.also { if (heard[focused] == null) listen(it) }
        }
        val header = "Now: ${local(now(), zone)} (the person's local time)\nfocusRevision: $focusRevision" +
            person?.let { "\n" + personText(it) }.orEmpty()
        val turns = state?.let(::recent)?.toMutableList() ?: mutableListOf()
        var budget = Limits.DIRECTORY_BYTES
        var recapBudget = Limits.RECAP_BYTES
        val at = now()
        fun text(telling: Boolean = false): String =
            listOfNotNull(header, recap(previous, at, recapBudget), screen(state, turns), directoryText(budget, telling), NEW_WORK_TEXT, DESTINATIONS_TEXT)
                .joinToString("\n\n")
        while (text().utf8Size() > Limits.TOTAL_BYTES && turns.size > 1) turns.removeAt(0)
        while (text().utf8Size() > Limits.TOTAL_BYTES && budget > 512) budget /= 2
        while (text().utf8Size() > Limits.TOTAL_BYTES && recapBudget > 512) recapBudget /= 2
        while (text().utf8Size() > Limits.TOTAL_BYTES && turns.isNotEmpty()) turns.removeAt(0)
        focused?.let { told += it }
        text(telling = true)
    }

    /** The conversation on screen as the first context tells it: what `readConversation` reads of it, as lines. */
    private fun screen(state: CallTargetState?, turns: List<CallTurn>): String {
        val focused = focus
        if (state == null || focused == null) return "On screen: no conversation (home, Settings or another screen)."
        val target = state.target
        val lines = ArrayList<String>()
        lines += "On screen: ${target.title} — ${target.kind.wire}, ref ${ref(focused)}" +
            if (target.parents.isEmpty()) "" else ", under ${target.parents.joinToString(" > ") { it.title }}"
        lines += "Working: ${yes(state.working)}. Needs the person: ${yes(state.needsInput)}."
        state.messages.lastOrNull { it.role == CallMessage.Role.User && (it.time ?: 0L) > 0 }?.let { last ->
            lines += "Last message from ${last.by ?: "the person"}: ${said(last.time!!)}"
        }
        state.turns.filter { !it.reply.isNullOrEmpty() }.mapNotNull { it.endedAt }.filter { it > 0 }.maxOrNull()?.let { lines += "Last reply: ${said(it)}" }
        if (target.workspace.isNotEmpty()) lines += "Workspace: ${target.workspace.joinToString(" / ")}"
        state.mode?.let { lines += "Model: ${it.model}" + if (it.effort.isEmpty()) "" else ", effort ${it.effort}" }
        if (state.models.isNotEmpty()) {
            lines += "Models it can switch to:"
            for (model in state.models.take(Limits.MODELS)) {
                lines += "- ${model.name} — id ${model.id}" + if (model.efforts.isEmpty()) "" else ", efforts ${model.efforts.joinToString(", ")}"
            }
        }
        if (turns.isEmpty()) {
            lines += "No turns yet."
        } else {
            lines += "Last turns, oldest first:"
            turns.forEachIndexed { index, turn -> lines += turnText(turn, index + 1) }
        }
        if (state.hasMore || answering(state).size > turns.size) lines += "Older turns aren't shown."
        state.unanswered?.let { pending ->
            val text = clipped(pending.text, Limits.USER_BYTES)
            val delivery = when (pending.delivery) {
                CallMessage.Delivery.Queued -> ", still on this phone"
                CallMessage.Delivery.Failed -> ", which failed to send"
                else -> ""
            }
            lines += "Waiting for an answer, from ${pending.by ?: "the person"}$delivery:\n   " + indented(text)
        }
        return lines.joinToString("\n")
    }

    /** "5 minutes ago (2026-11-06T09:15:00+01:00)". */
    private fun said(millis: Long): String = "${ago((now() - millis) / 1000)} (${local(millis, zone)})"

    // What changes

    /**
     * Something on screen changed which conversation is in front. A
     * conversation becomes the latest visited; the fifth one back is no
     * longer heard from. Settings or home in front keep them all.
     */
    suspend fun focusChanged(agentId: String?): CallUpdate = withContext(lane) {
        if (closed || agentId == focus) return@withContext CallUpdate()
        // Newer than the directory as last seen: as home has it now.
        if (agentId != null && directory[agentId] == null) {
            see(targets.directory())
            if (directory[agentId] == null && drafts[agentId] == null) targets.unlisted(agentId)?.let { drafts[agentId] = it }
            if (closed || agentId == focus) return@withContext CallUpdate()
        }
        moveFocus(agentId)
    }

    /** The focus moves, by the person or by a tool. One the agent has no reference for yet comes with it. */
    private fun moveFocus(agentId: String?): CallUpdate {
        if (closed || agentId == focus) return CallUpdate()
        focus = agentId
        focusRevision += 1
        val event = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("focus"), "focusRevision" to JsonPrimitive(focusRevision), "title" to JsonNull)
        if (agentId != null) {
            visit(agentId)
            (directory[agentId] ?: drafts[agentId])?.let { event.putAll(address(it)) }
        }
        return CallUpdate(listOf(CallJson.encode(JsonObject(event))))
    }

    /**
     * One visited conversation's newest state. The first one the call sees
     * is what was there already, and says nothing; after it, each of its
     * agent's messages once it is complete ([CallMessage.final]), whole
     * (`assistant_text`), never while it grows; and a turn an error ended
     * (`session_error`). Nothing is told twice.
     */
    suspend fun targetChanged(state: CallTargetState): CallUpdate = withContext(lane) { changed(state) }

    private fun changed(state: CallTargetState): CallUpdate {
        val id = state.target.agentId
        // Gone from home: never told of again, and nothing about it goes.
        if (closed || id !in visited || directory[id] == null) return CallUpdate()
        val known = heard[id] ?: run {
            listen(state)
            return CallUpdate()
        }
        val address = address(state.target)
        val context = ArrayList<String>()
        val ended = state.turns.mapTo(HashSet()) { it.id }
        val last = HashMap<String, String>()
        for (message in state.messages) if (message.role == CallMessage.Role.Assistant) message.turn?.let { last[it] = message.id }
        for (message in state.messages.takeLast(Limits.MESSAGES)) {
            if (message.role != CallMessage.Role.Assistant || !message.final) continue
            if (message.id in known.had || message.text.isEmpty()) continue
            known.had += message.id
            val text = clipped(message.text, Limits.REPLY_BYTES)
            val event = LinkedHashMap(address)
            event["event"] = JsonPrimitive("assistant_text")
            event["text"] = JsonPrimitive(text)
            if (text != message.text) event["truncated"] = JsonPrimitive(true)
            // Its run is over and these were its last words.
            val turn = message.turn
            if (turn != null && turn in ended && last[turn] == message.id) event["finishedTurn"] = JsonPrimitive(true)
            val line = CallJson.encode(JsonObject(event))
            spoken += 1
            known.said[message.id] = spoken to line
            context += line
        }
        val toldErrors = known.told.toMutableMap()
        for (turn in state.turns) {
            if (turn.ended != "error" || turn.id in known.errors) continue
            val event = LinkedHashMap(address)
            event["event"] = JsonPrimitive("session_error")
            turn.error?.takeIf { it.isNotEmpty() }?.let { event["reason"] = JsonPrimitive(truncated(it, Limits.ERROR_BYTES)) }
            val line = CallJson.encode(JsonObject(event))
            toldErrors[turn.id] = line
            context += line
        }
        known.errors = state.turns.filter { it.ended == "error" }.mapTo(HashSet()) { it.id }
        known.told = toldErrors.filterKeys { it in known.errors }
        return CallUpdate(context)
    }

    /**
     * The context waiting for the call was too much and went unsent
     * ([CallSession.PENDING_BYTES]): what the agent now has wrong is put right
     * in one go. What home changed since the first context (`directory`), then
     * the focus, marked `resync`, with its reference, then the errors this
     * call told of and each message it told, as it told it, the most recent
     * kept first, within half of [Limits.TOTAL_BYTES]. What doesn't fit is
     * counted in `omitted`; a read (`readConversation`) has it. The first
     * context is the prompt's, never lost.
     */
    suspend fun resync(): CallUpdate = withContext(lane) {
        if (closed) return@withContext CallUpdate()
        val news = if (begun) news(first) else null
        val errors = ArrayList<String>()
        val streamed = ArrayList<Pair<Int, String>>()
        for (id in visited) {
            val known = heard[id] ?: continue
            streamed += known.said.values
            for (turn in known.told.keys.sorted()) errors += known.told.getValue(turn)
        }
        val items = errors + streamed.sortedByDescending { it.first }.map { it.second }
        val focusEvent = linkedMapOf<String, JsonElement>(
            "event" to JsonPrimitive("focus"),
            "focusRevision" to JsonPrimitive(focusRevision),
            "title" to JsonNull,
            "resync" to JsonPrimitive(true),
        )
        focus?.let { id -> directory[id] ?: drafts[id] }?.let { target ->
            focusEvent.putAll(address(target))
            focusEvent["ref"] = JsonPrimitive(ref(target.agentId))
        }
        val kept = ArrayList<String>()
        var bytes = CallJson.encode(JsonObject(focusEvent)).utf8Size() + 32 + (news?.utf8Size() ?: 0)
        for (item in items) {
            if (bytes + item.utf8Size() + 1 > Limits.TOTAL_BYTES / 2) continue
            kept += item
            bytes += item.utf8Size() + 1
        }
        if (kept.size < items.size) focusEvent["omitted"] = JsonPrimitive(items.size - kept.size)
        // Oldest first, as they would have come.
        val errorCount = kept.takeWhile { it in errors }.size
        CallUpdate(listOfNotNull(news) + CallJson.encode(JsonObject(focusEvent)) + kept.take(errorCount) + kept.drop(errorCount).reversed())
    }

    // The directory

    /** Home's conversations, as just read, once each (the first wins), each with its reference. */
    private fun see(now: List<CallTarget>) {
        val byId = LinkedHashMap<String, CallTarget>()
        for (entry in now) byId.putIfAbsent(entry.agentId, entry)
        entries = byId.values.toList()
        directory = byId
        // Made by its first message: home's from now on.
        drafts.keys.removeAll { it in byId }
        place(entries)
    }

    /**
     * Home changed, maybe only a status. True when the agent's directory is no
     * longer what it lists: a conversation came, went, was renamed or moved.
     * [directoryUpdate] is due then, once [Limits.SETTLE_MS] has passed since
     * the first such change ([DirectorySettle]).
     */
    suspend fun directoryChanged(now: List<CallTarget>): Boolean = withContext(lane) {
        if (closed || !begun) return@withContext false
        see(now)
        entries.map(::Listing) != listed
    }

    /** Home read again, and what changed since the agent's directory was last put right: one `directory` event, or nothing. Never the whole directory again. */
    suspend fun directoryUpdate(): CallUpdate = withContext(lane) {
        if (closed || !begun) return@withContext CallUpdate()
        val now = targets.directory()
        if (closed) return@withContext CallUpdate()
        see(now)
        CallUpdate(listOfNotNull(news(listed)))
    }

    /**
     * The `directory` event that brings the agent's directory, as it was at
     * [before], to home as last seen; null when nothing came and nothing the
     * agent was told of changed. `added`: what came, each with its reference,
     * title, kind and the titles it sits under, and `after` (the reference of
     * what it follows on home, null for the first) only when its reference
     * doesn't sort between its neighbours'. `removed`: the references of what
     * went. `renamed`: a new title. `moved`: where one sits now, `after` and
     * its `parents`, its reference unchanged; what kept its order among the
     * rest (the longest run, [kept]) didn't move. Each in home's order, at most
     * [Limits.DIRECTORY_CHANGES] in all within [Limits.DIRECTORY_UPDATE_BYTES],
     * the rest counted in `more`.
     */
    private fun news(before: List<Listing>): String? {
        val now = entries
        listed = now.map(::Listing)
        val was = HashMap<String, IndexedValue<Listing>>()
        before.forEachIndexed { at, listing -> was.putIfAbsent(listing.agentId, IndexedValue(at, listing)) }
        fun key(index: Int): String? = now.getOrNull(index)?.let { ref(it.agentId).drop(1) }
        fun after(index: Int): JsonElement = if (index > 0) JsonPrimitive(ref(now[index - 1].agentId)) else JsonNull
        val added = ArrayList<Pair<String, JsonObject>>()
        val common = ArrayList<Pair<Int, Int>>()
        now.forEachIndexed { index, entry ->
            val old = was[entry.agentId]
            if (old != null) {
                common += index to old.index
                return@forEachIndexed
            }
            val value = linkedMapOf<String, JsonElement>(
                "ref" to JsonPrimitive(ref(entry.agentId)), "title" to JsonPrimitive(entry.title), "kind" to JsonPrimitive(entry.kind.wire),
            )
            if (entry.parents.isNotEmpty()) value["parents"] = JsonArray(entry.parents.map { JsonPrimitive(it.title) })
            // Sorted by its reference it would sit elsewhere: new work the call started before home had it, or one
            // placed by a moved neighbour.
            val own = key(index)!!
            if (key(index - 1)?.let { it >= own } == true || key(index + 1)?.let { it <= own } == true) value["after"] = after(index)
            added += entry.agentId to JsonObject(value)
        }
        val steady = kept(common.map { it.second })
        val renamed = ArrayList<JsonObject>()
        val moved = ArrayList<JsonObject>()
        common.forEachIndexed { position, (index, _) ->
            val entry = now[index]
            val old = was[entry.agentId]?.value
            if (entry.agentId !in told || old == null) return@forEachIndexed
            val listing = Listing(entry)
            if (listing.title != old.title) renamed += JsonObject(mapOf("ref" to JsonPrimitive(ref(entry.agentId)), "title" to JsonPrimitive(entry.title)))
            if (position !in steady || listing.under != old.under || listing.kind != old.kind) {
                val value = linkedMapOf<String, JsonElement>(
                    "ref" to JsonPrimitive(ref(entry.agentId)), "after" to after(index),
                    "parents" to JsonArray(entry.parents.map { JsonPrimitive(it.title) }),
                )
                if (listing.kind != old.kind) value["kind"] = JsonPrimitive(entry.kind.wire)
                moved += JsonObject(value)
            }
        }
        val ids = now.mapTo(HashSet()) { it.agentId }
        val removed = before.filter { it.agentId !in ids && it.agentId in told }.map { it.agentId }
        val total = added.size + removed.size + renamed.size + moved.size
        if (total == 0) return null
        val event = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("directory"))
        var taken = 0
        // Room for `more` is kept.
        fun fits(item: JsonElement, list: String): Boolean {
            if (taken >= Limits.DIRECTORY_CHANGES) return false
            val next = LinkedHashMap(event)
            next[list] = JsonArray(((next[list] as? JsonArray) ?: JsonArray(emptyList())) + item)
            if (CallJson.encode(JsonObject(next)).utf8Size() + 16 > Limits.DIRECTORY_UPDATE_BYTES) return false
            event.putAll(next)
            taken += 1
            return true
        }
        for ((agentId, value) in added) if (fits(value, "added")) told += agentId
        // Still told: a resync tells it again, and back, it is added.
        for (agentId in removed) fits(JsonPrimitive(ref(agentId)), "removed")
        for (item in renamed) fits(item, "renamed")
        for (item in moved) fits(item, "moved")
        if (taken < total) event["more"] = JsonPrimitive(total - taken)
        return CallJson.encode(JsonObject(event))
    }

    /**
     * The directory as the first context has it: a line for each
     * conversation, indented under what it sits in, with its kind and
     * reference; a project or a worktree a line without one. Within [bytes]
     * and [Limits.DIRECTORY] conversations, the rest counted at the end.
     * [telling] marks each one shown as told.
     */
    private fun directoryText(bytes: Int, telling: Boolean): String {
        val marker = 96
        val all = lines(entries, "Conversations in the app, in the sidebar's order:", bytes - marker, Limits.DIRECTORY)
        var text = all.text
        val omitted = entries.size - all.taken
        if (entries.isEmpty()) text += "\nNone yet."
        if (omitted > 0) text += "\n… and $omitted more; listConversations finds them by title."
        if (telling) told += all.shown
        return text
    }

    private class Lines(val text: String, val shown: List<String>, val taken: Int)

    /**
     * [list] as indented lines under [header], as many as fit, each with
     * whatever it sits under that the lines before didn't show. The
     * conversations shown, the ones they sit under included, by ID; the
     * first [count] of [list] at most.
     */
    private fun lines(list: List<CallTarget>, header: String, bytes: Int, count: Int): Lines {
        var text = header
        var path = emptyList<String>()
        val shown = ArrayList<String>()
        var taken = 0
        for (entry in list) {
            if (taken >= count) break
            val keys = entry.parents.map { it.agentId ?: it.id }
            val common = path.zip(keys).takeWhile { (a, b) -> a == b }.size
            var chunk = StringBuilder()
            var under = ArrayList<String>()
            var flat = false
            entry.parents.forEachIndexed { depth, parent ->
                if (depth < common) return@forEachIndexed
                val indent = "  ".repeat(depth)
                if (parent.agentId != null) {
                    chunk.append("\n$indent- ${parent.title} — ${parent.kind}, ref ${ref(parent.agentId)}")
                    under += parent.agentId
                } else {
                    chunk.append("\n$indent- ${parent.title} — ${parent.kind}")
                }
            }
            val line = "- ${entry.title} — ${entry.kind.wire}, ref ${ref(entry.agentId)}"
            chunk.append("\n${"  ".repeat(entry.parents.size)}$line")
            if (taken == 0 && text.utf8Size() + chunk.toString().utf8Size() > bytes) {
                flat = true
                // What it sits under too deep for the lines: on one of its own, cut to fit, the entry under it unindented.
                val room = (bytes - text.utf8Size() - line.utf8Size() - 16).coerceAtLeast(0)
                val trail = truncated(entry.parents.joinToString(" > ") { it.title }, room)
                chunk = StringBuilder("\n(under $trail)\n$line")
                under = ArrayList()
            }
            if (text.utf8Size() + chunk.toString().utf8Size() > bytes) break
            text += chunk
            // Lines after a flat one show what they sit under again.
            path = if (flat) emptyList() else keys + entry.agentId
            shown += under
            shown += entry.agentId
            taken += 1
        }
        return Lines(text, shown, taken)
    }

    /**
     * How updates name a conversation: its title and the titles of what it
     * sits under, outermost first. Its reference too when those leave it
     * unclear (another one is named the same under the same, or it has no
     * name of its own yet, "New Task"), or the agent has none for it.
     */
    private fun address(target: CallTarget): LinkedHashMap<String, JsonElement> {
        val parents = target.parents.map { it.title }
        val value = linkedMapOf<String, JsonElement>("title" to JsonPrimitive(target.title), "parents" to JsonArray(parents.map(::JsonPrimitive)))
        val twins = entries.count { it.title == target.title && it.parents.map { parent -> parent.title } == parents }
        if (twins > 1 || target.title in CallTarget.placeholders || target.agentId !in told) {
            value["ref"] = JsonPrimitive(ref(target.agentId))
            told += target.agentId
        }
        return value
    }

    // Tools

    /** Runs one tool call after the ones before it. The same call ID again (the provider retrying) gets the first answer, never a second run. */
    suspend fun handle(call: CallToolCall): CallToolResult {
        val task = withContext(lane) {
            results[call.id] ?: run {
                if (closed) return@withContext null
                val previous = tail
                scope.async(start = CoroutineStart.LAZY) {
                    previous?.join()
                    run(call)
                }.also { task ->
                    results[call.id] = task
                    tail = task
                    task.start()
                }
            }
        } ?: return CallToolResult.refused("The call has ended.")
        return try {
            task.await()
        } catch (_: kotlinx.coroutines.CancellationException) {
            CallToolResult.refused("The call has ended.")
        }
    }

    private suspend fun run(call: CallToolCall): CallToolResult {
        if (closed) return CallToolResult.refused("The call has ended.")
        val tool = CallTool.of(call.name) ?: return CallToolResult.refused("Unknown tool.")
        val timeout = if (tool == CallTool.Message) {
            CallToolResult.json(JsonObject(mapOf(
                "status" to JsonPrimitive("uncertain"),
                "reason" to JsonPrimitive("No answer in time. Don't send it again; say it may not have gone."),
            )), isError = true)
        } else {
            CallToolResult.refused("No answer in time.")
        }
        // Not waited for once the time is up: it is cancelled, and what it still does finishes on its own.
        val work = scope.async { execute(tool, call.parameters, call.id) }
        val answered = withTimeoutOrNull(toolDeadlineMillis) { work.await() }
        if (answered == null) work.cancel()
        // A send the agent heard the answer to is settled; one it didn't keeps its ID for the same words again.
        settling.remove(call.id)?.let { key -> if (answered != null) unsettled.remove(key) }
        return answered ?: timeout
    }

    private suspend fun execute(tool: CallTool, arguments: JsonObject, call: String): CallToolResult {
        return when (tool) {
            CallTool.ListConversations -> {
                val query = optionalString(arguments["query"]) ?: return CallToolResult.refused("query must be a string.")
                val cursor = optionalString(arguments["cursor"]) ?: return CallToolResult.refused("cursor must be a string.")
                val needle = query.trim().lowercase()
                val start = (if (cursor.isEmpty()) 0 else cursor.toIntOrNull())?.takeIf { it >= 0 }
                    ?: return CallToolResult.refused("That isn't a cursor listConversations gave.")
                see(targets.directory())
                val matching = if (needle.isEmpty()) entries else entries.filter { needle in it.title.lowercase() }
                val page = matching.drop(start).take(Limits.PAGE)
                // A directory query: what it gives, the agent has.
                told += page.map { it.agentId }
                val value = linkedMapOf<String, JsonElement>("conversations" to JsonArray(page.map(::row)), "now" to JsonPrimitive(local(now(), zone)))
                if (start + page.size < matching.size) value["nextCursor"] = JsonPrimitive((start + page.size).toString())
                CallToolResult.json(JsonObject(value))
            }

            CallTool.ReadConversation -> {
                unmade(arguments["ref"])?.let { return it }
                val id = resolve(arguments["ref"]) ?: return CallToolResult.refused("No such conversation.")
                val (request, refusal) = CallRead.request(arguments)
                if (request == null) return CallToolResult.refused(refusal ?: "")
                // What the phone has, at once: current, it is the read; not, it goes as it is, marked, and is made
                // current behind it, as opening it would, what that finds told after.
                val kept = scope.async { targets.state(id) }
                val found = withTimeoutOrNull(Limits.KEPT_WAIT_MS) { Arrived(kept.await()) }
                val entry = directory[id] ?: drafts[id]
                val state = when {
                    found != null -> found.state ?: return CallToolResult.refused("That conversation can't be read now.")
                    refreshedLast[id] != null -> refreshedLast.getValue(id).copy(fresh = false)
                    entry != null -> CallTargetState(entry, working = entry.status == CallTarget.Status.Running,
                        needsInput = entry.status == CallTarget.Status.NeedsInput, fresh = false)
                    else -> return CallToolResult.refused("That conversation can't be read now.")
                }
                val value = read(state, request)
                if ((value["ok"] as? JsonPrimitive)?.booleanOrNull == false) return CallToolResult.json(value, isError = true)
                if (state.fresh) return CallToolResult.json(value)
                if (closed) return CallToolResult.refused("The call has ended.")
                val pending = reading[id]
                if (pending != null) {
                    // One on its way already: this read joins it.
                    pending.given = state
                    pending.words = maxOf(pending.words, request.words)
                } else {
                    val refresh = scope.async { targets.refreshed(id, refreshMillis) }
                    reading[id] = Pending(refresh, state, request.words)
                    scope.launch {
                        val current = try { refresh.await() } catch (_: kotlinx.coroutines.CancellationException) { return@launch }
                        refreshed(id, current)
                    }
                }
                onReading?.invoke(CallReading.Refreshing)
                CallToolResult.json(value)
            }

            CallTool.Message -> message(arguments, call)

            CallTool.Navigate -> {
                val url = arguments.string("to")
                val destination = url?.let { CallContext.destination(it) } ?: return CallToolResult.json(JsonObject(mapOf(
                    "ok" to JsonPrimitive(false),
                    "reason" to JsonPrimitive("${url?.let { "\"$it\"" } ?: "That"} isn't a destination. to is one of: ${DESTINATIONS.joinToString(", ")}."),
                    "destinations" to JsonArray(DESTINATIONS.map { JsonPrimitive(it) }),
                )), isError = true)
                // Home is home from wherever the screen is; the others are moves from the screen the agent last saw,
                // refused once it changed.
                when (destination) {
                    Destination.Restart -> {
                        val restart = restart
                        if (restart == null || closed) CallToolResult.refused("The call can't restart now.") else restart()
                    }
                    is Destination.Conversation -> {
                        unmade(JsonPrimitive(destination.ref))?.let { return it }
                        val id = resolve(destination.ref) ?: return CallToolResult.refused("No such conversation.")
                        if (revisionOf(arguments["focusRevision"]) != focusRevision) return STALE
                        // Past its deadline the answer is gone: nothing moves on screen after it.
                        if (closed) return CallToolResult.refused("No answer in time.")
                        if (!targets.open(id)) return CallToolResult.refused("It didn't open.")
                        // In front now as far as the call goes, with the revision the next step takes. The screen says so
                        // too; whichever of the two comes second says nothing.
                        moveFocus(id)
                        CallToolResult.json(JsonObject(mapOf(
                            "opened" to JsonPrimitive(true), "ref" to JsonPrimitive(ref(id)), "focusRevision" to JsonPrimitive(focusRevision),
                        )))
                    }
                    Destination.Back, Destination.Home -> {
                        if (destination == Destination.Back && revisionOf(arguments["focusRevision"]) != focusRevision) return STALE
                        if (closed) return CallToolResult.refused("No answer in time.")
                        when (val moved = if (destination == Destination.Back) targets.back() else targets.home()) {
                            is CallScreenMove.Refused -> CallToolResult.refused(moved.reason)
                            is CallScreenMove.Moved -> {
                                // Where it landed is the focus now; the screen says so too, and whichever of the two comes second says nothing.
                                val landed = shown()
                                moveFocus(landed)
                                val value = linkedMapOf<String, JsonElement>(
                                    "home" to JsonPrimitive(moved.atHome), "focusRevision" to JsonPrimitive(focusRevision), "title" to JsonNull,
                                )
                                val entry = landed?.let { directory[it] ?: drafts[it] }
                                if (entry != null) {
                                    value.putAll(address(entry))
                                    value["ref"] = JsonPrimitive(ref(entry.agentId))
                                    told += entry.agentId
                                }
                                CallToolResult.json(JsonObject(value))
                            }
                        }
                    }
                }
            }
        }
    }

    /** The conversation on screen as the app has it now, known to the call: a draft compose made since is one of its drafts. */
    private suspend fun shown(): String? {
        val shown = targets.focused()
        if (shown != null && directory[shown] == null && drafts[shown] == null) {
            see(targets.directory())
            if (directory[shown] == null) targets.unlisted(shown)?.let { drafts[shown] = it }
        }
        return shown
    }

    /**
     * `message`: `text` to the conversation `to` names, to new work for `new-task` or `new-bot`, or, with no `to`, to
     * the conversation on screen as it runs; refused when none is.
     */
    private suspend fun message(arguments: JsonObject, call: String): CallToolResult {
        val to = optionalString(arguments["to"])?.trim() ?: return CallToolResult.refused("to must be a string.")
        val fresh = newWork(to)
        val id = when {
            fresh != null -> ""
            to.isEmpty() -> shown()?.takeIf { directory[it] != null || drafts[it] != null }
                ?: return CallToolResult.refused("No conversation is on screen. Ask which one, then send with its ref as to.")
            else -> resolve(to) ?: return CallToolResult.refused("No such conversation.")
        }
        val text = arguments.string("text")
        if (text == null || text.isBlank()) return CallToolResult.refused("There's nothing to send.")
        if (text.utf8Size() > Limits.TEXT_BYTES) return CallToolResult.refused("That message is too long to send by voice.")
        val model = optionalString(arguments["model"]) ?: return CallToolResult.refused("model must be a string.")
        val effort = optionalString(arguments["effort"]) ?: return CallToolResult.refused("effort must be a string.")
        if (fresh != null) return start(fresh.first, fresh.second, text, model, effort, call)
        val state = targets.state(id) ?: return CallToolResult.refused("That conversation can't be read now.")
        if (!state.writable) return CallToolResult.refused("That conversation can't take a message now.")
        // A working agent takes it as the composer's send would (it steers or waits its turn); only a question
        // waiting for the person stops it.
        if (state.needsInput) return CallToolResult.refused("It's waiting for the person in the app; answer there first.")
        val asked = change(model, effort, state)
        asked.refusal?.let { return it }
        // Reading it was a wait: the call may have ended.
        if (closed) return CallToolResult.refused("The call has ended.")
        val key = "$id\u0000$text"
        val messageId = unsettled[key] ?: ConversationApi.clientId()
        unsettled[key] = messageId
        settling[call] = key
        return when (val outcome = targets.send(id, text, messageId, asked.change)) {
            CallSendOutcome.Queued -> {
                told += id
                // Heard from from now on, as a visited one is: its reply comes as it is written.
                visit(id)
                CallToolResult.json(JsonObject(linkedMapOf<String, JsonElement>(
                    "status" to JsonPrimitive("queued"), "ref" to JsonPrimitive(ref(id)), "delivery" to JsonPrimitive(QUEUED),
                ).apply {
                    // Sent to what was on screen: named, so the agent can say where it went.
                    if (to.isEmpty()) put("title", JsonPrimitive(state.target.title))
                    asked.switched?.let { (name, level) ->
                        put("model", JsonPrimitive(name))
                        if (level.isNotEmpty()) put("effort", JsonPrimitive(level))
                    }
                }))
            }
            is CallSendOutcome.Refused -> CallToolResult.refused(outcome.reason)
        }
    }

    /**
     * `message` to `new-task` or `new-bot`: new work made as compose's send makes it, [text] its first message, on
     * the model and effort asked for, else compose's own default. Nothing exists of it until then, and nothing stays
     * of it when it is refused. The same words again, their answer unheard, reach the same new work under the same
     * message ID, never a second one.
     */
    private suspend fun start(kind: CallTarget.Kind, name: String, text: String, model: String, effort: String, call: String): CallToolResult {
        val key = "${kind.wire}:$name\u0000$text"
        val messageId = unsettled[key] ?: ConversationApi.clientId()
        val earlier = startedBy[messageId]?.let { drafts[it] ?: directory[it] }
        val work = earlier ?: targets.draft(kind, name) ?: return CallToolResult.refused("New work couldn't be started.")
        suspend fun refused(result: CallToolResult): CallToolResult {
            if (earlier == null) targets.discard(work.agentId)
            return result
        }
        val state = targets.state(work.agentId)?.takeIf { it.writable } ?: return refused(CallToolResult.refused("New work can't be started now."))
        val asked = change(model, effort, state)
        asked.refusal?.let { return refused(it) }
        if (closed) return refused(CallToolResult.refused("The call has ended."))
        unsettled[key] = messageId
        settling[call] = key
        if (directory[work.agentId] == null) drafts[work.agentId] = work
        // Its first message is on its way under this ID: the same words again reach it, answered or not.
        startedBy[messageId] = work.agentId
        return when (val outcome = targets.send(work.agentId, text, messageId, asked.change)) {
            CallSendOutcome.Queued -> {
                told += work.agentId
                val value = linkedMapOf<String, JsonElement>(
                    "status" to JsonPrimitive("queued"), "ref" to JsonPrimitive(ref(work.agentId)), "started" to JsonPrimitive(kind.wire),
                    "title" to JsonPrimitive(work.title), "delivery" to JsonPrimitive(QUEUED),
                )
                (asked.switched ?: state.mode?.let { it.model to it.effort })?.let { (named, level) ->
                    value["model"] = JsonPrimitive(named)
                    if (level.isNotEmpty()) value["effort"] = JsonPrimitive(level)
                }
                CallToolResult.json(JsonObject(value))
            }
            is CallSendOutcome.Refused -> {
                if (earlier == null) {
                    drafts.remove(work.agentId)
                    startedBy.remove(messageId)
                }
                refused(CallToolResult.refused(outcome.reason))
            }
        }
    }

    // References and bodies

    /** The conversation's reference: `s` and its order key. One home doesn't list (new work on its way) gets the key after every other. */
    private fun ref(agentId: String): String = refs[agentId] ?: assign(OrderKey.between(keys.lastOrNull(), null) ?: "5", agentId)

    private fun assign(key: String, agentId: String): String {
        val made = "s$key"
        refs[agentId] = made
        agents[made] = agentId
        val at = keys.indexOfFirst { it > key }
        keys.add(if (at < 0) keys.size else at, key)
        return made
    }

    /**
     * References for what [list] holds that has none yet. The first time, as
     * few digits as the list allows, in its order ([spread]); after, each new
     * one gets a key above the one before it in the list and just below the
     * next key handed out ([OrderKey.justBefore], as happy-agent places new
     * work after a fixed row), so arrivals in one place stay short (`49`,
     * `48`, …), no key changes, none is handed out twice, one that went away
     * keeps its own for when it comes back, and sorted as text they give the
     * list's order.
     */
    private fun place(list: List<CallTarget>) {
        if (keys.isEmpty()) {
            list.zip(spread(list.size)).forEach { (entry, key) -> assign(key, entry.agentId) }
            return
        }
        var previous: String? = null
        for (entry in list) {
            val existing = refs[entry.agentId]
            if (existing != null) {
                previous = existing.drop(1)
                continue
            }
            val low = previous
            val next = keys.firstOrNull { low == null || it > low }
            val key = (if (next != null) OrderKey.justBefore(low, next) else OrderKey.between(low, null)) ?: continue
            assign(key, entry.agentId)
            previous = key
        }
    }

    /** A refresh that came in, [state] null when it couldn't be read. */
    private class Arrived(val state: CallTargetState?)

    /**
     * A read as `readConversation` gives it, [extra] going with it (a cue's event and ref): its name, state and the
     * turns [request] asks for ([CallRead]), each message cut in the middle past its words, within
     * [Limits.READ_BYTES] on the wire: the older turns give way first, then the newest's words. One that isn't current
     * says so (`refreshing`), with when this phone last read it from the computer (`checked`). A reference that fits
     * no turn, or several, is refused (`ok` false).
     */
    private fun read(state: CallTargetState, request: CallRead.Request = CallRead.Request(), extra: Map<String, JsonElement> = emptyMap()): JsonObject {
        // Asked for by its reference, it is named by its title alone.
        val name = linkedMapOf<String, JsonElement>(
            "title" to JsonPrimitive(state.target.title),
            "parents" to JsonArray(state.target.parents.map { JsonPrimitive(it.title) }),
        )
        name.putAll(extra)
        val items = CallRead.items(state)
        val references = CallRead.references(items.map { it.id })
        val range = when (val found = CallRead.range(request, items, references, state.hasMore)) {
            is CallRead.Refusal -> return JsonObject(extra + mapOf("ok" to JsonPrimitive(false), "reason" to JsonPrimitive(found.reason)))
            else -> found as IntRange?
        }
        if (!state.fresh) {
            name["refreshing"] = JsonPrimitive(true)
            state.checkedAt?.takeIf { it > 0 }?.let { name["checked"] = moment(it) }
            name["note"] = JsonPrimitive(if (items.isEmpty()) REFRESHING_EMPTY_NOTE else REFRESHING_NOTE)
        }
        val value = within(state, items, references, range ?: IntRange.EMPTY, request.words, name)
        // None of its turns on this phone: no empty list to take for an empty conversation.
        return if (!state.fresh && items.isEmpty()) JsonObject(value - "turns" - "olderTurns") else value
    }

    /** [range] of [items] within [Limits.READ_BYTES] on the wire: the older turns give way first, then the newest's words. */
    private fun within(state: CallTargetState, items: List<CallRead.Item>, references: List<String>, range: IntRange, wordsAsked: Int, name: Map<String, JsonElement>): JsonObject {
        var shown = range
        var words = wordsAsked
        var value = body(state, items, references, shown, words, name)
        while (escapedSize(CallJson.encode(value)) > Limits.READ_BYTES) {
            if (shown.count() > 1) shown = shown.first + 1..shown.last
            else if (words > CallRead.MIN_WORDS) words = maxOf(CallRead.MIN_WORDS, words / 2)
            else break
            value = body(state, items, references, shown, words, name)
        }
        return value
    }

    /**
     * A conversation read while it wasn't current, made current or let go: what is new since the agent was given it
     * goes as a cue (its turns new or changed since, from the oldest of them to the newest, the newest five at most,
     * paged and cut as a read); nothing new, or not current in time, a line of context. Nothing once the call has
     * ended.
     */
    private fun refreshed(id: String, state: CallTargetState?) {
        val pending = reading.remove(id) ?: return
        if (closed) return
        val event = linkedMapOf<String, JsonElement>("ref" to JsonPrimitive(ref(id)))
        (directory[id] ?: drafts[id])?.let { event["title"] = JsonPrimitive(it.title) }
        if (state != null && state.fresh) refreshedLast[id] = state.copy(checkedAt = now())
        if (state == null || !state.fresh) {
            val line = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("conversation_unconfirmed"))
            line.putAll(event)
            (state ?: pending.given).checkedAt?.takeIf { it > 0 }?.let { line["checked"] = moment(it) }
            line["note"] = JsonPrimitive(UNCONFIRMED_NOTE)
            onReading?.invoke(CallReading.Context(CallJson.encode(JsonObject(line))))
            return
        }
        val update = update(pending.given, state, pending.words, event)
        if (update == null) {
            val line = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("conversation_current"))
            line.putAll(event)
            line["note"] = JsonPrimitive(CURRENT_NOTE)
            onReading?.invoke(CallReading.Context(CallJson.encode(JsonObject(line))))
            return
        }
        onReading?.invoke(CallReading.Update(CallCue.ConversationUpdate(CallJson.encode(update))))
    }

    /**
     * What is new in [state] since [given], as a `conversation_update`: the turns from the oldest new or changed one
     * (the person's message, the agent's words, how it ended, a waiting message's delivery) to the newest, `working`,
     * `needsInput` and when each side last wrote; null if no turn changed and it works and needs the person as it did.
     */
    private fun update(given: CallTargetState, state: CallTargetState, words: Int, event: Map<String, JsonElement>): JsonObject? {
        val before = CallRead.items(given).associate { it.id to said(it) }
        val items = CallRead.items(state)
        val changed = items.indices.firstOrNull { before[items[it].id] != said(items[it]) }
        if (changed == null && given.working == state.working && given.needsInput == state.needsInput) return null
        val name = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("conversation_update"))
        name.putAll(event)
        val references = CallRead.references(items.map { it.id })
        // The newest five at most; continueFrom reads back from there.
        val oldest = maxOf(changed ?: items.size, items.size - CallRead.TURNS)
        return within(state, items, references, oldest until items.size, words, name)
    }

    /** What a turn says, as a read tells it. */
    private fun said(item: CallRead.Item): List<String?> =
        item.turn?.let { listOf(it.user, it.userBy, it.reply, it.ended, it.error) }
            ?: listOf(item.pending?.text, item.pending?.by, item.pending?.delivery?.wire)

    /** The conversation a reference names, while home lists it: one that went away isn't reached, and is again if it comes back, under the same reference. */
    private suspend fun resolve(value: JsonElement?): String? =
        (value as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { resolve(it) }

    private suspend fun resolve(ref: String): String? {
        val id = agents[ref] ?: return null
        see(targets.directory())
        return id.takeIf { directory[it] != null || drafts[it] != null }
    }

    /**
     * [agentId] becomes the latest visited or messaged; the oldest past the limit is forgotten, so following it again
     * starts from what is there then. The one on screen never drops out while it is in front.
     */
    private fun visit(agentId: String) {
        visited.remove(agentId)
        visited.add(0, agentId)
        while (visited.size > Limits.VISITED) {
            val oldest = visited.indexOfLast { it != focus }.takeIf { it >= 0 } ?: break
            heard.remove(visited.removeAt(oldest))
        }
    }

    /**
     * What is there when the call first sees a conversation is had: the
     * agent's complete messages and the errors so far. One still being
     * written is new, and goes once it is complete.
     */
    private fun listen(state: CallTargetState) {
        heard[state.target.agentId] = Heard(
            had = state.messages.filter { it.role == CallMessage.Role.Assistant && it.final }.mapTo(HashSet()) { it.id },
            errors = state.turns.filter { it.ended == "error" }.mapTo(HashSet()) { it.id },
        )
    }

    /** One of `listConversations`' answers. */
    private fun row(target: CallTarget): JsonObject {
        val value = linkedMapOf<String, JsonElement>(
            "ref" to JsonPrimitive(ref(target.agentId)),
            "title" to JsonPrimitive(target.title),
            "kind" to JsonPrimitive(target.kind.wire),
            "status" to JsonPrimitive(target.status.wire),
        )
        if (target.parents.isNotEmpty()) value["parents"] = JsonArray(target.parents.map { JsonPrimitive(it.title) })
        if (target.workspace.isNotEmpty()) value["workspace"] = JsonPrimitive(target.workspace.joinToString(" / "))
        target.activityAt?.takeIf { it > 0 }?.let { value["lastActivity"] = moment(it) }
        return JsonObject(value)
    }

    /** A moment as the agent says it: how long ago, and when on the person's clock, to the minute. */
    private fun moment(millis: Long): JsonObject =
        JsonObject(mapOf("ago" to JsonPrimitive(ago((now() - millis) / 1000)), "at" to JsonPrimitive(local(millis, zone))))

    /**
     * A conversation as read: [name], then whether it works or waits for the person, and the turns [shown] of [items],
     * each with its reference, oldest first, the one waiting for an answer apart; where to read on back from
     * (`continueFrom`) when older ones are here. Never its kind, status or reference beyond what [name] holds: the
     * directory has those.
     */
    private fun body(state: CallTargetState, items: List<CallRead.Item>, references: List<String>, shown: IntRange, words: Int, name: Map<String, JsonElement>): JsonObject {
        val value = LinkedHashMap(name)
        value["working"] = JsonPrimitive(state.working)
        value["needsInput"] = JsonPrimitive(state.needsInput)
        state.messages.lastOrNull { it.role == CallMessage.Role.User && (it.time ?: 0L) > 0 }?.let { last ->
            val said = moment(last.time!!)
            value["lastUserMessage"] = last.by?.let { JsonObject(said + ("by" to JsonPrimitive(it))) } ?: said
        }
        state.turns.filter { !it.reply.isNullOrEmpty() }.mapNotNull { it.endedAt }.filter { it > 0 }.maxOrNull()?.let { value["lastAgentReply"] = moment(it) }
        if (state.target.workspace.isNotEmpty()) value["workspace"] = JsonPrimitive(state.target.workspace.joinToString(" / "))
        state.mode?.let { value["model"] = JsonObject(mapOf("id" to JsonPrimitive(it.modelId), "name" to JsonPrimitive(it.model), "effort" to JsonPrimitive(it.effort))) }
        if (state.models.isNotEmpty()) value["models"] = models(state.models)
        val turns = ArrayList<JsonObject>()
        for (index in shown) {
            items[index].turn?.let { turns += turn(it, references[index], words) }
            items[index].pending?.let { pending ->
                val message = linkedMapOf<String, JsonElement>("ref" to JsonPrimitive(references[index]))
                val cuts = linkedMapOf<String, JsonElement>()
                message["text"] = JsonPrimitive(cut(pending.text, words, "text", cuts))
                cuts["text"]?.let { message["cut"] = it }
                pending.delivery?.let { message["delivery"] = JsonPrimitive(it.wire) }
                pending.by?.let { message["by"] = JsonPrimitive(it) }
                value["pendingUserMessage"] = JsonObject(message)
            }
        }
        value["turns"] = JsonArray(turns)
        value["olderTurns"] = JsonPrimitive((!shown.isEmpty() && shown.first > 0) || state.hasMore)
        if (!shown.isEmpty() && shown.first > 0) value["continueFrom"] = JsonPrimitive(references[shown.first - 1])
        return JsonObject(value)
    }

    /** Where `navigate` goes. */
    sealed interface Destination {
        data object Home : Destination
        data object Back : Destination
        data object Restart : Destination
        data class Conversation(val ref: String) : Destination
    }

    companion object {
        private val STALE = CallToolResult.refused("The screen changed since; check the focus again.")

        /** The references `message` starts new work with, as the first context lists them; a name after a colon names it. */
        const val NEW_TASK_REF = "new-task"
        const val NEW_BOT_REF = "new-bot"

        /** Where `navigate` goes, as the first context lists them. */
        const val HOME_URL = "happy://home"
        const val BACK_URL = "happy://back"
        const val CONVERSATION_URL = "happy://conversation/"
        val DESTINATIONS = listOf(HOME_URL, BACK_URL, "$CONVERSATION_URL<ref>")
        /**
         * Not a screen: the call, ended and started again at once, carried
         * over ([CallSession.requestRestart]). Listed in the first context
         * only; the dashboard's navigate description names the screens.
         */
        const val RESTART_URL = "happy://call/restart"

        /** Who the call talks to, in a team (iOS `personText`). */
        fun personText(name: String): String =
            "The person: $name, a member of this team. They mostly ask about their own work; look across the team only when they ask about the team or others' work."

        /** How the first context starts new work, as `message` takes it. */
        val NEW_WORK_TEXT = """
            New work (message's to; listed nowhere until its first message makes it):
            - $NEW_TASK_REF — a new task, the message its first
            - $NEW_BOT_REF — a new bot, the message its first
            A name after a colon names it: $NEW_BOT_REF:Release helper.
        """.trimIndent()

        /** Where the first context says `navigate` goes. */
        val DESTINATIONS_TEXT = """
            Destinations (navigate's to):
            - $HOME_URL — the home list
            - $BACK_URL — one screen back; refused at home
            - $CONVERSATION_URL<ref> — that conversation on screen, such as ${CONVERSATION_URL}s1
            - $RESTART_URL — end this call and start a new one at once, this conversation carried over; only when the person agrees
        """.trimIndent()

        /**
         * What earlier calls said, oldest first, each line with how long ago
         * (iOS `CallContext.recap`): the newest within [bytes], each line's
         * words within [Limits.SLOT_BYTES]. Null when nothing was said.
         */
        fun recap(slots: List<CallSlot>, now: Long, bytes: Int): String? {
            if (slots.isEmpty()) return null
            val header = "Previous voice conversation (earlier calls, oldest first):"
            val cut = "Older lines aren't shown."
            val lines = ArrayList<String>()
            var size = header.utf8Size() + cut.utf8Size() + 2
            for (slot in slots.asReversed()) {
                val whenSaid = ago(Math.floorDiv(now - slot.at, 1000L))
                val line = when (slot.kind) {
                    CallSlot.Kind.Person -> "- $whenSaid, the person: " + indented(clipped(slot.text.orEmpty(), Limits.SLOT_BYTES))
                    CallSlot.Kind.Assistant -> "- $whenSaid, you: " + indented(clipped(slot.text.orEmpty(), Limits.SLOT_BYTES))
                    CallSlot.Kind.Ended -> "- $whenSaid: " + (slot.ending ?: CallEnding.Dropped).said
                }
                if (size + line.utf8Size() + 1 > bytes) break
                size += line.utf8Size() + 1
                lines += line
            }
            if (lines.isEmpty()) return header + "\n" + cut
            return (listOf(header) + (if (lines.size < slots.size) listOf(cut) else emptyList()) + lines.asReversed()).joinToString("\n")
        }

        /**
         * [count] order keys in order, as short as [count] allows: `1` to `9`
         * for up to nine; else the fewest digits that hold them, counted up from
         * `11` (or `101`, …), skipping any that ends in 0, as no key does. A
         * conversation that comes between two of them later adds a digit: `49`
         * between `4` and `5`.
         */
        fun spread(count: Int): List<String> {
            // 9 of one digit, 81 of two, 810 of three, …
            var capacity = 9
            var number = 1
            while (capacity < count) {
                capacity = if (number == 1) 81 else capacity * 10
                number *= 10
            }
            if (number > 1) number += 1
            val keys = ArrayList<String>()
            while (keys.size < count) {
                if (number % 10 != 0) keys += number.toString()
                number += 1
            }
            return keys
        }

        /** The positions of a longest increasing run in [values], its members not necessarily next to each other: what kept its order. The rest moved. */
        fun kept(values: List<Int>): Set<Int> {
            // The position ending the smallest-tailed run of each length.
            val tails = ArrayList<Int>()
            val previous = IntArray(values.size) { -1 }
            values.forEachIndexed { position, value ->
                var low = 0
                var high = tails.size
                while (low < high) {
                    val middle = (low + high) / 2
                    if (values[tails[middle]] < value) low = middle + 1 else high = middle
                }
                if (low > 0) previous[position] = tails[low - 1]
                if (low == tails.size) tails += position else tails[low] = position
            }
            val result = HashSet<Int>()
            var position = tails.lastOrNull() ?: -1
            while (position >= 0) {
                result += position
                position = previous[position]
            }
            return result
        }

        /** One of the first context's destinations, any case in the scheme and the place, a trailing slash allowed; null for anything else. */
        fun destination(url: String): Destination? {
            val text = url.trim().removeSuffix("/")
            val lower = text.lowercase()
            if (lower == HOME_URL) return Destination.Home
            if (lower == BACK_URL) return Destination.Back
            if (lower == RESTART_URL) return Destination.Restart
            if (!lower.startsWith(CONVERSATION_URL)) return null
            val ref = text.substring(CONVERSATION_URL.length)
            return if (ref.isEmpty() || '/' in ref) null else Destination.Conversation(ref)
        }

        /** `new-task` or `new-bot`, any case, with the name after a colon if one is given; null for any other reference. */
        fun newWork(ref: String): Pair<CallTarget.Kind, String>? {
            val lower = ref.lowercase()
            for ((prefix, kind) in listOf(NEW_TASK_REF to CallTarget.Kind.Task, NEW_BOT_REF to CallTarget.Kind.Bot)) {
                if (lower == prefix) return kind to ""
                if (lower.startsWith("$prefix:")) return kind to CallTarget.clean(ref.substring(prefix.length + 1))
            }
            return null
        }

        /** A refusal for new work named where only `message` takes it. */
        private fun unmade(value: JsonElement?): CallToolResult? {
            val ref = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            if (newWork(ref) == null) return null
            return CallToolResult.refused("Nothing exists of new work until its first message: start it with message to $NEW_TASK_REF or $NEW_BOT_REF.")
        }

        /** One turn of the first context: who asked, the agent's last words, and how it ended when that wasn't plain. */
        fun turnText(turn: CallTurn, number: Int): String {
            val lines = ArrayList<String>()
            fun text(words: String?, who: String, bytes: Int) {
                if (words.isNullOrEmpty()) return
                lines += "$who: " + indented(clipped(words, bytes))
            }
            text(turn.user, turn.userBy?.let { if (it == "the person") "The person" else it } ?: "The person", Limits.USER_BYTES)
            text(turn.reply, "Agent", Limits.REPLY_BYTES)
            if (turn.ended == "error") {
                lines += "Ended in an error" + (turn.error?.takeIf { it.isNotEmpty() }?.let { ": " + indented(truncated(it, Limits.ERROR_BYTES)) } ?: ".")
            } else if (turn.ended != "completed") {
                lines += "Ended: ${turn.ended}"
            }
            return "$number. " + lines.joinToString("\n   ")
        }

        /** [text] with its later lines indented under the first. */
        private fun indented(text: String): String = text.replace("\n", "\n   ")

        private fun yes(value: Boolean): String = if (value) "yes" else "no"

        /** What "queued" is, in the result as well as the tool's description: told only the status, the agent says "sent". */
        const val QUEUED = "on the person's device, not confirmed delivered or read"
        const val REFRESHING_NOTE = "What this phone had: answer from it, and say you're checking the computer for anything newer, which comes as an [app] conversation_update."
        const val REFRESHING_EMPTY_NOTE = "This phone has none of its turns yet, so this says nothing of what is in it: say you're checking; its turns come as an [app] conversation_update."
        const val UNCONFIRMED_NOTE = "The computer didn't answer in time: what you read may be out of date. Nothing to say unless asked."
        const val CURRENT_NOTE = "Checked: nothing new since you read it. Nothing to say unless asked."

        /** The last finished turns a read shows: five with the person's message still waiting for an answer, which is the fifth. */
        fun recent(state: CallTargetState): List<CallTurn> =
            answering(state).takeLast(if (state.unanswered == null) Limits.TURNS else Limits.TURNS - 1)

        /**
         * Finished turns with something to say: the person's message, the
         * agent's last words, an error, or as much of that as there is. Never
         * the agent's words between its steps.
         */
        private fun answering(state: CallTargetState): List<CallTurn> =
            state.turns.filter { !it.user.isNullOrEmpty() || !it.reply.isNullOrEmpty() || it.ended == "error" }

        /**
         * One turn as a read gives it: its reference, the person's message and the agent's last words, each cut in the
         * middle past [words] with its whole size in `cut`, and how it ended.
         */
        fun turn(turn: CallTurn, ref: String, words: Int): JsonObject {
            val value = linkedMapOf<String, JsonElement>("ref" to JsonPrimitive(ref), "ended" to JsonPrimitive(turn.ended))
            val cuts = linkedMapOf<String, JsonElement>()
            if (!turn.user.isNullOrEmpty()) {
                value["user"] = JsonPrimitive(cut(turn.user, words, "user", cuts))
                turn.userBy?.let { value["userBy"] = JsonPrimitive(it) }
            }
            if (!turn.reply.isNullOrEmpty()) value["assistant"] = JsonPrimitive(cut(turn.reply, words, "assistant", cuts))
            if (turn.ended == "error") turn.error?.takeIf { it.isNotEmpty() }?.let { value["error"] = JsonPrimitive(truncated(it, Limits.ERROR_BYTES)) }
            if (cuts.isNotEmpty()) value["cut"] = JsonObject(cuts)
            return JsonObject(value)
        }

        /** [text] within [words] ([CallRead.cut]), its whole size and what was left out put in [cuts] under [key] when it was cut. */
        private fun cut(text: String, words: Int, key: String, cuts: MutableMap<String, JsonElement>): String {
            val cut = CallRead.cut(text, words) ?: return text
            cuts[key] = JsonObject(mapOf("words" to JsonPrimitive(cut.words), "leftOut" to JsonPrimitive(cut.leftOut)))
            return cut.text
        }

        /**
         * [text] within [bytes] of UTF-8, cut after a whole word and saying how
         * many were left out: "… (cut, 120 more words)". A text with no space
         * to cut at is cut between characters (iOS `CallContext.clipped`).
         */
        fun clipped(text: String, bytes: Int): String {
            if (text.utf8Size() <= bytes) return text
            // Room for the note, whatever its count.
            var kept = truncated(text, maxOf(0, bytes - 32))
            if (kept.length < text.length && !isSpace(text[kept.length])) {
                val space = kept.indexOfLast(::isSpace)
                if (space >= 0) kept = kept.substring(0, space)
            }
            kept = kept.trimEnd(::isSpace)
            val left = text.substring(kept.length).split(' ', '\t', '\n', '\r').count { it.isNotEmpty() }
            return kept + " … (cut, $left more ${if (left == 1) "word" else "words"})"
        }

        /**
         * What [json] weighs sent on as a string inside a call SDK's own JSON, at
         * most: a quote, backslash or slash escaped in two bytes, a control
         * character or one Gson escapes as HTML (`<`, `>`, `&`, `=`, `'`) in six
         * (`\u003c`). iOS's `escapedSize` counts the same.
         */
        fun escapedSize(json: String): Int = json.encodeToByteArray().sumOf { byte ->
            when (byte.toInt()) {
                0x22, 0x5C, 0x2F -> 2
                0x3C, 0x3E, 0x26, 0x3D, 0x27, in 0 until 0x20 -> 6
                else -> 1
            }.toInt()
        }

        /** A space, tab or line break: where [clipped] cuts and counts words. */
        private fun isSpace(character: Char): Boolean = character == ' ' || character == '\t' || character == '\n' || character == '\r'

        /** The longest prefix of whole characters (code points) within [bytes] of UTF-8, or of what [size] counts. */
        fun truncated(text: String, bytes: Int, size: (String) -> Int = { it.utf8Size() }): String {
            if (size(text) <= bytes) return text
            var count = 0
            var end = 0
            while (end < text.length) {
                val point = text.codePointAt(end)
                val next = size(String(Character.toChars(point)))
                if (count + next > bytes) break
                count += next
                end += Character.charCount(point)
            }
            return text.substring(0, end)
        }

        /** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago" (iOS `CallContext.ago`). */
        fun ago(seconds: Long): String {
            val minutes = Math.floorDiv(seconds, 60L)
            return when {
                minutes < 1 -> "just now"
                minutes == 1L -> "a minute ago"
                minutes < 60 -> "$minutes minutes ago"
                minutes < 120 -> "an hour ago"
                minutes < 24 * 60 -> "${minutes / 60} hours ago"
                minutes < 48 * 60 -> "yesterday"
                else -> "${minutes / (24 * 60)} days ago"
            }
        }

        /** ISO 8601 in [zone], with its offset, to the minute: 2026-11-06T09:15:00+01:00. */
        fun local(millis: Long, zone: ZoneId): String =
            Instant.ofEpochMilli(millis).truncatedTo(ChronoUnit.MINUTES).atZone(zone).format(LOCAL)

        private val LOCAL = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX")

        fun models(list: List<CallModel>): JsonArray = JsonArray(list.take(Limits.MODELS).map {
            JsonObject(mapOf("id" to JsonPrimitive(it.id), "name" to JsonPrimitive(it.name), "efforts" to JsonArray(it.efforts.map(::JsonPrimitive))))
        })

        /** What [change] made of a send's model and effort. */
        class AskedMode(val change: CallModeChange? = null, val switched: Pair<String, String>? = null, val refusal: CallToolResult? = null)

        /**
         * The model and effort a send asks for, as the conversation's computer offers them ([CallTargetState.models]):
         * what to switch to, and how it is named, or a refusal that lists what it takes. Blank asks for no change.
         */
        fun change(model: String, effort: String, state: CallTargetState): AskedMode {
            val asked = model.trim()
            val level = effort.trim()
            if (asked.isEmpty() && level.isEmpty()) return AskedMode()
            fun refused(reason: String, listed: List<CallModel>): AskedMode {
                val value = linkedMapOf<String, JsonElement>("ok" to JsonPrimitive(false), "reason" to JsonPrimitive("$reason Nothing was sent."))
                if (listed.isNotEmpty()) value["models"] = models(listed)
                return AskedMode(refusal = CallToolResult.json(JsonObject(value), isError = true))
            }
            if (state.models.isEmpty()) return refused("This computer's models can't be read now, so the model and effort can't change.", emptyList())
            var chosen = state.mode?.let { mode -> state.models.firstOrNull { it.id == mode.modelId } }
            if (asked.isNotEmpty()) {
                val key = spoken(asked)
                val exact = state.models.filter { spoken(it.id) == key || spoken(it.name) == key }
                val matching = exact.ifEmpty { state.models.filter { key in spoken(it.id) || key in spoken(it.name) } }
                if (matching.size != 1) {
                    val reason = if (matching.isEmpty()) {
                        "There is no model called \"$asked\". It takes one of: ${state.models.joinToString(", ") { it.name }}."
                    } else {
                        "\"$asked\" could be ${matching.joinToString(" or ") { it.name }}; ask which."
                    }
                    return refused(reason, matching.ifEmpty { state.models })
                }
                chosen = matching[0]
            }
            val model = chosen ?: return refused("It runs on a model this computer doesn't list now; name the model as well.", state.models)
            var picked: String? = null
            if (level.isNotEmpty()) {
                if (model.efforts.isEmpty()) return refused("${model.name} takes no effort level.", listOf(model))
                picked = model.efforts.firstOrNull { spoken(it) == spoken(level) }
                    ?: return refused("${model.name} takes effort ${model.efforts.joinToString(", ")}, not \"$level\".", listOf(model))
            }
            val changesModel = model.id != state.mode?.modelId
            // As the picker does: a model's own default effort unless one was asked for.
            val named = picked ?: if (changesModel) model.defaultEffort else state.mode?.effort ?: model.defaultEffort
            return AskedMode(CallModeChange(model.id.takeIf { asked.isNotEmpty() }, picked), model.name to named)
        }

        /** A name as said aloud: letters and digits only, any case. */
        private fun spoken(text: String): String = text.lowercase().filter { it.isLetterOrDigit() }

        /** A JSON integer, as the schema says: never a string, a fraction or a boolean. */
        private fun revisionOf(value: JsonElement?): Int? {
            val primitive = (value as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull } ?: return null
            primitive.intOrNull?.let { return it }
            val double = primitive.doubleOrNull ?: return null
            return double.toInt().takeIf { it.toDouble() == double }
        }

        /** An optional string argument: absent or null is empty, anything but a string is null. */
        private fun optionalString(value: JsonElement?): String? = when {
            value == null || value is JsonNull -> ""
            value is JsonPrimitive && value.isString -> value.content
            else -> null
        }

        private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

/**
 * A call's one directory update on its way ([CallContext.directoryUpdate]):
 * due [delayMillis] after the first change it tells, whatever comes after, so
 * a burst goes as one; a change after it has gone starts the next. Cancelled
 * with its call's scope (iOS `DirectorySettle`).
 */
class DirectorySettle(
    private val scope: CoroutineScope,
    private val delayMillis: Long = CallContext.Limits.SETTLE_MS,
    private val flush: suspend () -> Unit,
) {
    private var waiting: Job? = null

    /** The directory changed: the flush in [delayMillis], or the one already due. */
    fun changed() {
        if (waiting != null) return
        waiting = scope.launch {
            delay(delayMillis)
            waiting = null
            flush()
        }
    }

    fun cancel() {
        waiting?.cancel()
        waiting = null
    }
}

internal fun String.utf8Size(): Int = toByteArray(Charsets.UTF_8).size

/** Compact JSON with sorted keys, as iOS writes it: the same context reads the same on both. */
object CallJson {
    fun encode(value: JsonElement): String = StringBuilder().also { write(value, it) }.toString()

    private fun write(value: JsonElement, out: StringBuilder) {
        when (value) {
            is JsonObject -> {
                out.append('{')
                value.keys.sorted().forEachIndexed { index, key ->
                    if (index > 0) out.append(',')
                    out.append(JsonPrimitive(key).toString()).append(':')
                    write(value.getValue(key), out)
                }
                out.append('}')
            }
            is JsonArray -> {
                out.append('[')
                value.forEachIndexed { index, item ->
                    if (index > 0) out.append(',')
                    write(item, out)
                }
                out.append(']')
            }
            else -> out.append(value.toString())
        }
    }
}
