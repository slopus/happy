package com.slopus.happy.call

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
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
 * Lives only during one call, bound to one connection (iOS `CallContext`).
 * It owns the opaque references the hosted agent knows conversations by, the
 * focus, and the last four conversations the person visited during the
 * call, which are the ones it hears from; it runs the tools one at a
 * time. A visited conversation says only what its agent writes from then on,
 * each piece once it is complete and whole, and an error that stopped it:
 * never its words as they stream, its tools, its state or the person's
 * messages.
 *
 * The call starts with the directory: home's bots, tasks, subtasks and
 * project conversations, in its order and nesting, as plain lines that give
 * each its reference, in the first context only. It never goes again:
 * `listSessions` finds what came or changed since. Updates name a
 * conversation by its title and what it sits under, and by its reference too
 * when that alone leaves it unclear or the agent hasn't had it yet.
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
) {
    object Limits {
        const val TOTAL_BYTES = 32 * 1024
        /**
         * Turns a read shows, the person's message still waiting for an answer
         * counted as one: each the person's message and the agent's last
         * words, or as much of the pair as there is.
         */
        const val TURNS = 5
        const val MESSAGE_BYTES = 4 * 1024
        const val ERROR_BYTES = 1024
        /** Conversations the first context lists, and its directory's size. */
        const val DIRECTORY = 100
        const val DIRECTORY_BYTES = 12 * 1024
        const val PAGE = 50
        /** Conversations the call hears from: the last ones visited, the one on screen included. */
        const val VISITED = 4
        /** The agent's messages looked at per change, newest last. */
        const val MESSAGES = 20
        const val TEXT_BYTES = 8 * 1024
        const val TOOL_DEADLINE_MS = 8_000L
        /** Models a read or a refusal lists. */
        const val MODELS = 30
    }

    private val scope = CoroutineScope(SupervisorJob() + lane)
    private val refs = HashMap<String, String>()
    private val agents = HashMap<String, String>()
    private var nextRef = 1
    private var focus: String? = null
    private var focusRevision = 0
    /** Newest first. */
    private val visited = ArrayList<String>()
    /** Home's conversations as last seen, in order and by ID. */
    private var entries: List<CallTarget> = emptyList()
    private var directory: Map<String, CallTarget> = emptyMap()
    /** Work home doesn't list until its first message makes it: what `sendMessage` started, or compose's in front. */
    private val drafts = HashMap<String, CallTarget>()
    /** The conversations whose reference the agent has: from the first context, `listSessions`, a tool's answer or an update. */
    private val told = HashSet<String>()
    /** New work `sendMessage` started, by the ID its first message went under: the same words again reach it, never a second one. */
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

    /** The conversations the call hears from now, the latest visited first. */
    suspend fun followed(): List<String> = withContext(lane) { visited.toList() }

    suspend fun close() = withContext(lane) {
        closed = true
        for (task in results.values) task.cancel()
        scope.cancel()
    }

    // The first context

    /**
     * `initialConversationContext`, the hosted prompt's one variable, as plain
     * text: the time and focusRevision, the conversation on screen with its
     * last five turns, the directory, and how new work starts. Within
     * [Limits.TOTAL_BYTES]: the older turns give way first, then the
     * directory's tail.
     */
    suspend fun initial(): String = withContext(lane) {
        see(targets.directory())
        val focused = targets.focused()
        focus = focused
        var state: CallTargetState? = null
        if (focused != null) {
            visit(focused)
            if (directory[focused] == null) targets.unlisted(focused)?.let { drafts[focused] = it }
            state = targets.state(focused)?.also { if (heard[focused] == null) listen(it) }
        }
        val header = "Now: ${local(now(), zone)} (the person's local time)\nfocusRevision: $focusRevision"
        val turns = state?.let(::recent)?.toMutableList() ?: mutableListOf()
        var budget = Limits.DIRECTORY_BYTES
        fun text(telling: Boolean = false): String =
            listOf(header, screen(state, turns), directoryText(budget, telling), NEW_WORK_TEXT).joinToString("\n\n")
        while (text().utf8Size() > Limits.TOTAL_BYTES && turns.isNotEmpty()) turns.removeAt(0)
        while (text().utf8Size() > Limits.TOTAL_BYTES && budget > 512) budget /= 2
        focused?.let { told += it }
        text(telling = true)
    }

    /** The conversation on screen as the first context tells it: what `getSessionContext` reads of it, as lines. */
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
        if (turns.isEmpty()) {
            lines += "No turns yet."
        } else {
            lines += "Last turns, oldest first:"
            turns.forEachIndexed { index, turn -> lines += turnText(turn, index + 1) }
        }
        if (state.hasMore || answering(state).size > turns.size) lines += "Older turns aren't shown."
        state.unanswered?.let { pending ->
            val text = truncated(pending.text, Limits.MESSAGE_BYTES)
            val delivery = when (pending.delivery) {
                CallMessage.Delivery.Queued -> ", still on this phone"
                CallMessage.Delivery.Failed -> ", which failed to send"
                else -> ""
            }
            lines += "Waiting for an answer, from ${pending.by ?: "the person"}$delivery:\n   " + indented(text) +
                if (text.length < pending.text.length) " [cut short]" else ""
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
            val text = truncated(message.text, Limits.MESSAGE_BYTES)
            val event = LinkedHashMap(address)
            event["event"] = JsonPrimitive("assistant_text")
            event["text"] = JsonPrimitive(text)
            if (text.length < message.text.length) event["truncated"] = JsonPrimitive(true)
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
     * in one go. The focus, marked `resync`, with its reference, then the
     * errors this call told of and each message it told, as it told it, the
     * most recent kept first, within half of [Limits.TOTAL_BYTES]. What
     * doesn't fit is counted in `omitted`; a read (`getSessionContext`) has
     * it. The first context is the prompt's, never lost.
     */
    suspend fun resync(): CallUpdate = withContext(lane) {
        if (closed) return@withContext CallUpdate()
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
        var bytes = CallJson.encode(JsonObject(focusEvent)).utf8Size() + 32
        for (item in items) {
            if (bytes + item.utf8Size() + 1 > Limits.TOTAL_BYTES / 2) continue
            kept += item
            bytes += item.utf8Size() + 1
        }
        if (kept.size < items.size) focusEvent["omitted"] = JsonPrimitive(items.size - kept.size)
        // Oldest first, as they would have come.
        val errorCount = kept.takeWhile { it in errors }.size
        CallUpdate(listOf(CallJson.encode(JsonObject(focusEvent))) + kept.take(errorCount) + kept.drop(errorCount).reversed())
    }

    // The directory

    /** Home's conversations, as just read. */
    private fun see(now: List<CallTarget>) {
        entries = now
        val byId = LinkedHashMap<String, CallTarget>()
        for (entry in now) byId.putIfAbsent(entry.agentId, entry)
        directory = byId
        // Made by its first message: home's from now on.
        drafts.keys.removeAll { it in byId }
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
        if (omitted > 0) text += "\n… and $omitted more; listSessions finds them by title."
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
        val timeout = if (tool == CallTool.SendMessage) {
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
            CallTool.ListSessions -> {
                val query = optionalString(arguments["query"]) ?: return CallToolResult.refused("query must be a string.")
                val cursor = optionalString(arguments["cursor"]) ?: return CallToolResult.refused("cursor must be a string.")
                val needle = query.trim().lowercase()
                val start = (if (cursor.isEmpty()) 0 else cursor.toIntOrNull())?.takeIf { it >= 0 }
                    ?: return CallToolResult.refused("That isn't a cursor listSessions gave.")
                see(targets.directory())
                val matching = if (needle.isEmpty()) entries else entries.filter { needle in it.title.lowercase() }
                val page = matching.drop(start).take(Limits.PAGE)
                // A directory query: what it gives, the agent has.
                told += page.map { it.agentId }
                val value = linkedMapOf<String, JsonElement>("sessions" to JsonArray(page.map(::row)), "now" to JsonPrimitive(local(now(), zone)))
                if (start + page.size < matching.size) value["nextCursor"] = JsonPrimitive((start + page.size).toString())
                CallToolResult.json(JsonObject(value))
            }

            CallTool.GetSessionContext -> {
                unmade(arguments["targetRef"])?.let { return it }
                val id = resolve(arguments["targetRef"]) ?: return CallToolResult.refused("No such conversation.")
                val state = targets.state(id) ?: return CallToolResult.refused("That conversation can't be read now.")
                // Within the snapshot's budget too: the oldest turns give way. Asked for by its reference, it is named by its title alone.
                val name = linkedMapOf<String, JsonElement>(
                    "title" to JsonPrimitive(state.target.title),
                    "parents" to JsonArray(state.target.parents.map { JsonPrimitive(it.title) }),
                )
                val turns = recent(state).toMutableList()
                var value = body(state, turns, name, options = true)
                while (CallJson.encode(value).utf8Size() > Limits.TOTAL_BYTES && turns.isNotEmpty()) {
                    turns.removeAt(0)
                    value = body(state, turns, name, options = true)
                }
                CallToolResult.json(value)
            }

            CallTool.OpenSession -> {
                unmade(arguments["targetRef"])?.let { return it }
                val id = resolve(arguments["targetRef"]) ?: return CallToolResult.refused("No such conversation.")
                if (revisionOf(arguments["focusRevision"]) != focusRevision) return STALE
                // Past its deadline the answer is gone: nothing moves on screen after it.
                if (closed) return CallToolResult.refused("No answer in time.")
                if (!targets.open(id)) return CallToolResult.refused("It didn't open.")
                // In front now as far as the call goes, with the revision the next step takes. The screen says so
                // too; whichever of the two comes second says nothing.
                moveFocus(id)
                CallToolResult.json(JsonObject(mapOf(
                    "opened" to JsonPrimitive(true), "targetRef" to JsonPrimitive(ref(id)), "focusRevision" to JsonPrimitive(focusRevision),
                )))
            }

            CallTool.SendMessage -> send(arguments, call)

            // Retired: still on the hosted agent until it is detached there.
            CallTool.NewWork -> CallToolResult.refused("newWork is retired. Use sendMessage with targetRef new-task or new-bot.")

            CallTool.GoBack, CallTool.GoHome -> {
                if (tool == CallTool.GoBack && revisionOf(arguments["focusRevision"]) != focusRevision) return STALE
                if (closed) return CallToolResult.refused("No answer in time.")
                when (val moved = if (tool == CallTool.GoBack) targets.back() else targets.home()) {
                    is CallScreenMove.Refused -> CallToolResult.refused(moved.reason)
                    is CallScreenMove.Moved -> {
                        // Where it landed is the focus now; the screen says so too, and whichever of the two comes second says nothing.
                        val shown = targets.focused()
                        if (shown != null && directory[shown] == null && drafts[shown] == null) {
                            see(targets.directory())
                            if (directory[shown] == null) targets.unlisted(shown)?.let { drafts[shown] = it }
                        }
                        moveFocus(shown)
                        val value = linkedMapOf<String, JsonElement>(
                            "home" to JsonPrimitive(moved.atHome), "focusRevision" to JsonPrimitive(focusRevision), "title" to JsonNull,
                        )
                        val entry = shown?.let { directory[it] ?: drafts[it] }
                        if (entry != null) {
                            value.putAll(address(entry))
                            value["targetRef"] = JsonPrimitive(ref(entry.agentId))
                            told += entry.agentId
                        }
                        CallToolResult.json(JsonObject(value))
                    }
                }
            }
        }
    }

    private suspend fun send(arguments: JsonObject, call: String): CallToolResult {
        val fresh = arguments.string("targetRef")?.let(::newWork)
        val id = if (fresh == null) resolve(arguments["targetRef"]) ?: return CallToolResult.refused("No such conversation.") else ""
        val text = arguments.string("text")
        if (text == null || text.isBlank()) return CallToolResult.refused("There's nothing to send.")
        if (text.utf8Size() > Limits.TEXT_BYTES) return CallToolResult.refused("That message is too long to send by voice.")
        val model = optionalString(arguments["model"]) ?: return CallToolResult.refused("model must be a string.")
        val effort = optionalString(arguments["effort"]) ?: return CallToolResult.refused("effort must be a string.")
        val asOf = revisionOf(arguments["focusRevision"])
        if (asOf != focusRevision) return STALE
        if (fresh != null) return start(fresh.first, fresh.second, text, model, effort, asOf, call)
        val state = targets.state(id) ?: return CallToolResult.refused("That conversation can't be read now.")
        if (!state.writable) return CallToolResult.refused("That conversation can't take a message now.")
        // A working agent takes it as the composer's send would (it steers or waits its turn); only a question
        // waiting for the person stops it.
        if (state.needsInput) return CallToolResult.refused("It's waiting for the person in the app; answer there first.")
        val asked = change(model, effort, state)
        asked.refusal?.let { return it }
        // Reading it was a wait: the screen, or the call, may have moved on.
        if (closed) return CallToolResult.refused("The call has ended.")
        if (asOf != focusRevision) return STALE
        val key = "$id\u0000$text"
        val messageId = unsettled[key] ?: ConversationApi.clientId()
        unsettled[key] = messageId
        settling[call] = key
        return when (val outcome = targets.send(id, text, messageId, asked.change)) {
            CallSendOutcome.Queued -> CallToolResult.json(JsonObject(linkedMapOf<String, JsonElement>(
                "status" to JsonPrimitive("queued"), "targetRef" to JsonPrimitive(ref(id)), "delivery" to JsonPrimitive(QUEUED),
            ).apply {
                asked.switched?.let { (name, level) ->
                    put("model", JsonPrimitive(name))
                    if (level.isNotEmpty()) put("effort", JsonPrimitive(level))
                }
            }))
            is CallSendOutcome.Refused -> CallToolResult.refused(outcome.reason)
        }
    }

    /**
     * `sendMessage` to `new-task` or `new-bot`: new work made as compose's send makes it, [text] its first message, on
     * the model and effort asked for, else compose's own default. Nothing exists of it until then, and nothing stays
     * of it when it is refused. The same words again, their answer unheard, reach the same new work under the same
     * message ID, never a second one.
     */
    private suspend fun start(kind: CallTarget.Kind, name: String, text: String, model: String, effort: String, asOf: Int?, call: String): CallToolResult {
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
        if (asOf != focusRevision) return refused(STALE)
        unsettled[key] = messageId
        settling[call] = key
        if (directory[work.agentId] == null) drafts[work.agentId] = work
        // Its first message is on its way under this ID: the same words again reach it, answered or not.
        startedBy[messageId] = work.agentId
        return when (val outcome = targets.send(work.agentId, text, messageId, asked.change)) {
            CallSendOutcome.Queued -> {
                told += work.agentId
                val value = linkedMapOf<String, JsonElement>(
                    "status" to JsonPrimitive("queued"), "targetRef" to JsonPrimitive(ref(work.agentId)), "started" to JsonPrimitive(kind.wire),
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

    private fun ref(agentId: String): String = refs.getOrPut(agentId) {
        "s${nextRef++}".also { agents[it] = agentId }
    }

    /** The conversation a reference names, while home lists it: one that went away isn't reached, and is again if it comes back, under the same reference. */
    private suspend fun resolve(value: JsonElement?): String? {
        val ref = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val id = agents[ref] ?: return null
        see(targets.directory())
        return id.takeIf { directory[it] != null || drafts[it] != null }
    }

    /** [agentId] becomes the latest visited; the oldest past the limit is forgotten, so visiting it again starts from what is there then. */
    private fun visit(agentId: String) {
        visited.remove(agentId)
        visited.add(0, agentId)
        while (visited.size > Limits.VISITED) heard.remove(visited.removeAt(visited.lastIndex))
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

    /** One of `listSessions`' answers. */
    private fun row(target: CallTarget): JsonObject {
        val value = linkedMapOf<String, JsonElement>(
            "targetRef" to JsonPrimitive(ref(target.agentId)),
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
     * A conversation as read: [name], then whether it works or waits for the
     * person, and its turns. Never its kind, status or reference beyond what
     * [name] holds: the directory has those.
     */
    private fun body(state: CallTargetState, turns: List<CallTurn>, name: Map<String, JsonElement>, options: Boolean): JsonObject {
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
        if (options && state.models.isNotEmpty()) value["models"] = models(state.models)
        value["turns"] = JsonArray(turns.map(::turn))
        value["olderTurns"] = JsonPrimitive(state.hasMore || answering(state).size > turns.size)
        state.unanswered?.let { pending ->
            val text = truncated(pending.text, Limits.MESSAGE_BYTES)
            val message = linkedMapOf<String, JsonElement>("text" to JsonPrimitive(text))
            if (text.length < pending.text.length) message["truncated"] = JsonPrimitive(true)
            pending.delivery?.let { message["delivery"] = JsonPrimitive(it.wire) }
            pending.by?.let { message["by"] = JsonPrimitive(it) }
            value["pendingUserMessage"] = JsonObject(message)
        }
        return JsonObject(value)
    }

    companion object {
        private val STALE = CallToolResult.refused("The screen changed since; check the focus again.")

        /** The references `sendMessage` starts new work with, as the first context lists them; a name after a colon names it. */
        const val NEW_TASK_REF = "new-task"
        const val NEW_BOT_REF = "new-bot"

        /** How the first context starts new work, as `sendMessage` takes it. */
        val NEW_WORK_TEXT = """
            New work (only through sendMessage; listed nowhere until its first message makes it):
            - $NEW_TASK_REF — a new task, the message its first
            - $NEW_BOT_REF — a new bot, the message its first
            A name after a colon names it: $NEW_BOT_REF:Release helper.
        """.trimIndent()

        /** `new-task` or `new-bot`, any case, with the name after a colon if one is given; null for any other reference. */
        fun newWork(ref: String): Pair<CallTarget.Kind, String>? {
            val lower = ref.lowercase()
            for ((prefix, kind) in listOf(NEW_TASK_REF to CallTarget.Kind.Task, NEW_BOT_REF to CallTarget.Kind.Bot)) {
                if (lower == prefix) return kind to ""
                if (lower.startsWith("$prefix:")) return kind to CallTarget.clean(ref.substring(prefix.length + 1))
            }
            return null
        }

        /** A refusal for new work named where only `sendMessage` takes it. */
        private fun unmade(value: JsonElement?): CallToolResult? {
            val ref = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            if (newWork(ref) == null) return null
            return CallToolResult.refused("Nothing exists of new work until its first message: start it with sendMessage to $NEW_TASK_REF or $NEW_BOT_REF.")
        }

        /** One turn of the first context: who asked, the agent's last words, and how it ended when that wasn't plain. */
        fun turnText(turn: CallTurn, number: Int): String {
            val lines = ArrayList<String>()
            fun text(words: String?, who: String) {
                if (words.isNullOrEmpty()) return
                val kept = truncated(words, Limits.MESSAGE_BYTES)
                lines += "$who: " + indented(kept) + if (kept.length < words.length) " [cut short]" else ""
            }
            text(turn.user, turn.userBy?.let { if (it == "the person") "The person" else it } ?: "The person")
            text(turn.reply, "Agent")
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

        fun turn(turn: CallTurn): JsonObject {
            val value = linkedMapOf<String, JsonElement>("ended" to JsonPrimitive(turn.ended))
            var cut = false
            fun text(words: String?, key: String) {
                if (words.isNullOrEmpty()) return
                val kept = truncated(words, Limits.MESSAGE_BYTES)
                value[key] = JsonPrimitive(kept)
                if (kept.length < words.length) cut = true
            }
            text(turn.user, "user")
            if (!turn.user.isNullOrEmpty()) turn.userBy?.let { value["userBy"] = JsonPrimitive(it) }
            text(turn.reply, "assistant")
            if (turn.ended == "error") turn.error?.takeIf { it.isNotEmpty() }?.let { value["error"] = JsonPrimitive(truncated(it, Limits.ERROR_BYTES)) }
            if (cut) value["truncated"] = JsonPrimitive(true)
            return JsonObject(value)
        }

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
