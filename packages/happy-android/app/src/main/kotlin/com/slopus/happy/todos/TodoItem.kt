package com.slopus.happy.todos

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * One todo of a todo Surface as the computer keeps it (happy-agent API.md,
 * "Todo data and permanent versions"; iOS's `TodoItem`). Only an active todo
 * has an order key; a deleted one keeps the time it was completed, if it was.
 * Times are epoch milliseconds; [version] is the todo's UUIDv7, empty for one
 * made here and not yet taken.
 */
@Immutable
data class TodoItem(
    val id: String,
    val surfaceId: String,
    val text: String,
    val status: Status = Status.Active,
    val orderKey: String? = null,
    val authorUserId: String? = null,
    val createdAt: Double = 0.0,
    val updatedAt: Double = 0.0,
    val completedAt: Double? = null,
    val deletedAt: Double? = null,
    val version: String = "",
) {
    enum class Status(val wire: String) {
        Active("active"), Completed("completed"), Deleted("deleted");

        companion object {
            fun of(wire: String?): Status? = entries.firstOrNull { it.wire == wire }
        }
    }

    /** The label of a section heading (`# Groceries`), null for a todo. */
    val heading: String? get() = TodoText.heading(text)

    fun json(): JsonObject = buildJsonObject {
        put("id", JsonPrimitive(id))
        put("surfaceId", JsonPrimitive(surfaceId))
        put("authorUserId", authorUserId?.let(::JsonPrimitive) ?: JsonNull)
        put("text", JsonPrimitive(text))
        put("status", JsonPrimitive(status.wire))
        put("orderKey", orderKey?.let(::JsonPrimitive) ?: JsonNull)
        put("createdAt", JsonPrimitive(createdAt))
        put("updatedAt", JsonPrimitive(updatedAt))
        put("completedAt", completedAt?.let(::JsonPrimitive) ?: JsonNull)
        put("deletedAt", deletedAt?.let(::JsonPrimitive) ?: JsonNull)
        put("version", JsonPrimitive(version))
    }

    companion object {
        /** A todo as the computer sends it; null for one it can't be read as. */
        fun parse(element: JsonElement?): TodoItem? {
            val o = element.obj ?: return null
            return TodoItem(
                id = o["id"].str ?: return null,
                surfaceId = o["surfaceId"].str ?: return null,
                text = o["text"].str ?: return null,
                status = Status.of(o["status"].str) ?: return null,
                orderKey = o["orderKey"].str,
                authorUserId = o["authorUserId"].str,
                createdAt = o["createdAt"].num ?: 0.0,
                updatedAt = o["updatedAt"].num ?: 0.0,
                completedAt = o["completedAt"].num,
                deletedAt = o["deletedAt"].num,
                version = o["version"].str.orEmpty(),
            )
        }
    }
}

/** The text rules desktop's todo list keeps (`happy-agent` todo store), as iOS's `TodoText`. */
object TodoText {
    /** The most a todo holds. */
    const val LIMIT = 10_000

    /** A heading's label: what follows an exact `# ` prefix. */
    fun heading(text: String): String? = if (text.startsWith("# ")) text.substring(2) else null

    /**
     * What a person typed as a todo's text, or null for nothing: control
     * characters become spaces and the ends are trimmed. A heading stays one;
     * a todo that trimming would turn into a heading keeps a space in front,
     * so it stays a todo.
     */
    fun normalized(typed: String): String? {
        val heading = heading(typed)
        val cleaned = buildString {
            for (char in heading ?: typed) {
                val code = char.code
                append(if (code <= 0x08 || code in 0x0B..0x1F || code == 0x7F) ' ' else char)
            }
        }.trim()
        if (cleaned.isEmpty()) return null
        val text = when {
            heading != null -> "# $cleaned"
            heading(cleaned) != null -> " $cleaned"
            else -> cleaned
        }
        return text.take(LIMIT)
    }
}

/** Keys and versions as the computer compares them: plain byte order, never locale-aware (iOS's `TodoOrder`). */
object TodoOrder {
    fun precedes(a: String, b: String): Boolean = compareBytes(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8)) < 0

    /** Whether version [a] is newer than [b] (UUIDv7s sort by time). */
    fun newer(a: String, than: String): Boolean = precedes(than, a)

    /** Active todos in their list's order: by key, then ID. */
    val active: Comparator<TodoItem> = Comparator { a, b ->
        val left = a.orderKey.orEmpty()
        val right = b.orderKey.orEmpty()
        if (left != right) order(left, right) else order(a.id, b.id)
    }

    /** Completed todos, newest first, then ID. */
    val completed: Comparator<TodoItem> = Comparator { a, b ->
        val left = a.completedAt ?: 0.0
        val right = b.completedAt ?: 0.0
        if (left != right) right.compareTo(left) else order(a.id, b.id)
    }

    /** Deleted todos, newest first, then ID. */
    val deleted: Comparator<TodoItem> = Comparator { a, b ->
        val left = a.deletedAt ?: 0.0
        val right = b.deletedAt ?: 0.0
        if (left != right) right.compareTo(left) else order(a.id, b.id)
    }

    private fun order(a: String, b: String): Int = compareBytes(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    private fun compareBytes(a: ByteArray, b: ByteArray): Int {
        for (i in 0 until minOf(a.size, b.size)) {
            val d = (a[i].toInt() and 0xFF) - (b[i].toInt() and 0xFF)
            if (d != 0) return d
        }
        return a.size - b.size
    }

    /**
     * A key between [a] and [b] (null: the list's start or end), for where a
     * todo shows until the computer gives it its own. Keys are decimal
     * fractions compared by bytes; the one made is the shortest midpoint.
     */
    fun key(between: String?, and: String?): String {
        val low = (between ?: "").toByteArray(Charsets.US_ASCII).map { it.toInt() and 0xFF }
        val high = and?.toByteArray(Charsets.US_ASCII)?.map { it.toInt() and 0xFF }
        val floor = '0'.code - 1
        val ceiling = '9'.code + 1
        val result = ArrayList<Int>()
        var bounded = high != null
        var index = 0
        fun text(bytes: List<Int>) = String(ByteArray(bytes.size) { bytes[it].toByte() }, Charsets.US_ASCII)
        while (index < 64) {
            val lower = if (index < low.size) low[index] else floor
            val upper = if (bounded && index < (high?.size ?: 0)) high!![index] else ceiling
            if (lower == upper) {
                result += lower
                index++
                continue
            }
            if (upper > lower + 1) {
                result += lower + (upper - lower) / 2
                return text(result)
            }
            // Next to each other here. With `a` used up, anything under `b`'s byte will do.
            if (lower == floor) return text(result + floor)
            // Else keep `a`'s byte, and find room after it above what `a` has left.
            result += lower
            bounded = false
            index++
        }
        return text(result)
    }
}

/**
 * A permanent revision of a todo: its whole state after one change, and who
 * made it (`GET …/:todoId/versions`; iOS's `TodoRevision`). [source] is
 * `api` or `tool`.
 */
data class TodoRevision(val todo: TodoItem, val userId: String? = null, val agentId: String? = null, val source: String = "api") {
    /** What a revision did to the todo before it. */
    sealed interface Change {
        data object Created : Change
        data class Edited(val from: String) : Change
        data object Completed : Change
        data object Reopened : Change
        data object Deleted : Change
        data object Restored : Change
        data object Moved : Change
        /** The text changed and the state too, in one go. */
        data class EditedAnd(val change: Change) : Change
    }

    companion object {
        fun parse(element: JsonElement?): TodoRevision? {
            val o = element.obj ?: return null
            val todo = TodoItem.parse(o["todo"]) ?: return null
            val actor = o["actor"].obj
            return TodoRevision(todo, actor?.get("userId").str, actor?.get("agentId").str, o["source"].str ?: "api")
        }

        /** What each of [revisions] (oldest first) changed. */
        fun changes(revisions: List<TodoRevision>): List<Change> {
            var previous: TodoItem? = null
            return revisions.map { revision ->
                val before = previous
                previous = revision.todo
                if (before == null) return@map Change.Created
                val now = revision.todo
                val state: Change? = when {
                    before.status == TodoItem.Status.Active && now.status == TodoItem.Status.Completed -> Change.Completed
                    before.status == TodoItem.Status.Completed && now.status == TodoItem.Status.Active -> Change.Reopened
                    now.status == TodoItem.Status.Deleted && before.status != TodoItem.Status.Deleted -> Change.Deleted
                    before.status == TodoItem.Status.Deleted && now.status != TodoItem.Status.Deleted -> Change.Restored
                    else -> null
                }
                if (before.text != now.text) state?.let { Change.EditedAnd(it) } ?: Change.Edited(before.text) else state ?: Change.Moved
            }
        }
    }
}
