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
import kotlin.coroutines.CoroutineContext

/** What a call adds to the hosted agent's context as things change: JSON lines it reads without answering. Nothing here asks it to speak. */
data class CallUpdate(val context: List<String> = emptyList()) {
    val isEmpty: Boolean get() = context.isEmpty()
}

/**
 * Lives only during one call, bound to one connection (iOS `CallContext`).
 * It owns the opaque references the hosted agent knows conversations by, the
 * focus, and the last four conversations the person visited during the
 * call, which are the ones it hears from; it runs the four tools one at a
 * time. A visited conversation says only what its agent writes from then on,
 * as it comes, and an error that stopped it: never its tools, its state or
 * the person's messages. Every other conversation contributes its directory
 * row alone.
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
    private val lane: CoroutineContext = Dispatchers.Default.limitedParallelism(1),
) {
    object Limits {
        const val TOTAL_BYTES = 32 * 1024
        /** Finished turns a read shows: the person's message and the agent's final answer each. */
        const val TURNS = 2
        const val MESSAGE_BYTES = 4 * 1024
        const val ERROR_BYTES = 1024
        const val DIRECTORY = 100
        const val PAGE = 50
        /** Conversations the call hears from: the last ones visited, the one on screen included. */
        const val VISITED = 4
        /** The agent's messages looked at per change, newest last. */
        const val MESSAGES = 20
        const val TEXT_BYTES = 8 * 1024
        /** A conversation's new words while its agent writes them, at most this often. */
        const val STREAM_INTERVAL_MS = 500L
        const val TOOL_DEADLINE_MS = 8_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + lane)
    private val refs = HashMap<String, String>()
    private val agents = HashMap<String, String>()
    private var nextRef = 1
    private var focus: String? = null
    private var focusRevision = 0
    /** The first snapshot has been made: until then the directory it will hold is news to no one. */
    private var begun = false
    /** Newest first. */
    private val visited = ArrayList<String>()
    private val directory = HashMap<String, CallTarget>()
    private val removed = HashSet<String>()
    private val heard = HashMap<String, Heard>()
    private var updates = 0
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
     * What the agent has of one visited conversation: the words of each of
     * its agent's messages, those there when it was first seen counted as
     * had, and the errors it knows of.
     */
    private class Heard(
        var said: Map<String, Said> = emptyMap(),
        var errors: Set<String> = emptySet(),
        /** The errors this call told of, by turn, with what it said. */
        var told: Map<String, String?> = emptyMap(),
        var at: Long = Long.MIN_VALUE / 2,
    )

    /**
     * [full]: at [Limits.MESSAGE_BYTES], nothing more of it goes. [final]: its
     * end was told (or it was finished when first seen). [streamed]: words of
     * it went during the call, the last time at this count of its updates.
     */
    private data class Said(val text: String, val full: Boolean, val final: Boolean, val streamed: Int? = null)

    /** The conversations the call hears from now, the latest visited first. */
    suspend fun followed(): List<String> = withContext(lane) { visited.toList() }

    suspend fun close() = withContext(lane) {
        closed = true
        for (task in results.values) task.cancel()
        scope.cancel()
    }

    // The first snapshot

    /** `initialConversationContext`, the hosted prompt's one variable: the directory, and the conversation on screen with its last two finished turns. */
    suspend fun initial(): String = withContext(lane) {
        begun = true
        val entries = targets.directory()
        for (entry in entries) directory[entry.agentId] = entry
        val focused = targets.focused()
        focus = focused
        var state: CallTargetState? = null
        if (focused != null) {
            visit(focused)
            state = targets.state(focused)?.also { if (heard[focused] == null) listen(it) }
        }
        val envelope = linkedMapOf<String, JsonElement>(
            "schema" to JsonPrimitive(1),
            "at" to JsonPrimitive(timestamp(now())),
            "tools" to JsonArray(CallTool.entries.map { JsonPrimitive(it.wire) }),
            "focusRevision" to JsonPrimitive(focusRevision),
        )
        val rows = entries.take(Limits.DIRECTORY).map(::row).toMutableList()
        var directoryTruncated = entries.size > Limits.DIRECTORY
        val turns = state?.let(::recent)?.toMutableList() ?: mutableListOf()
        fun encode(): String {
            val value = LinkedHashMap(envelope)
            value["focus"] = state?.let { body(it, turns) } ?: JsonNull
            value["directory"] = JsonArray(rows)
            value["directoryTruncated"] = JsonPrimitive(directoryTruncated)
            return CallJson.encode(JsonObject(value))
        }
        var text = encode()
        // The older turn gives way first, then the directory's tail.
        while (text.utf8Size() > Limits.TOTAL_BYTES && turns.isNotEmpty()) {
            turns.removeAt(0)
            text = encode()
        }
        while (text.utf8Size() > Limits.TOTAL_BYTES && rows.isNotEmpty()) {
            rows.removeAt(rows.lastIndex)
            directoryTruncated = true
            text = encode()
        }
        text
    }

    // What changes

    /**
     * Home's conversations came, went or were renamed: silently, and not for
     * a status, which a read gives. A conversation that went away can't be
     * named again this call, and is no longer heard from.
     */
    suspend fun directoryChanged(entries: List<CallTarget>): CallUpdate = withContext(lane) {
        if (closed || !begun) return@withContext CallUpdate()
        val changed = ArrayList<JsonElement>()
        val ids = entries.mapTo(HashSet()) { it.agentId }
        for (entry in entries.take(Limits.DIRECTORY)) {
            val old = directory.put(entry.agentId, entry)
            if (old?.title != entry.title || old.kind != entry.kind || old.project != entry.project) changed += row(entry)
        }
        val gone = ArrayList<String>()
        for (id in directory.keys.toList()) {
            if (id in ids) continue
            directory.remove(id)
            removed += id
            visited.remove(id)
            heard.remove(id)
            if (refs[id] != null) gone += ref(id)
        }
        if (changed.isEmpty() && gone.isEmpty()) return@withContext CallUpdate()
        val event = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("directory"))
        if (changed.isNotEmpty()) event["changed"] = JsonArray(changed)
        if (gone.isNotEmpty()) event["removed"] = JsonArray(gone.sorted().map(::JsonPrimitive))
        CallUpdate(context = listOf(CallJson.encode(JsonObject(event))))
    }

    /**
     * Something on screen changed which conversation is in front. A
     * conversation becomes the latest visited; the fifth one back is no
     * longer heard from. Settings or home in front keep them all.
     */
    suspend fun focusChanged(agentId: String?): CallUpdate = withContext(lane) {
        if (closed || agentId == focus) return@withContext CallUpdate()
        focus = agentId
        focusRevision += 1
        val event = linkedMapOf<String, JsonElement>(
            "event" to JsonPrimitive("focus"),
            "focusRevision" to JsonPrimitive(focusRevision),
            "targetRef" to JsonNull,
        )
        if (agentId != null) {
            visit(agentId)
            event["targetRef"] = JsonPrimitive(ref(agentId))
            directory[agentId]?.let { event["title"] = JsonPrimitive(it.title) }
        }
        CallUpdate(context = listOf(CallJson.encode(JsonObject(event))))
    }

    /**
     * One visited conversation's newest state. The first one the call sees is
     * what was there already, and says nothing; after it, only the agent's
     * new words, at most every half second while it writes (`assistant_text`,
     * the words since the last), a message rewritten rather than added to
     * (`assistant_text_reset`, the whole of it), and a turn an error ended
     * (`session_error`).
     */
    suspend fun targetChanged(state: CallTargetState): CallUpdate = withContext(lane) { changed(state) }

    private fun changed(state: CallTargetState): CallUpdate {
        val id = state.target.agentId
        if (closed || id !in visited) return CallUpdate()
        val known = heard[id] ?: run {
            listen(state)
            return CallUpdate()
        }
        val at = now()
        val due = !state.working || at - known.at >= Limits.STREAM_INTERVAL_MS
        val context = ArrayList<String>()
        val said = known.said.toMutableMap()
        var streamed = false
        for (message in state.messages.takeLast(Limits.MESSAGES)) {
            if (message.role != CallMessage.Role.Assistant) continue
            var had = said[message.id] ?: Said("", full = false, final = false)
            // Words to send, or the same words now finished: their end goes once.
            if (!due || had.full || (message.text == had.text && (!message.final || had.final))) continue
            updates += 1
            val event = linkedMapOf<String, JsonElement>(
                "target" to JsonPrimitive(ref(id)),
                "messageId" to JsonPrimitive(message.id),
                "final" to JsonPrimitive(message.final),
            )
            if (message.text.startsWith(had.text)) {
                val room = (Limits.MESSAGE_BYTES - had.text.utf8Size()).coerceAtLeast(0)
                var delta = message.text.substring(had.text.length)
                var full = false
                if (delta.utf8Size() > room) {
                    delta = truncated(delta, room)
                    full = true
                    event["truncated"] = JsonPrimitive(true)
                }
                had = Said(had.text + delta, full, message.final, updates)
                event["event"] = JsonPrimitive("assistant_text")
                event["delta"] = JsonPrimitive(delta)
            } else {
                val text = truncated(message.text, Limits.MESSAGE_BYTES)
                had = Said(text, text.length < message.text.length, message.final, updates)
                event["event"] = JsonPrimitive("assistant_text_reset")
                event["text"] = JsonPrimitive(text)
                if (had.full) event["truncated"] = JsonPrimitive(true)
            }
            said[message.id] = had
            streamed = true
            context += CallJson.encode(JsonObject(event))
        }
        if (streamed) known.at = at
        val present = state.messages.mapTo(HashSet()) { it.id }
        known.said = said.filterKeys { it in present }
        val told = known.told.toMutableMap()
        for (turn in state.turns) {
            if (turn.ended != "error" || turn.id in known.errors) continue
            val reason = turn.error?.takeIf { it.isNotEmpty() }?.let { truncated(it, Limits.ERROR_BYTES) }
            told[turn.id] = reason
            context += stopped(id, reason)
        }
        known.errors = state.turns.filter { it.ended == "error" }.mapTo(HashSet()) { it.id }
        known.told = told.filterKeys { it in known.errors }
        return CallUpdate(context)
    }

    /**
     * The context waiting for the call was too much and went unsent
     * ([CallSession.PENDING_BYTES]): what the agent now has wrong is put right
     * in one go, within half of [Limits.TOTAL_BYTES] so it never overflows the
     * wait itself. The focus as it is now, marked `resync`, then the errors
     * this call told of and each message it streamed, whole as far as it went
     * (`assistant_text_reset`), the most recent kept first. What doesn't fit
     * is counted in `omitted`; a read (`getSessionContext`) has it.
     */
    suspend fun resync(): CallUpdate = withContext(lane) {
        if (closed) return@withContext CallUpdate()
        val errors = ArrayList<String>()
        val streamed = ArrayList<Pair<Int, String>>()
        for (id in visited) {
            val known = heard[id] ?: continue
            for ((messageId, said) in known.said) {
                val at = said.streamed ?: continue
                val event = linkedMapOf<String, JsonElement>(
                    "event" to JsonPrimitive("assistant_text_reset"),
                    "target" to JsonPrimitive(ref(id)),
                    "messageId" to JsonPrimitive(messageId),
                    "text" to JsonPrimitive(said.text),
                    "final" to JsonPrimitive(said.final),
                )
                if (said.full) event["truncated"] = JsonPrimitive(true)
                streamed += at to CallJson.encode(JsonObject(event))
            }
            for (turn in known.told.keys.sorted()) errors += stopped(id, known.told[turn])
        }
        val focusEvent = linkedMapOf<String, JsonElement>(
            "event" to JsonPrimitive("focus"),
            "focusRevision" to JsonPrimitive(focusRevision),
            "targetRef" to JsonNull,
            "resync" to JsonPrimitive(true),
        )
        focus?.let { focused ->
            focusEvent["targetRef"] = JsonPrimitive(ref(focused))
            directory[focused]?.let { focusEvent["title"] = JsonPrimitive(it.title) }
        }
        var bytes = CallJson.encode(JsonObject(focusEvent)).utf8Size() + 32
        fun fits(item: String) = (bytes + item.utf8Size() + 1 <= Limits.TOTAL_BYTES / 2).also { if (it) bytes += item.utf8Size() + 1 }
        val keptErrors = errors.filter(::fits)
        // The most recent first while they fit, then oldest first, as they would have come.
        val keptWords = streamed.sortedByDescending { it.first }.map { it.second }.filter(::fits).reversed()
        val omitted = errors.size + streamed.size - keptErrors.size - keptWords.size
        if (omitted > 0) focusEvent["omitted"] = JsonPrimitive(omitted)
        CallUpdate(listOf(CallJson.encode(JsonObject(focusEvent))) + keptErrors + keptWords)
    }

    private fun stopped(agentId: String, reason: String?): String {
        val event = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("session_error"), "target" to JsonPrimitive(ref(agentId)))
        reason?.let { event["reason"] = JsonPrimitive(it) }
        return CallJson.encode(JsonObject(event))
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
                val entries = targets.directory()
                for (entry in entries) directory[entry.agentId] = entry
                val matching = if (needle.isEmpty()) entries else entries.filter { needle in it.title.lowercase() }
                val page = matching.drop(start).take(Limits.PAGE)
                val value = linkedMapOf<String, JsonElement>("sessions" to JsonArray(page.map(::row)))
                if (start + page.size < matching.size) value["nextCursor"] = JsonPrimitive((start + page.size).toString())
                CallToolResult.json(JsonObject(value))
            }

            CallTool.GetSessionContext -> {
                val id = resolve(arguments["targetRef"])
                val state = id?.let { targets.state(it) }
                when {
                    id == null -> CallToolResult.refused("No such conversation.")
                    state == null -> CallToolResult.refused("That conversation can't be read now.")
                    else -> CallToolResult.json(body(state, recent(state)))
                }
            }

            CallTool.OpenSession -> {
                val id = resolve(arguments["targetRef"])
                when {
                    id == null -> CallToolResult.refused("No such conversation.")
                    revisionOf(arguments["focusRevision"]) != focusRevision -> STALE
                    !targets.open(id) -> CallToolResult.refused("It didn't open.")
                    else -> {
                        // In front now as far as the call goes, with the revision the
                        // next step takes. The screen says so too; whichever of the two
                        // comes second says nothing.
                        focusChanged(id)
                        CallToolResult.json(JsonObject(mapOf(
                            "opened" to JsonPrimitive(true), "targetRef" to JsonPrimitive(ref(id)), "focusRevision" to JsonPrimitive(focusRevision),
                        )))
                    }
                }
            }

            CallTool.SendMessage -> send(arguments, call)
        }
    }

    private suspend fun send(arguments: JsonObject, call: String): CallToolResult {
        val id = resolve(arguments["targetRef"]) ?: return CallToolResult.refused("No such conversation.")
        val text = arguments.string("text")
        if (text == null || text.isBlank()) return CallToolResult.refused("There's nothing to send.")
        if (text.utf8Size() > Limits.TEXT_BYTES) return CallToolResult.refused("That message is too long to send by voice.")
        val asOf = revisionOf(arguments["focusRevision"])
        if (asOf != focusRevision) return STALE
        val state = targets.state(id) ?: return CallToolResult.refused("That conversation can't be read now.")
        if (!state.writable) return CallToolResult.refused("That conversation can't take a message now.")
        if (state.needsInput) return CallToolResult.refused("It's waiting for the person in the app; answer there first.")
        // Reading it was a wait: the screen, or the call, may have moved on.
        if (closed) return CallToolResult.refused("The call has ended.")
        if (asOf != focusRevision) return STALE
        val key = "$id\u0000$text"
        val messageId = unsettled[key] ?: ConversationApi.clientId()
        unsettled[key] = messageId
        settling[call] = key
        return when (val outcome = targets.send(id, text, messageId)) {
            CallSendOutcome.Queued -> CallToolResult.json(JsonObject(mapOf(
                "status" to JsonPrimitive("queued"), "targetRef" to JsonPrimitive(ref(id)), "delivery" to JsonPrimitive(QUEUED),
            )))
            is CallSendOutcome.Refused -> CallToolResult.refused(outcome.reason)
        }
    }

    // References and bodies

    private fun ref(agentId: String): String = refs.getOrPut(agentId) {
        "s${nextRef++}".also { agents[it] = agentId }
    }

    private fun resolve(value: JsonElement?): String? {
        val ref = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val id = agents[ref] ?: return null
        return id.takeIf { it !in removed }
    }

    /** [agentId] becomes the latest visited; the oldest past the limit is forgotten, so visiting it again starts from what is there then. */
    private fun visit(agentId: String) {
        visited.remove(agentId)
        visited.add(0, agentId)
        while (visited.size > Limits.VISITED) heard.remove(visited.removeAt(visited.lastIndex))
    }

    /**
     * What is there when the call first sees a conversation is had: the
     * agent's finished messages and the errors so far. A reply still being
     * written is new, and goes from its start.
     */
    private fun listen(state: CallTargetState) {
        heard[state.target.agentId] = Heard(
            said = state.messages.filter { it.role == CallMessage.Role.Assistant && it.final }
                .associate { it.id to Said(it.text, it.text.utf8Size() >= Limits.MESSAGE_BYTES, final = true) },
            errors = state.turns.filter { it.ended == "error" }.mapTo(HashSet()) { it.id },
        )
    }

    private fun row(target: CallTarget): JsonObject {
        val value = linkedMapOf<String, JsonElement>(
            "targetRef" to JsonPrimitive(ref(target.agentId)),
            "title" to JsonPrimitive(target.title),
            "kind" to JsonPrimitive(target.kind.wire),
            "status" to JsonPrimitive(target.status.wire),
        )
        target.project?.let { value["project"] = JsonPrimitive(it) }
        return JsonObject(value)
    }

    private fun body(state: CallTargetState, turns: List<CallTurn>): JsonObject {
        val value = LinkedHashMap(row(state.target))
        value["working"] = JsonPrimitive(state.working)
        value["needsInput"] = JsonPrimitive(state.needsInput)
        value["turns"] = JsonArray(turns.map(::turn))
        value["olderTurns"] = JsonPrimitive(state.hasMore || answering(state).size > turns.size)
        state.unanswered?.let { pending ->
            val text = truncated(pending.text, Limits.MESSAGE_BYTES)
            val message = linkedMapOf<String, JsonElement>("text" to JsonPrimitive(text))
            if (text.length < pending.text.length) message["truncated"] = JsonPrimitive(true)
            pending.delivery?.let { message["delivery"] = JsonPrimitive(it.wire) }
            value["pendingUserMessage"] = JsonObject(message)
        }
        return JsonObject(value)
    }

    companion object {
        private val STALE = CallToolResult.refused("The screen changed since; check the focus again.")

        /** What "queued" is, in the result as well as the tool's description: told only the status, the agent says "sent". */
        const val QUEUED = "on the person's device, not confirmed delivered or read"

        /** The last finished turns that answered or failed: what a read shows. */
        fun recent(state: CallTargetState): List<CallTurn> = answering(state).takeLast(Limits.TURNS)

        private fun answering(state: CallTargetState): List<CallTurn> =
            state.turns.filter { !it.reply.isNullOrEmpty() || it.ended == "error" }

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
            text(turn.reply, "assistant")
            if (turn.ended == "error") turn.error?.takeIf { it.isNotEmpty() }?.let { value["error"] = JsonPrimitive(truncated(it, Limits.ERROR_BYTES)) }
            if (cut) value["truncated"] = JsonPrimitive(true)
            return JsonObject(value)
        }

        /** The longest prefix of whole characters (code points) within [bytes] of UTF-8. */
        fun truncated(text: String, bytes: Int): String {
            if (text.utf8Size() <= bytes) return text
            var count = 0
            var end = 0
            while (end < text.length) {
                val point = text.codePointAt(end)
                val size = String(Character.toChars(point)).utf8Size()
                if (count + size > bytes) break
                count += size
                end += Character.charCount(point)
            }
            return text.substring(0, end)
        }

        fun timestamp(millis: Long): String = Instant.ofEpochSecond(millis / 1000).toString()

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
