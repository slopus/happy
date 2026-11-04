package com.slopus.happy.todos

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.Intent
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.agent.IntentRefusal
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** One todo list as a screen shows it (iOS's `TodoListState`). */
@Immutable
data class TodoListState(
    val status: Status = Status.Loading,
    /** In the list's order, headings among them. */
    val active: List<TodoItem> = emptyList(),
    /** Newest completed first. */
    val completed: List<TodoItem> = emptyList(),
    /** Newest deleted first; read once asked for ([TodoLibrary.showDeleted]). */
    val deleted: List<TodoItem> = emptyList(),
    val deletedRead: Boolean = false,
    /** The todos with a change still on its way. */
    val waiting: Set<String> = emptySet(),
    /** Authors' names, by user ID. */
    val names: Map<String, String> = emptyMap(),
    /** A change the computer refused, and why: it was undone. */
    val failure: String? = null,
    /** Shown from the phone: the computer hasn't been read this time. */
    val kept: Boolean = true,
) {
    enum class Status {
        /** Nothing kept and the computer not read yet. */
        Loading,
        Ready,
        /** No such todo list (`404`). */
        Missing,
    }
}

/** What the library hears from the connection's journal. */
sealed interface TodoFeedEvent {
    /** A (re)connect: read again whatever is shown. */
    data object Resync : TodoFeedEvent
    data class Event(val type: String, val payload: JsonObject) : TodoFeedEvent
}

/**
 * A connection's todo lists (iOS's `TodoLibrary`): each kept on the phone,
 * read whole from the computer, then kept current by its `todo.*` events;
 * every change a person makes shows at once, is kept in the [outbox], and
 * goes to the computer when it can, in order, under its mutation ID
 * (docs/offline-first.md). A conflict is settled as desktop settles it: the
 * computer's todo is taken and the change applied to it again, up to three
 * times. All state lives on one confined dispatcher, as iOS's actor.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TodoLibrary(
    private val routes: TodoRoutes,
    private val outbox: IntentOutbox,
    /** Reads a kept value, off the main thread. */
    private val kept: suspend (String) -> JsonObject?,
    /** Writes a kept value, off the main thread. */
    private val keep: suspend (String, JsonObject) -> Unit,
    private val scope: CoroutineScope,
    private val now: () -> Double = { System.currentTimeMillis().toDouble() },
) {
    private class ListState {
        val confirmed = HashMap<String, TodoItem>()
        var status = TodoListState.Status.Loading
        var opened = false
        var read = false
        var deletedRead = false
        var failure: String? = null
        var reading: Job? = null
        var again = false
        /** Changed by events while a read was under way. */
        val touched = HashSet<String>()
        val flow = MutableStateFlow(TodoListState())
    }

    private val confined = Dispatchers.Default.limitedParallelism(1)
    private val lists = HashMap<String, ListState>()
    /** Every todo change on its way, oldest first. */
    private var ops: List<Pair<Intent, TodoOp>> = emptyList()
    private val names = HashMap<String, String>()
    private val asked = HashSet<String>()
    private var started = false
    private val revision = MutableStateFlow(0L)

    init {
        outbox.handle(TodoOp.kinds) { intent -> withContext(confined) { deliver(intent) } }
    }

    /** Follows the journal; [events] carries every `todo.*` event and each reconnect. */
    fun follow(events: Flow<TodoFeedEvent>) {
        scope.launch(confined) {
            start()
            events.collect { event ->
                when (event) {
                    TodoFeedEvent.Resync -> lists.forEach { (id, list) -> if (list.flow.subscriptionCount.value > 0) refresh(id) }
                    is TodoFeedEvent.Event -> receive(event.type, event.payload)
                }
            }
        }
    }

    private suspend fun start() {
        if (started) return
        started = true
        ops = todoOps(outbox.pending.value)
        scope.launch(confined) {
            outbox.pending.collect { intents ->
                val next = todoOps(intents)
                val surfaces = (ops.map { it.second.surfaceId } + next.map { it.second.surfaceId }).toSet()
                ops = next
                surfaces.forEach(::publish)
                revision.value++
            }
        }
        scope.launch(confined) {
            outbox.rejections.collect { rejection ->
                val op = TodoOp.of(rejection.intent) ?: return@collect
                val list = lists[op.surfaceId] ?: return@collect
                ops = todoOps(outbox.pending.value)
                list.failure = rejection.reason
                publish(op.surfaceId)
            }
        }
    }

    private fun todoOps(intents: List<Intent>) = intents.mapNotNull { intent -> TodoOp.of(intent)?.let { intent to it } }

    private suspend fun receive(type: String, payload: JsonObject) {
        val surfaceId = payload["surfaceId"].str ?: payload["todo"].obj?.get("surfaceId").str ?: return
        val list = lists[surfaceId]?.takeIf { it.opened } ?: return
        when (val result = TodoReducer.receive(type, payload, surfaceId, list.confirmed)) {
            TodoReducer.EventResult.Ignored -> Unit
            TodoReducer.EventResult.Applied -> {
                if (list.reading != null) (payload["todoId"].str ?: payload["todo"].obj?.get("id").str)?.let(list.touched::add)
                changed(surfaceId)
            }
            is TodoReducer.EventResult.Read -> {
                val todo = try { routes.todo(surfaceId, result.todoId) } catch (e: CancellationException) { throw e } catch (_: Exception) { return }
                take(todo)
            }
        }
    }

    // Lists

    /** The list now and after every change; opens it: what was kept, then the computer. */
    fun states(surfaceId: String): Flow<TodoListState> = flow {
        val list = withContext(confined) {
            start()
            open(surfaceId)
            val list = lists.getValue(surfaceId)
            publish(surfaceId)
            if (!list.read) refresh(surfaceId)
            list
        }
        emitAll(list.flow)
    }

    /** The kept list, read once into memory. */
    private suspend fun open(surfaceId: String) {
        val list = lists.getOrPut(surfaceId, ::ListState)
        if (list.opened) return
        list.opened = true
        val value = kept(resource(surfaceId)) ?: return
        val todos = value["todos"].arr.orEmpty().mapNotNull(TodoItem::parse)
        value["names"].obj?.forEach { (id, name) -> name.str?.let { names.putIfAbsent(id, it) } }
        for (todo in todos) list.confirmed.putIfAbsent(todo.id, todo)
        if (list.status == TodoListState.Status.Loading && (todos.isNotEmpty() || value["read"].bool == true)) list.status = TodoListState.Status.Ready
        list.deletedRead = list.deletedRead || value["deletedRead"].bool == true
        publish(surfaceId)
    }

    /** Reads the list whole again; one under way is followed by one more. */
    fun refresh(surfaceId: String) {
        scope.launch(confined) {
            val list = lists[surfaceId] ?: return@launch
            if (list.reading != null) {
                list.again = true
                return@launch
            }
            list.touched.clear()
            list.reading = scope.launch(confined) { read(surfaceId) }
        }
    }

    private suspend fun read(surfaceId: String) {
        try {
            readOnce(surfaceId)
        } finally {
            val list = lists[surfaceId]
            list?.reading = null
            if (list?.again == true) {
                list.again = false
                refresh(surfaceId)
            }
        }
    }

    private suspend fun readOnce(surfaceId: String) {
        val withDeleted = lists[surfaceId]?.deletedRead == true
        val fetched = try {
            coroutineScope {
                val active = async { routes.todos(surfaceId, TodoItem.Status.Active) }
                val completed = async { routes.todos(surfaceId, TodoItem.Status.Completed) }
                val deleted = if (withDeleted) routes.todos(surfaceId, TodoItem.Status.Deleted) else emptyList()
                active.await() + completed.await() + deleted
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            if (e.status != 404) return
            val list = lists[surfaceId] ?: return
            list.confirmed.clear()
            list.status = TodoListState.Status.Missing
            list.read = true
            publish(surfaceId)
            return
        } catch (_: Exception) {
            return
        }
        val list = lists[surfaceId] ?: return
        val next = LinkedHashMap<String, TodoItem>()
        for (todo in fetched) next.putIfAbsent(todo.id, todo)
        // What deleted reads haven't covered stays as it was known.
        if (!withDeleted) for (todo in list.confirmed.values) if (todo.status == TodoItem.Status.Deleted && todo.id !in next) next[todo.id] = todo
        // Events newer than the read's snapshot stand.
        for (id in list.touched) {
            val held = list.confirmed[id] ?: continue
            val read = next[id]
            if (read != null && !TodoOrder.newer(held.version, read.version)) continue
            next[id] = held
        }
        list.confirmed.clear()
        list.confirmed.putAll(next)
        list.touched.clear()
        list.status = TodoListState.Status.Ready
        list.read = true
        changed(surfaceId)
        readNames(surfaceId)
    }

    /** Reads the deleted todos too, now and in every read after. */
    fun showDeleted(surfaceId: String) {
        scope.launch(confined) {
            open(surfaceId)
            val list = lists[surfaceId] ?: return@launch
            list.deletedRead = true
            publish(surfaceId)
            refresh(surfaceId)
        }
    }

    fun dismissFailure(surfaceId: String) {
        scope.launch(confined) {
            val list = lists[surfaceId] ?: return@launch
            if (list.failure == null) return@launch
            list.failure = null
            publish(surfaceId)
        }
    }

    /** The unfinished todos of each kept list, headings left out; a list never opened here has none. */
    suspend fun outstanding(surfaceIds: List<String>): Map<String, Int> = withContext(confined) {
        start()
        val counts = HashMap<String, Int>()
        for (id in surfaceIds) {
            if (lists[id]?.opened == true) {
                counts[id] = state(id).active.count { it.heading == null }
            } else {
                val value = kept(resource(id)) ?: continue
                val confirmed = value["todos"].arr.orEmpty().mapNotNull(TodoItem::parse).associateBy { it.id }
                val pending = todoOps(outbox.pending.value).map { it.second }.filter { it.surfaceId == id }
                counts[id] = TodoReducer.overlay(confirmed, pending).values.count { it.status == TodoItem.Status.Active && it.heading == null }
            }
        }
        counts
    }

    /** The index follows kept counts without opening or downloading every list. */
    fun outstandingStates(surfaceIds: List<String>): Flow<Map<String, Int>> = revision
        .map { outstanding(surfaceIds) }.distinctUntilChanged()

    // State

    private fun shown(surfaceId: String): Map<String, TodoItem> =
        TodoReducer.overlay(lists[surfaceId]?.confirmed.orEmpty(), ops.filter { it.second.surfaceId == surfaceId }.map { it.second })

    private fun state(surfaceId: String): TodoListState {
        val list = lists[surfaceId] ?: return TodoListState()
        val split = TodoReducer.split(shown(surfaceId))
        val authors = (split.active + split.completed + split.deleted).mapNotNull { it.authorUserId }.toSet()
        // A todo made here is there at once, before the computer is read.
        val status = if (list.status == TodoListState.Status.Loading && split.active.isNotEmpty()) TodoListState.Status.Ready else list.status
        return TodoListState(
            status = status,
            active = split.active,
            completed = split.completed,
            deleted = split.deleted,
            deletedRead = list.deletedRead,
            waiting = ops.filter { it.second.surfaceId == surfaceId }.map { it.second.todoId }.toSet(),
            names = names.filterKeys { it in authors },
            failure = list.failure,
            kept = !list.read,
        )
    }

    private fun publish(surfaceId: String) {
        val list = lists[surfaceId] ?: return
        list.flow.value = state(surfaceId)
        revision.value++
    }

    /** Publishes and writes down list [surfaceId]. */
    private suspend fun changed(surfaceId: String) {
        publish(surfaceId)
        val list = lists[surfaceId] ?: return
        val todos = list.confirmed.values.sortedBy { it.id }
        val authors = todos.mapNotNull { it.authorUserId }.toSet()
        keep(resource(surfaceId), buildJsonObject {
            put("todos", JsonArray(todos.map { it.json() }))
            put("read", JsonPrimitive(list.read))
            put("deletedRead", JsonPrimitive(list.deletedRead))
            put("names", JsonObject(names.filterKeys { it in authors }.mapValues { JsonPrimitive(it.value) }))
        })
    }

    private suspend fun take(todo: TodoItem) {
        val list = lists[todo.surfaceId] ?: return
        if (!TodoReducer.accept(todo, list.confirmed)) return
        if (list.reading != null) list.touched += todo.id
        changed(todo.surfaceId)
    }

    private suspend fun readNames(surfaceId: String) {
        val ids = lists[surfaceId]?.confirmed?.values.orEmpty().mapNotNull { it.authorUserId }.toSet() - names.keys - asked
        if (ids.isEmpty()) return
        asked += ids
        val read = try { routes.names(ids.toList()) } catch (e: CancellationException) { throw e } catch (_: Exception) { asked -= ids; return }
        names.putAll(read)
        changed(surfaceId)
    }

    /** Names for [ids], read where not known yet (a revision's people). */
    private suspend fun names(ids: Set<String>): Map<String, String> {
        val missing = ids - names.keys
        if (missing.isNotEmpty()) {
            try { names.putAll(routes.names(missing.toList())) } catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
        return names.filterKeys { it in ids }
    }

    // Changes

    private suspend fun enqueue(op: TodoOp) {
        start()
        open(op.surfaceId)
        lists[op.surfaceId]?.failure = null
        outbox.enqueue(op.intentKind, op.todoId, op.value)
        // The outbox publishes the change; this shows it without waiting.
        ops = todoOps(outbox.pending.value)
        publish(op.surfaceId)
    }

    /** A new todo at the top; its ID, or null when [text] is nothing. */
    suspend fun add(surfaceId: String, text: String): String? = withContext(confined) {
        val normalized = TodoText.normalized(text) ?: return@withContext null
        open(surfaceId)
        if (lists[surfaceId]?.status == TodoListState.Status.Missing) return@withContext null
        val first = TodoReducer.split(shown(surfaceId)).active.firstOrNull()?.orderKey
        val id = AgentClient.newId()
        enqueue(TodoOp(surfaceId, id, TodoOp.Kind.Create(normalized, TodoOrder.key(null, first)), now()))
        id
    }

    suspend fun setText(surfaceId: String, todoId: String, text: String) = withContext(confined) {
        val normalized = TodoText.normalized(text) ?: return@withContext
        val todo = shown(surfaceId)[todoId] ?: return@withContext
        if (todo.text == normalized) return@withContext
        enqueue(TodoOp(surfaceId, todoId, TodoOp.Kind.Text(normalized), now()))
    }

    /** Done or not done; one done again goes to the end of the list. */
    suspend fun setDone(surfaceId: String, todoId: String, done: Boolean) = withContext(confined) {
        val todo = shown(surfaceId)[todoId] ?: return@withContext
        if (todo.status == TodoItem.Status.Deleted) return@withContext
        val status = if (done) TodoItem.Status.Completed else TodoItem.Status.Active
        if (todo.status == status) return@withContext
        val last = TodoReducer.split(shown(surfaceId)).active.lastOrNull()?.orderKey
        enqueue(TodoOp(surfaceId, todoId, TodoOp.Kind.Status(status, if (done) null else TodoOrder.key(last, null)), now()))
    }

    suspend fun delete(surfaceId: String, todoId: String) = withContext(confined) {
        val todo = shown(surfaceId)[todoId] ?: return@withContext
        if (todo.status == TodoItem.Status.Deleted) return@withContext
        enqueue(TodoOp(surfaceId, todoId, TodoOp.Kind.Status(TodoItem.Status.Deleted), now()))
    }

    /** Where a todo brought back goes. */
    sealed interface Place {
        /** The end of the list, as the computer puts it. */
        data object End : Place
        /** After this todo, or first for null: where an undo had it. */
        data class After(val todoId: String?) : Place
    }

    /** Brings a deleted todo back, active at [place] or completed. */
    suspend fun restore(surfaceId: String, todoId: String, place: Place = Place.End, status: TodoItem.Status = TodoItem.Status.Active) = withContext(confined) {
        val todo = shown(surfaceId)[todoId] ?: return@withContext
        if (todo.status != TodoItem.Status.Deleted || status == TodoItem.Status.Deleted) return@withContext
        val active = TodoReducer.split(shown(surfaceId)).active
        var key: String? = null
        var moves = false
        if (status == TodoItem.Status.Active) {
            when (place) {
                is Place.After -> if (place.todoId != null) {
                    val index = active.indexOfFirst { it.id == place.todoId }
                    if (index >= 0) {
                        key = TodoOrder.key(active[index].orderKey, active.getOrNull(index + 1)?.orderKey)
                        moves = index + 1 < active.size
                    }
                } else {
                    key = TodoOrder.key(null, active.firstOrNull()?.orderKey)
                    moves = active.isNotEmpty()
                }
                Place.End -> Unit
            }
            if (key == null) key = TodoOrder.key(active.lastOrNull()?.orderKey, null)
        }
        enqueue(TodoOp(surfaceId, todoId, TodoOp.Kind.Status(status, key), now()))
        // The computer puts it back at the end; then where it was.
        if (moves && key != null) enqueue(TodoOp(surfaceId, todoId, TodoOp.Kind.Move(key), now()))
    }

    /** Moves an active todo to [index] of the active list. */
    suspend fun move(surfaceId: String, todoId: String, index: Int) = withContext(confined) {
        val active = TodoReducer.split(shown(surfaceId)).active
        val key = TodoReducer.key(todoId, index, active) ?: return@withContext
        enqueue(TodoOp(surfaceId, todoId, TodoOp.Kind.Move(key), now()))
    }

    /** Every revision of a todo, oldest first, with its people's names. */
    suspend fun history(surfaceId: String, todoId: String): Pair<List<TodoRevision>, Map<String, String>> {
        val revisions = routes.versions(surfaceId, todoId)
        val people = (revisions.mapNotNull { it.userId } + revisions.mapNotNull { it.todo.authorUserId }).toSet()
        return revisions to withContext(confined) { names(people) }
    }

    // Delivery

    /**
     * Sends one waiting change: gone when the computer took it or already
     * has it; [IntentRefusal] when it said no for good, after reading the list
     * again; anything else is tried again later.
     */
    private suspend fun deliver(intent: Intent) {
        val op = TodoOp.of(intent) ?: throw IntentRefusal("")
        start()
        // A todo's changes go in the order they were made.
        val pending = outbox.pending.value
        if (pending.any { it.target == intent.target && it.id != intent.id && (it.createdAt < intent.createdAt || (it.createdAt == intent.createdAt && it.id < intent.id)) }) {
            throw TodoWaiting()
        }
        open(op.surfaceId)
        var conflicts = 0
        while (true) {
            val confirmed = lists[op.surfaceId]?.confirmed.orEmpty().toMap()
            val shown = shown(op.surfaceId)
            if (!TodoReducer.needed(op, confirmed, shown)) return
            try {
                val kind = op.kind
                if (kind is TodoOp.Kind.Create) {
                    take(routes.create(op.surfaceId, op.todoId, kind.text, intent.id))
                    return
                }
                val held = confirmed[op.todoId]
                if (held == null) {
                    // Not read on this phone yet: read it, then decide.
                    take(routes.todo(op.surfaceId, op.todoId))
                    if (lists[op.surfaceId]?.confirmed?.containsKey(op.todoId) != true) return
                    continue
                }
                val todo = when (kind) {
                    is TodoOp.Kind.Text -> routes.update(op.surfaceId, op.todoId, kind.text, null, held.version, intent.id)
                    is TodoOp.Kind.Status ->
                        if (kind.status == TodoItem.Status.Deleted) routes.delete(op.surfaceId, op.todoId, held.version, intent.id)
                        else routes.update(op.surfaceId, op.todoId, null, kind.status, held.version, intent.id)
                    is TodoOp.Kind.Move -> routes.reorder(op.surfaceId, op.todoId, TodoReducer.after(op.todoId, shown), held.version, intent.id)
                    is TodoOp.Kind.Create -> return
                }
                take(todo)
                return
            } catch (e: AgentApiException) {
                when {
                    e.status == 409 -> {
                        // Someone changed it first: take theirs, and apply this to it again.
                        conflicts++
                        try { take(routes.todo(op.surfaceId, op.todoId)) } catch (c: CancellationException) { throw c } catch (_: Exception) { }
                        if (conflicts <= CONFLICT_RETRIES) continue
                        throw IntentRefusal(describe(e))
                    }
                    e.status == 404 -> {
                        refresh(op.surfaceId)
                        // A todo gone has nothing left to change; a list gone takes nothing.
                        if (op.kind is TodoOp.Kind.Create) throw IntentRefusal(describe(e))
                        return
                    }
                    e.status in 400..499 && e.status != 408 && e.status != 429 -> {
                        refresh(op.surfaceId)
                        throw IntentRefusal(describe(e))
                    }
                    else -> throw e
                }
            }
        }
    }

    /** What a delivery throws while an earlier change to the same todo waits. */
    private class TodoWaiting : Exception()

    companion object {
        const val CONFLICT_RETRIES = 3

        fun resource(surfaceId: String) = "todos:$surfaceId"

        private fun describe(e: AgentApiException): String = e.message?.takeIf { it.isNotBlank() } ?: e.code ?: "HTTP ${e.status}"
    }
}
