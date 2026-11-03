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
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.time.Instant
import kotlin.coroutines.CoroutineContext

/**
 * What a call tells the hosted agent besides the person's voice: context
 * updates, which it reads silently, and prompts, which ask it to speak (sent
 * only while nobody is).
 */
data class CallUpdate(val context: List<String> = emptyList(), val prompts: List<String> = emptyList()) {
    val isEmpty: Boolean get() = context.isEmpty() && prompts.isEmpty()
}

/**
 * Lives only during one call, bound to one connection (iOS `CallContext`).
 * It owns the opaque references the hosted agent knows conversations by,
 * what it was last told of each, the focus and the watches, and runs the
 * five tools one at a time. Rich updates (words, runs, needs-input) go only
 * for the focused conversation, the watched ones and those this call sent
 * work to; every other conversation contributes its directory row alone.
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
        const val MESSAGES = 20
        const val MESSAGE_BYTES = 4 * 1024
        const val DIRECTORY = 100
        const val PAGE = 50
        const val WATCHES = 7
        const val TEXT_BYTES = 8 * 1024
        /** A conversation's words while the agent writes them, at most this often. */
        const val PARTIAL_INTERVAL_MS = 500L
        const val TOOL_DEADLINE_MS = 8_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + lane)
    private val refs = HashMap<String, String>()
    private val agents = HashMap<String, String>()
    private var nextRef = 1
    private var focus: String? = null
    private var focusRevision = 0
    private var revision = 0
    private val watches = ArrayList<String>()
    private val dispatched = sortedSetOf<String>()
    private val directory = HashMap<String, CallTarget>()
    private val removed = HashSet<String>()
    private val told = HashMap<String, Told>()
    private val sent = HashMap<String, String>()
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

    /** What the agent last heard of one conversation. */
    private data class Told(
        var working: Boolean,
        var needsInput: Boolean,
        val messages: HashMap<String, Heard>,
        var partialAt: Long = Long.MIN_VALUE / 2,
        var lastFinished: String? = null,
    )

    private data class Heard(val text: String, val final: Boolean, val delivery: CallMessage.Delivery? = null)

    /** The conversations that get rich updates now. */
    suspend fun followed(): List<String> = withContext(lane) { followedNow() }

    private fun followedNow(): List<String> {
        val ids = ArrayList<String>()
        focus?.let(ids::add)
        for (id in watches + dispatched) if (id !in ids) ids += id
        return ids
    }

    suspend fun close() = withContext(lane) {
        closed = true
        for (task in results.values) task.cancel()
        scope.cancel()
    }

    // The first snapshot

    /** `initialConversationContext`, the hosted prompt's one variable: the directory, and the focused conversation's recent words. */
    suspend fun initial(): String = withContext(lane) {
        val entries = targets.directory()
        for (entry in entries) directory[entry.agentId] = entry
        focus = targets.focused()
        val focused = focus?.let { targets.state(it) }?.also(::remember)
        revision += 1
        val envelope = linkedMapOf<String, JsonElement>(
            "schema" to JsonPrimitive(1),
            "revision" to JsonPrimitive(revision),
            "at" to JsonPrimitive(timestamp(now())),
            "tools" to JsonArray(CallTool.entries.map { JsonPrimitive(it.wire) }),
            "focusRevision" to JsonPrimitive(focusRevision),
            "watches" to JsonArray(watches.map { JsonPrimitive(ref(it)) }),
        )
        val rows = entries.take(Limits.DIRECTORY).map(::row).toMutableList()
        var directoryTruncated = entries.size > Limits.DIRECTORY
        val history = focused?.messages?.takeLast(Limits.MESSAGES)?.toMutableList() ?: mutableListOf()
        var historyTruncated = (focused?.messages?.size ?: 0) > Limits.MESSAGES || focused?.hasMore == true
        fun encode(): String {
            val value = LinkedHashMap(envelope)
            value["focus"] = focused?.let { body(it, history) } ?: JsonNull
            value["historyTruncated"] = JsonPrimitive(historyTruncated)
            value["directory"] = JsonArray(rows)
            value["directoryTruncated"] = JsonPrimitive(directoryTruncated)
            return CallJson.encode(JsonObject(value))
        }
        var text = encode()
        // History gives way first, then the directory's tail.
        while (text.utf8Size() > Limits.TOTAL_BYTES && history.isNotEmpty()) {
            history.removeAt(0)
            historyTruncated = true
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

    /** Home's conversations changed: names and states, silently. A conversation that went away can't be named again this call. */
    suspend fun directoryChanged(entries: List<CallTarget>): CallUpdate = withContext(lane) {
        if (closed) return@withContext CallUpdate()
        val changed = ArrayList<JsonElement>()
        val ids = entries.mapTo(HashSet()) { it.agentId }
        for (entry in entries.take(Limits.DIRECTORY)) {
            if (directory[entry.agentId] == entry) continue
            directory[entry.agentId] = entry
            changed += row(entry)
        }
        val gone = ArrayList<String>()
        for (id in directory.keys.toList()) {
            if (id in ids) continue
            directory.remove(id)
            removed += id
            watches.remove(id)
            if (refs[id] != null) gone += ref(id)
        }
        if (changed.isEmpty() && gone.isEmpty()) return@withContext CallUpdate()
        val event = linkedMapOf<String, JsonElement>("event" to JsonPrimitive("directory"))
        if (changed.isNotEmpty()) event["changed"] = JsonArray(changed)
        if (gone.isNotEmpty()) event["removed"] = JsonArray(gone.sorted().map(::JsonPrimitive))
        CallUpdate(context = listOf(CallJson.encode(JsonObject(event))))
    }

    /** Something on screen changed which conversation is in front. */
    suspend fun focusChanged(agentId: String?): CallUpdate = withContext(lane) {
        if (closed || agentId == focus) return@withContext CallUpdate()
        focus = agentId
        focusRevision += 1
        val state = agentId?.let { targets.state(it) }
        state?.let(::remember)
        val event = JsonObject(mapOf(
            "event" to JsonPrimitive("focus"),
            "focusRevision" to JsonPrimitive(focusRevision),
            "focus" to (state?.let { body(it, it.messages.takeLast(Limits.MESSAGES)) } ?: JsonNull),
        ))
        CallUpdate(context = listOf(CallJson.encode(event)))
    }

    /**
     * One followed conversation's newest state. What changed since the agent
     * last heard goes as context; a run this call sent work to that finishes,
     * a conversation that comes to need the person, and a message of this
     * call's that failed ask it to speak.
     */
    suspend fun targetChanged(state: CallTargetState): CallUpdate = withContext(lane) { changed(state) }

    private fun changed(state: CallTargetState): CallUpdate {
        val id = state.target.agentId
        if (closed || id !in followedNow()) return CallUpdate()
        val known = told[id] ?: run {
            remember(state)
            val event = JsonObject(mapOf("event" to JsonPrimitive("resync"), "target" to body(state, state.messages.takeLast(Limits.MESSAGES))))
            return CallUpdate(context = listOf(CallJson.encode(event)))
        }
        val at = now()
        val title = state.target.title
        val context = ArrayList<String>()
        val prompts = ArrayList<String>()
        val tracked = id in dispatched
        val partialDue = at - known.partialAt >= Limits.PARTIAL_INTERVAL_MS
        var sentPartial = false

        val present = state.messages.mapTo(HashSet()) { it.id }
        for (messageId in known.messages.keys.sorted()) {
            if (messageId in present) continue
            known.messages.remove(messageId)
            context += event("message_removed", id, "messageId" to JsonPrimitive(messageId))
        }
        for (message in state.messages.takeLast(Limits.MESSAGES)) {
            val previous = known.messages[message.id]
            when (message.role) {
                CallMessage.Role.User -> {
                    if (previous?.text == message.text && previous.delivery == message.delivery) continue
                    known.messages[message.id] = Heard(message.text, true, message.delivery)
                    val extra = ArrayList<Pair<String, JsonElement>>()
                    extra += "message" to message(message)
                    if (sent[message.id] != null) {
                        extra += "fromThisCall" to JsonPrimitive(true)
                        if (message.delivery == CallMessage.Delivery.Failed && previous?.delivery != CallMessage.Delivery.Failed) {
                            prompts += "Your message to $title could not be sent. Tell the person briefly."
                        }
                    }
                    context += event("user_message", id, *extra.toTypedArray())
                }
                CallMessage.Role.Assistant -> {
                    if (previous?.text == message.text && previous.final == message.final) continue
                    if (!message.final && !partialDue) continue
                    if (!message.final) sentPartial = true
                    known.messages[message.id] = Heard(message.text, message.final)
                    context += event("assistant_text", id, "message" to message(message))
                }
            }
        }
        if (sentPartial) known.partialAt = at

        if (state.working != known.working) {
            known.working = state.working
            context += event(if (state.working) "run_started" else "run_finished", id)
        }
        // Finished is the agent's reply after this call's last message, with the
        // run over: a status that only flickers to idle before the message is
        // taken, or between runs, says nothing.
        if (tracked && !state.working) {
            val reply = state.messages.indexOfLast { it.role == CallMessage.Role.Assistant }
            val asked = state.messages.indexOfLast { sent[it.id] == id }
            if (reply >= 0 && asked >= 0 && reply > asked && state.messages[reply].id != known.lastFinished) {
                known.lastFinished = state.messages[reply].id
                prompts += "$title finished. Tell the person its latest reply in a sentence or two."
            }
        }
        if (state.needsInput != known.needsInput) {
            known.needsInput = state.needsInput
            context += event("needs_input", id, "needsInput" to JsonPrimitive(state.needsInput))
            if (state.needsInput) prompts += "$title needs the person in the app. Say so briefly; don't try to answer it."
        }
        return CallUpdate(context, prompts)
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

    private suspend fun execute(tool: CallTool, arguments: JsonObject, call: String): CallToolResult = when (tool) {
        CallTool.ListSessions -> {
            val query = arguments.string("query")?.trim()?.lowercase().orEmpty()
            val start = arguments.string("cursor")?.toIntOrNull()?.coerceAtLeast(0) ?: 0
            val entries = targets.directory()
            for (entry in entries) directory[entry.agentId] = entry
            val matching = if (query.isEmpty()) entries else entries.filter { query in it.title.lowercase() }
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
                else -> CallToolResult.json(body(state, state.messages.takeLast(Limits.MESSAGES)))
            }
        }

        CallTool.OpenSession -> {
            val id = resolve(arguments["targetRef"])
            when {
                id == null -> CallToolResult.refused("No such conversation.")
                revisionOf(arguments["focusRevision"]) != focusRevision -> STALE
                !targets.open(id) -> CallToolResult.refused("It didn't open.")
                else -> CallToolResult.json(JsonObject(mapOf("opened" to JsonPrimitive(true), "targetRef" to JsonPrimitive(ref(id)))))
            }
        }

        CallTool.SetSessionWatch -> {
            val id = resolve(arguments["targetRef"])
            val enabled = booleanOf(arguments["enabled"])
            if (id == null) {
                CallToolResult.refused("No such conversation.")
            } else if (enabled == null) {
                CallToolResult.refused("enabled must be true or false.")
            } else {
                var refused: CallToolResult? = null
                if (enabled && id !in watches) {
                    if (watches.size >= Limits.WATCHES) {
                        refused = CallToolResult.refused("Already following ${Limits.WATCHES}; stop one first.")
                    } else {
                        watches += id
                        targets.follow(id, true)
                    }
                } else if (!enabled && id in watches) {
                    watches.remove(id)
                    if (focus != id && id !in dispatched) targets.follow(id, false)
                }
                refused ?: CallToolResult.json(JsonObject(mapOf("watching" to JsonArray(watches.map { JsonPrimitive(ref(it)) }))))
            }
        }

        CallTool.SendMessage -> send(arguments, call)
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
            CallSendOutcome.Queued -> {
                sent[messageId] = id
                if (dispatched.add(id) && told[id] == null) remember(state)
                targets.follow(id, true)
                CallToolResult.json(JsonObject(mapOf("status" to JsonPrimitive("queued"), "targetRef" to JsonPrimitive(ref(id)))))
            }
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

    private fun remember(state: CallTargetState) {
        val messages = HashMap<String, Heard>()
        for (message in state.messages.takeLast(Limits.MESSAGES)) messages[message.id] = Heard(message.text, message.final, message.delivery)
        told[state.target.agentId] = Told(
            working = state.working, needsInput = state.needsInput, messages = messages,
            lastFinished = if (state.working) null else state.messages.lastOrNull { it.role == CallMessage.Role.Assistant }?.id,
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

    private fun body(state: CallTargetState, messages: List<CallMessage>): JsonObject {
        val value = LinkedHashMap(row(state.target))
        value["working"] = JsonPrimitive(state.working)
        value["needsInput"] = JsonPrimitive(state.needsInput)
        value["writable"] = JsonPrimitive(state.writable)
        value["hasDraft"] = JsonPrimitive(state.hasDraft)
        value["olderMessages"] = JsonPrimitive(state.hasMore || state.messages.size > messages.size)
        value["messages"] = JsonArray(messages.map(::message))
        return JsonObject(value)
    }

    private fun event(name: String, agentId: String, vararg extra: Pair<String, JsonElement>): String {
        val value = linkedMapOf<String, JsonElement>("event" to JsonPrimitive(name), "target" to JsonPrimitive(ref(agentId)))
        value.putAll(extra)
        return CallJson.encode(JsonObject(value))
    }

    companion object {
        private val STALE = CallToolResult.refused("The screen changed since; check the focus again.")

        fun message(message: CallMessage): JsonObject {
            val text = truncated(message.text, Limits.MESSAGE_BYTES)
            val value = linkedMapOf<String, JsonElement>(
                "id" to JsonPrimitive(message.id),
                "role" to JsonPrimitive(message.role.wire),
                "text" to JsonPrimitive(text),
                "final" to JsonPrimitive(message.final),
            )
            if (text.length < message.text.length) value["truncated"] = JsonPrimitive(true)
            message.time?.let { value["at"] = JsonPrimitive(timestamp(it)) }
            message.delivery?.let { value["delivery"] = JsonPrimitive(it.wire) }
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

        /** A JSON boolean: never 0, 1, "true" or null. */
        private fun booleanOf(value: JsonElement?): Boolean? =
            (value as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull }?.booleanOrNull

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
