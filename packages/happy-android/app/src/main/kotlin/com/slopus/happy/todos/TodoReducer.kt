package com.slopus.happy.todos

import com.slopus.happy.agent.Intent
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * A change a person made to a todo here, waiting in the connection's
 * [IntentOutbox] until the computer takes it (iOS's `TodoOp`). It also says
 * where the todo shows meanwhile: `orderKey` and [at] (ms) are local.
 */
data class TodoOp(val surfaceId: String, val todoId: String, val kind: Kind, val at: Double) {
    sealed interface Kind {
        data class Create(val text: String, val orderKey: String) : Kind
        data class Text(val text: String) : Kind
        /** To active (with where it shows), completed or deleted. */
        data class Status(val status: TodoItem.Status, val orderKey: String? = null) : Kind
        /** Placed after the todo before it in the list as it stands here when sent. */
        data class Move(val orderKey: String) : Kind
    }

    /** The outbox kind it waits under: one per todo for each. */
    val intentKind: String
        get() = when (kind) {
            is Kind.Create -> CREATE
            is Kind.Text -> TEXT
            is Kind.Status -> STATUS
            is Kind.Move -> MOVE
        }

    val value: JsonObject
        get() = buildJsonObject {
            put("surfaceId", JsonPrimitive(surfaceId))
            put("at", JsonPrimitive(at))
            when (kind) {
                is Kind.Create -> { put("text", JsonPrimitive(kind.text)); put("orderKey", JsonPrimitive(kind.orderKey)) }
                is Kind.Text -> put("text", JsonPrimitive(kind.text))
                is Kind.Status -> { put("status", JsonPrimitive(kind.status.wire)); kind.orderKey?.let { put("orderKey", JsonPrimitive(it)) } }
                is Kind.Move -> put("orderKey", JsonPrimitive(kind.orderKey))
            }
        }

    companion object {
        const val CREATE = "todo.create"
        const val TEXT = "todo.text"
        const val STATUS = "todo.status"
        const val MOVE = "todo.move"
        val kinds = setOf(CREATE, TEXT, STATUS, MOVE)

        /** The op an intent carries, null for one that isn't a todo's. */
        fun of(intent: Intent): TodoOp? {
            val value = intent.value
            val surfaceId = value["surfaceId"].str ?: return null
            val at = value["at"].num ?: intent.createdAt.toDouble()
            val key = value["orderKey"].str
            val kind: Kind = when (intent.kind) {
                CREATE -> Kind.Create(value["text"].str ?: return null, key.orEmpty())
                TEXT -> Kind.Text(value["text"].str ?: return null)
                STATUS -> Kind.Status(TodoItem.Status.of(value["status"].str) ?: return null, key)
                MOVE -> Kind.Move(key.orEmpty())
                else -> return null
            }
            return TodoOp(surfaceId, intent.target, kind, at)
        }
    }
}

/**
 * A todo list as this phone shows it, worked out from what the computer
 * last said and the changes still on their way, as desktop's todo store and
 * iOS's `TodoReducer` do. Pure: the library and its tests drive it.
 */
object TodoReducer {
    /** [todo] with [op] laid over it; null where there is still no todo. */
    fun apply(op: TodoOp, todo: TodoItem?): TodoItem? {
        val kind = op.kind
        if (kind is TodoOp.Kind.Create) {
            return todo ?: TodoItem(op.todoId, op.surfaceId, kind.text, TodoItem.Status.Active, kind.orderKey, createdAt = op.at, updatedAt = op.at)
        }
        todo ?: return null
        return when (kind) {
            is TodoOp.Kind.Create -> todo
            is TodoOp.Kind.Text -> todo.copy(text = kind.text)
            is TodoOp.Kind.Status -> when {
                todo.status == kind.status -> todo
                kind.status == TodoItem.Status.Active -> todo.copy(status = TodoItem.Status.Active, orderKey = kind.orderKey ?: todo.orderKey, completedAt = null, deletedAt = null)
                kind.status == TodoItem.Status.Completed -> todo.copy(status = TodoItem.Status.Completed, orderKey = null, completedAt = op.at, deletedAt = null)
                else -> todo.copy(status = TodoItem.Status.Deleted, orderKey = null, deletedAt = op.at)
            }
            is TodoOp.Kind.Move -> if (todo.status == TodoItem.Status.Active) todo.copy(orderKey = kind.orderKey) else todo
        }
    }

    /** Every todo as it shows: [confirmed] with [ops] laid over in order. */
    fun overlay(confirmed: Map<String, TodoItem>, ops: List<TodoOp>): Map<String, TodoItem> {
        if (ops.isEmpty()) return confirmed
        val shown = confirmed.toMutableMap()
        for (op in ops) apply(op, shown[op.todoId])?.let { shown[op.todoId] = it }
        return shown
    }

    data class Split(val active: List<TodoItem>, val completed: List<TodoItem>, val deleted: List<TodoItem>)

    /** The three lists, each in its order. */
    fun split(todos: Map<String, TodoItem>): Split {
        val groups = todos.values.groupBy { it.status }
        return Split(
            groups[TodoItem.Status.Active].orEmpty().sortedWith(TodoOrder.active),
            groups[TodoItem.Status.Completed].orEmpty().sortedWith(TodoOrder.completed),
            groups[TodoItem.Status.Deleted].orEmpty().sortedWith(TodoOrder.deleted),
        )
    }

    /** Takes [todo] from the computer into [confirmed] unless what is held is as new. */
    fun accept(todo: TodoItem, confirmed: MutableMap<String, TodoItem>): Boolean {
        val held = confirmed[todo.id]
        if (held != null && !TodoOrder.newer(todo.version, held.version)) return false
        confirmed[todo.id] = todo
        return true
    }

    /** What one of the stream's `todo.*` events did. */
    sealed interface EventResult {
        /** Nothing to do: another list's, or older than what is held. */
        data object Ignored : EventResult
        data object Applied : EventResult
        /** The chain broke here, or the todo is new to this phone: read it. */
        data class Read(val todoId: String) : EventResult
    }

    /** Applies the event [type] with [payload] to list [surfaceId]. */
    fun receive(type: String, payload: JsonObject, surfaceId: String, confirmed: MutableMap<String, TodoItem>): EventResult {
        when (type) {
            "todo.created" -> {
                val todo = TodoItem.parse(payload["todo"])?.takeIf { it.surfaceId == surfaceId } ?: return EventResult.Ignored
                return if (accept(todo, confirmed)) EventResult.Applied else EventResult.Ignored
            }
            "todo.updated" -> {
                if (payload["surfaceId"].str != surfaceId) return EventResult.Ignored
                val id = payload["todoId"].str ?: return EventResult.Ignored
                val version = payload["version"].str ?: return EventResult.Ignored
                var held = confirmed[id] ?: return EventResult.Read(id)
                if (!TodoOrder.newer(version, held.version)) return EventResult.Ignored
                val changes = payload["changes"].obj
                if (payload["previousVersion"].str != held.version || changes == null) return EventResult.Read(id)
                for ((field, value) in changes) {
                    held = when (field) {
                        "text" -> value.str?.let { held.copy(text = it) } ?: held
                        "status" -> TodoItem.Status.of(value.str)?.let { held.copy(status = it) } ?: held
                        "orderKey" -> held.copy(orderKey = value.str)
                        "completedAt" -> held.copy(completedAt = value.num)
                        "deletedAt" -> held.copy(deletedAt = value.num)
                        "updatedAt" -> held.copy(updatedAt = value.num ?: held.updatedAt)
                        else -> held
                    }
                }
                confirmed[id] = held.copy(version = version)
                return EventResult.Applied
            }
            else -> return EventResult.Ignored
        }
    }

    /**
     * Whether [op] still changes anything the computer holds: a change it
     * already has, or one to a todo since deleted, is dropped unsent.
     * [shown] is the list with every waiting change laid over.
     */
    fun needed(op: TodoOp, confirmed: Map<String, TodoItem>, shown: Map<String, TodoItem>): Boolean {
        val held = confirmed[op.todoId]
        val kind = op.kind
        if (kind is TodoOp.Kind.Create) return held == null
        held ?: return true
        // Deleted meanwhile, by anyone: only bringing it back still counts.
        if (held.status == TodoItem.Status.Deleted) return kind is TodoOp.Kind.Status && kind.status != TodoItem.Status.Deleted
        return when (kind) {
            is TodoOp.Kind.Create -> false
            is TodoOp.Kind.Text -> held.text != kind.text
            is TodoOp.Kind.Status -> held.status != kind.status
            is TodoOp.Kind.Move -> held.status == TodoItem.Status.Active && shown[op.todoId]?.status == TodoItem.Status.Active &&
                after(op.todoId, confirmed) != after(op.todoId, shown)
        }
    }

    /** The active todo before [id] in [todos]' order; null when it is first. */
    fun after(id: String, todos: Map<String, TodoItem>): String? {
        val active = todos.values.filter { it.status == TodoItem.Status.Active }.sortedWith(TodoOrder.active)
        val index = active.indexOfFirst { it.id == id }
        return if (index > 0) active[index - 1].id else null
    }

    /** Where a todo moved to [index] of [active] (without it) shows; null when it stays. */
    fun key(moving: String, index: Int, active: List<TodoItem>): String? {
        val from = active.indexOfFirst { it.id == moving }
        if (from < 0) return null
        val target = index.coerceIn(0, active.size - 1)
        if (target == from) return null
        val rest = active.filter { it.id != moving }
        return TodoOrder.key(if (target > 0) rest[target - 1].orderKey else null, if (target < rest.size) rest[target].orderKey else null)
    }
}
