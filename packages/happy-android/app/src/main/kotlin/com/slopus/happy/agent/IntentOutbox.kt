package com.slopus.happy.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.File

/**
 * One thing the person did that the computer has yet to hear: a chat read,
 * a task archived, a name given (iOS's `Intent`, docs/offline-first.md).
 * Applied on this phone at once, kept with the connection until answered.
 *
 * [kind] is an open set: the agent home's are [READ], [ARCHIVE], [LEAVE]
 * and [RENAME], and another library adds its own (`todo.create`, …) with a
 * deliverer for them ([IntentOutbox.handle]). [id] goes as the route's
 * `mutationId` where it takes one. [kind]'s slot ([slotOf]) and [target]
 * make the intent's [slot]: a later one replaces one still waiting there.
 */
@Serializable
data class Intent(
    val id: String,
    val kind: String,
    /** The chat, task, bot or Surface it is about. */
    val target: String,
    /** What it carries: `kind` (task, bot, agent, surface), a `title`. */
    val value: JsonObject = JsonObject(emptyMap()),
    /** When it was asked for (ms); the order it is sent in. */
    val createdAt: Long,
    val attempts: Int = 0,
    /** Not sent again before this (ms). */
    val nextAttemptAt: Long = 0,
) {
    val slot: String get() = "${slotOf(kind)}|$target"

    /** What [value] says it is about: `task`, `bot`, `agent` (a subtask) or `surface`. */
    val of: String? get() = (value["kind"] as? JsonPrimitive)?.contentOrNull

    companion object {
        const val READ = "read"
        const val ARCHIVE = "archive"
        const val UNARCHIVE = "unarchive"
        const val LEAVE = "leave"
        const val DELETE = "delete"
        const val RENAME = "rename"

        /** Kinds that set one thing share a slot: an unarchive replaces an archive still waiting. */
        fun slotOf(kind: String): String = when (kind) {
            UNARCHIVE -> ARCHIVE
            SURFACE_JOIN -> LEAVE
            else -> kind
        }
    }
}

/** What a delivery throws when the computer said no for good: the intent is dropped and its overlay goes. */
class IntentRefusal(val reason: String) : Exception(reason)

/** Where a connection keeps its intents. Each call is the whole list; it is short. */
interface IntentStorage {
    suspend fun load(): List<Intent>
    suspend fun save(intents: List<Intent>)
}

/** Kept in memory only: tests, and connections that keep nothing. */
class MemoryIntentStorage : IntentStorage {
    @Volatile private var kept: List<Intent> = emptyList()
    override suspend fun load(): List<Intent> = kept
    override suspend fun save(intents: List<Intent>) { kept = intents }
}

/** Kept in [file] beside the connection's catalog, written whole and swapped in, off the main thread. */
class FileIntentStorage(private val file: File) : IntentStorage {
    private val serializer = ListSerializer(Intent.serializer())

    override suspend fun load(): List<Intent> = withContext(Dispatchers.IO) {
        runCatching { if (file.exists()) AgentClient.json.decodeFromString(serializer, file.readText()) else emptyList() }.getOrDefault(emptyList())
    }

    override suspend fun save(intents: List<Intent>) = withContext(Dispatchers.IO) {
        if (intents.isEmpty()) {
            file.delete()
            return@withContext
        }
        file.parentFile?.mkdirs()
        val next = File(file.parentFile, file.name + ".tmp")
        next.writeText(AgentClient.json.encodeToString(serializer, intents))
        if (!next.renameTo(file)) {
            file.delete()
            next.renameTo(file)
        }
        Unit
    }
}

/**
 * An agent connection's actions on their way (iOS's `IntentOutbox`): kept
 * in [storage], published on [pending] for whoever lays them over what
 * they show ([IntentOverlay]), and sent oldest first while the connection
 * is up ([setOnline]), each by the deliverer [handle]d for its kind. A
 * transient failure waits 1, 2, 4 … 30 s ([backoff]) and lets the rest go
 * meanwhile; an [IntentRefusal] drops the intent and says so on
 * [rejections]. An intent whose kind nothing handles yet waits.
 */
class IntentOutbox(
    scope: CoroutineScope,
    private val storage: IntentStorage,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** A refusal; [heard] when someone waiting on it ([verdict]) was told, so a notice need not say it again. */
    data class Rejection(val intent: Intent, val reason: String, val heard: Boolean)

    /** What became of an intent. */
    sealed interface Verdict {
        /** Taken, or replaced by a later one in its slot. */
        data object Taken : Verdict
        data class Refused(val reason: String) : Verdict
        /** Still on its way when the wait ran out: it stands, and goes later. */
        data object Waiting : Verdict
    }

    /** The kept intent and the answer owned by the screen that asked for its first try. */
    data class AttemptResult(val intent: Intent, val verdict: Verdict)

    private val lock = Mutex()
    private val kept = MutableStateFlow<List<Intent>?>(null)
    private val online = MutableStateFlow(false)
    private val kicks = Channel<Unit>(Channel.CONFLATED)
    private val rejected = MutableSharedFlow<Rejection>(extraBufferCapacity = 16)
    private val deliverers = MutableStateFlow<Map<String, suspend (Intent) -> Unit>>(emptyMap())
    private val waiters = HashMap<String, MutableList<CompletableDeferred<Verdict>>>()
    // A fast background delivery can finish before the caller starts waiting.
    // Keep its answer under lock with removal so that a refusal cannot become Taken.
    private val completed = LinkedHashMap<String, Verdict>()
    private val inFlight = HashSet<String>()
    private val pendingState = MutableStateFlow<List<Intent>>(emptyList())

    /** What is waiting, oldest first: empty until read from the phone, then after every change. */
    val pending: StateFlow<List<Intent>> = pendingState.asStateFlow()

    /** Each refusal, as it comes. */
    val rejections: SharedFlow<Rejection> = rejected.asSharedFlow()

    init {
        scope.launch { lock.withLock { loaded() } }
        scope.launch { online.collectLatest { if (it) run() } }
    }

    /** Sends [kinds] through [deliver]; a kind handled again goes through the newer one. */
    fun handle(kinds: Set<String>, deliver: suspend (Intent) -> Unit) {
        deliverers.value = deliverers.value + kinds.associateWith { deliver }
        kicks.trySend(Unit)
    }

    /** Whether the connection is up. Off stops at once; what was on its way goes again under the same ID. */
    fun setOnline(online: Boolean) {
        this.online.value = online
    }

    /** Sends what is due now rather than at its time: a reconnect. */
    fun kick() {
        kicks.trySend(Unit)
    }

    /** Keeps an action and publishes it, replacing what its slot held; then sends it when it can. */
    suspend fun enqueue(kind: String, target: String, value: JsonObject = JsonObject(emptyMap())): Intent {
        val intent = lock.withLock { enqueueLocked(kind, target, value) }
        kicks.trySend(Unit)
        return intent
    }

    /**
     * Keeps an action and claims its first try before the background drainer
     * can see it. A refusal belongs to this caller, even if delivery is fast:
     * enqueue followed by attempt leaves a gap where home can also be told.
     */
    suspend fun enqueueAndAttempt(kind: String, target: String, value: JsonObject = JsonObject(emptyMap())): AttemptResult {
        val (intent, deliver) = lock.withLock {
            val intent = enqueueLocked(kind, target, value)
            val deliver = deliverers.value[kind]
            if (deliver != null) check(claim(intent.id))
            intent to deliver
        }
        kicks.trySend(Unit)
        return AttemptResult(intent, if (deliver == null) Verdict.Waiting else send(intent, deliver, told = true))
    }

    /** Under [lock], including publication and replacement's completion. */
    private suspend fun enqueueLocked(kind: String, target: String, value: JsonObject): Intent {
        val before = loaded()
        val intent = Intent(AgentClient.newId(), kind, target, value, maxOf(now(), (before.lastOrNull()?.createdAt ?: 0) + 1))
        val replaced = before.firstOrNull { it.slot == intent.slot }
        write(before.filter { it.slot != intent.slot } + intent)
        replaced?.let { finish(it.id, Verdict.Taken) }
        return intent
    }

    /** What became of [id]: taken (or replaced), refused and why, or after [withinMillis] still waiting. */
    suspend fun verdict(id: String, withinMillis: Long? = null): Verdict {
        val waiter = CompletableDeferred<Verdict>()
        lock.withLock {
            completed[id]?.let { return it }
            if (loaded().none { it.id == id }) return Verdict.Taken
            synchronized(waiters) { waiters.getOrPut(id) { mutableListOf() } += waiter }
        }
        val verdict = if (withinMillis == null) waiter.await() else withTimeoutOrNull(withinMillis) { waiter.await() }
        if (verdict == null) synchronized(waiters) { waiters[id]?.remove(waiter) }
        return verdict ?: Verdict.Waiting
    }

    /** Tries [id] once now, connected or not: a person waits on it. Kept as it was if it doesn't go. */
    suspend fun attempt(id: String): Verdict {
        val (intent, deliver, claimed) = lock.withLock {
            completed[id]?.let { return it }
            val intent = loaded().firstOrNull { it.id == id } ?: return Verdict.Taken
            val deliver = deliverers.value[intent.kind] ?: return Verdict.Waiting
            Triple(intent, deliver, claim(id))
        }
        if (!claimed) return verdict(id, ATTEMPT_WAIT_MILLIS)
        return send(intent, deliver, told = true)
    }

    private suspend fun loaded(): List<Intent> = kept.value ?: storage.load()
        .sortedWith(compareBy<Intent>({ it.createdAt }, { it.id }))
        .also { kept.value = it; pendingState.value = it }

    private suspend fun write(list: List<Intent>) {
        kept.value = list
        pendingState.value = list
        storage.save(list)
    }

    private fun claim(id: String): Boolean = synchronized(inFlight) { inFlight.add(id) }

    private fun release(id: String) {
        synchronized(inFlight) { inFlight.remove(id) }
    }

    /** Under [lock], remembers the answer and tells whoever waits; whether anyone did. */
    private fun finish(id: String, verdict: Verdict): Boolean {
        completed[id] = verdict
        if (completed.size > COMPLETED_LIMIT) completed.remove(completed.keys.first())
        val waiting = synchronized(waiters) { waiters.remove(id) }.orEmpty()
        waiting.forEach { it.complete(verdict) }
        return waiting.isNotEmpty()
    }

    private data class Delivery(val intent: Intent, val deliver: suspend (Intent) -> Unit)

    private suspend fun run() {
        while (true) {
            var at: Long? = null
            val next = lock.withLock {
                val handled = deliverers.value
                val due = loaded().filter { it.kind in handled && synchronized(inFlight) { it.id !in inFlight } }
                val intent = due.firstOrNull { it.nextAttemptAt <= now() }
                if (intent == null) {
                    at = due.minOfOrNull { it.nextAttemptAt }
                    null
                } else {
                    // Selection and claim share removal's lock: a foreground
                    // completion cannot leave this runner sending a stale row.
                    check(claim(intent.id))
                    Delivery(intent, handled.getValue(intent.kind))
                }
            }
            if (next == null) {
                val deadline = at
                if (deadline == null) kicks.receive() else withTimeoutOrNull(maxOf(1, deadline - now())) { kicks.receive() }
                continue
            }
            send(next.intent, next.deliver)
        }
    }

    /** One try of [intent], already claimed: gone when taken or refused, else due again later. */
    private suspend fun send(intent: Intent, deliver: suspend (Intent) -> Unit, told: Boolean = false): Verdict {
        try {
            deliver(intent)
            lock.withLock {
                write(loaded().filter { it.id != intent.id })
                finish(intent.id, Verdict.Taken)
            }
            return Verdict.Taken
        } catch (e: CancellationException) {
            throw e
        } catch (refusal: IntentRefusal) {
            val heard = lock.withLock {
                write(loaded().filter { it.id != intent.id })
                finish(intent.id, Verdict.Refused(refusal.reason))
            } || told
            rejected.emit(Rejection(intent, refusal.reason, heard))
            return Verdict.Refused(refusal.reason)
        } catch (_: Exception) {
            val retry = intent.copy(attempts = intent.attempts + 1, nextAttemptAt = now() + backoff(intent.attempts + 1))
            lock.withLock { write(loaded().map { if (it.id == intent.id) retry else it }) }
            return Verdict.Waiting
        } finally {
            release(intent.id)
            // The runner learns its next time, and an [attempt]'s failure is tried again on schedule.
            kicks.trySend(Unit)
        }
    }

    companion object {
        /** Recent completions only; no payloads or connection-lifetime growth. */
        internal const val COMPLETED_LIMIT = 256

        /** How long [attempt] waits on a send already on its way. */
        const val ATTEMPT_WAIT_MILLIS = 60_000L

        /** 1, 2, 4 … 30 seconds after the [attempts]th failure, in ms. */
        fun backoff(attempts: Int): Long = minOf(30L, 1L shl (attempts - 1).coerceIn(0, 5)) * 1000
    }
}

/**
 * The connection's pending intents as home lays them over what the
 * computer last said (iOS's `IntentOverlay`): a chat read here has no dot,
 * a task, bot, subtask or Surface archived or left is gone with what nests
 * under it, a task or bot renamed wears its new name.
 */
data class IntentOverlay(
    /** Chats (agent IDs) read here that the computer may still call unread. */
    val read: Set<String> = emptySet(),
    /** Tasks, bots, subtasks (agent IDs) and Surfaces leaving the list. */
    val removed: Set<String> = emptySet(),
    /** Names given here, by task or bot ID. */
    val titles: Map<String, String> = emptyMap(),
) {
    companion object {
        fun of(intents: List<Intent>): IntentOverlay {
            if (intents.isEmpty()) return IntentOverlay()
            val read = HashSet<String>()
            val removed = HashSet<String>()
            val titles = HashMap<String, String>()
            for (intent in intents) when (intent.kind) {
                Intent.READ -> read += intent.target
                Intent.ARCHIVE, Intent.LEAVE, Intent.DELETE -> removed += intent.target
                Intent.RENAME -> (intent.value["title"] as? JsonPrimitive)?.contentOrNull?.let { titles[intent.target] = it }
            }
            return IntentOverlay(read, removed, titles)
        }
    }
}
