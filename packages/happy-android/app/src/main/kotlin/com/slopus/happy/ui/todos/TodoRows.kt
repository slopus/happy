package com.slopus.happy.ui.todos

import androidx.compose.runtime.Immutable
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.todos.TodoOrder
import com.slopus.happy.ui.components.HomeCardPlace

/** The keyed rows of iOS's TodoListItems, derived before committing them to composition. */
@Immutable
sealed interface TodoRow {
    val key: String

    data object Add : TodoRow { override val key = "add" }
    data class Heading(val todo: TodoItem) : TodoRow { override val key = todo.id }
    data class Item(val todo: TodoItem, val done: Boolean, val place: HomeCardPlace) : TodoRow { override val key = todo.id }
    data class Completed(val count: Int, val shown: Boolean) : TodoRow { override val key = "completed" }
    data class Notice(val reason: String) : TodoRow { override val key = "notice" }
    data class Note(val kind: Kind) : TodoRow {
        override val key = "note"
        enum class Kind { Loading, Empty, Missing, DeletedLoading, DeletedEmpty }
    }
    data class Gap(override val key: String) : TodoRow
}

/**
 * Each heading starts a card. Newly checked rows keep their original key
 * and order for the 650 ms check-off hold, then join the completed card.
 * A drag supplies only its changed order; geometry belongs to the UI.
 */
fun todoRows(
    state: TodoListState,
    deleted: Boolean = false,
    completedShown: Boolean = false,
    settling: Map<String, TodoItem> = emptyMap(),
    dragOrder: List<String>? = null,
): List<TodoRow> = buildList {
    state.failure?.let { add(TodoRow.Notice(it)); add(TodoRow.Gap("notice-gap")) }
    if (deleted) {
        if (state.deleted.isEmpty()) add(TodoRow.Note(if (state.deletedRead && !state.kept) TodoRow.Note.Kind.DeletedEmpty else TodoRow.Note.Kind.DeletedLoading))
        state.deleted.forEachIndexed { index, todo ->
            add(TodoRow.Item(todo, todo.completedAt != null, HomeCardPlace(index == 0, index == state.deleted.lastIndex)))
        }
        return@buildList
    }
    if (state.status == TodoListState.Status.Missing) {
        add(TodoRow.Note(TodoRow.Note.Kind.Missing))
        return@buildList
    }
    add(TodoRow.Add)
    add(TodoRow.Gap("add-gap"))
    val activeIds = state.active.mapTo(HashSet()) { it.id }
    val completedIds = state.completed.mapTo(HashSet()) { it.id }
    val held = settling.values.filter { it.id !in activeIds && it.id in completedIds }
    val active = if (held.isEmpty()) state.active else (state.active + held).sortedWith(TodoOrder.active)
    val order = dragOrder?.withIndex()?.associate { it.value to it.index }
    val shown = if (order == null) active else active.sortedBy { order[it.id] ?: Int.MAX_VALUE }
    val completed = state.completed.filter { it.id !in settling }
    if (shown.isEmpty() && completed.isEmpty()) {
        add(TodoRow.Note(if (state.status == TodoListState.Status.Loading) TodoRow.Note.Kind.Loading else TodoRow.Note.Kind.Empty))
    }
    var run = ArrayList<TodoItem>()
    fun flush() {
        run.forEachIndexed { index, todo ->
            add(TodoRow.Item(todo, todo.id in settling, HomeCardPlace(index == 0, index == run.lastIndex)))
        }
        run = ArrayList()
    }
    for (todo in shown) {
        if (todo.heading != null) {
            flush()
            add(TodoRow.Heading(todo))
        } else run += todo
    }
    flush()
    if (completed.isNotEmpty()) {
        add(TodoRow.Completed(completed.size, completedShown))
        if (completedShown) completed.forEachIndexed { index, todo ->
            add(TodoRow.Item(todo, true, HomeCardPlace(index == 0, index == completed.lastIndex)))
        }
    }
}