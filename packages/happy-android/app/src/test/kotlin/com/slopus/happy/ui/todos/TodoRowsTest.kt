package com.slopus.happy.ui.todos

import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.ui.components.HomeCardPlace
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TodoRowsTest {
    private fun todo(id: String, text: String, key: String = id) = TodoItem(id, "list", text, orderKey = key)

    @Test
    fun headingsSplitCardsAndCompletedStayBehindTheirToggle() {
        val state = TodoListState(
            status = TodoListState.Status.Ready,
            active = listOf(todo("a", "One"), todo("h", "# Produce"), todo("b", "Apples"), todo("c", "Pears")),
            completed = listOf(todo("d", "Milk").copy(status = TodoItem.Status.Completed)),
        )
        val rows = todoRows(state)
        assertEquals(listOf("add", "add-gap", "a", "h", "b", "c", "completed"), rows.map { it.key })
        assertEquals(listOf(HomeCardPlace(true, true), HomeCardPlace(true, false), HomeCardPlace(false, true)), rows.filterIsInstance<TodoRow.Item>().map { it.place })
        assertFalse(rows.filterIsInstance<TodoRow.Item>().any { it.done })
        val expanded = todoRows(state, completedShown = true)
        assertEquals("d", expanded.last().key)
        assertTrue((expanded.last() as TodoRow.Item).done)
    }

    @Test
    fun aCheckedRowHoldsItsKeyAndPlaceBeforeItFolds() {
        val before = todo("b", "Milk", "2")
        val state = TodoListState(
            active = listOf(todo("a", "Bread", "1"), todo("c", "Eggs", "3")),
            completed = listOf(before.copy(status = TodoItem.Status.Completed, orderKey = null)),
        )
        val held = todoRows(state, settling = mapOf("b" to before))
        assertEquals(listOf("a", "b", "c"), held.filterIsInstance<TodoRow.Item>().map { it.todo.id })
        assertEquals(listOf(false, true, false), held.filterIsInstance<TodoRow.Item>().map { it.done })
        assertFalse(held.any { it is TodoRow.Completed })
        assertEquals(listOf("a", "c", "completed"), todoRows(state).filterNot { it is TodoRow.Add || it is TodoRow.Gap }.map { it.key })
    }

    @Test
    fun aDragOrdersHeadingsAndTodosTogether() {
        val state = TodoListState(active = listOf(todo("h", "# Produce"), todo("a", "Apples"), todo("b", "Bread")))
        assertEquals(listOf("add", "add-gap", "b", "h", "a"), todoRows(state, dragOrder = listOf("b", "h", "a")).map { it.key })
    }

    @Test
    fun missingAndDeletedHaveTheirOwnEmptyStates() {
        assertEquals(listOf(TodoRow.Note(TodoRow.Note.Kind.Missing)), todoRows(TodoListState(status = TodoListState.Status.Missing)))
        assertEquals(listOf(TodoRow.Note(TodoRow.Note.Kind.DeletedLoading)), todoRows(TodoListState(), deleted = true))
        assertEquals(listOf(TodoRow.Note(TodoRow.Note.Kind.DeletedEmpty)), todoRows(TodoListState(deletedRead = true, kept = false), deleted = true))
    }
}