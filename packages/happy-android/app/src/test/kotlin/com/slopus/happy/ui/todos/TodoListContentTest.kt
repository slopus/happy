package com.slopus.happy.ui.todos

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.waitUntilAtLeastOneExists
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoLibrary
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(ExperimentalTestApi::class)
class TodoListContentTest {
    @get:Rule val rule = createComposeRule()
    private val milk = TodoItem("milk", "groceries", "Milk", orderKey = "5")
    private val bread = TodoItem("bread", "groceries", "Bread", orderKey = "7")

    @Test fun editingSavesOnceAndAddKeepsItsFieldForTheNextTask() {
        val edits = mutableListOf<Pair<String, String>>()
        val additions = mutableListOf<String>()
        rule.setHappyContent {
            TodoListContent(TodoListState(status = TodoListState.Status.Ready, active = listOf(milk)),
                actions(add = { additions += it }, edit = { id, text -> edits += id to text }))
        }
        rule.waitUntilAtLeastOneExists(hasTestTag("todo.row.milk"), 5_000)
        rule.onNodeWithContentDescription("Milk").performClick()
        rule.node("todo.editor").performTextReplacement("Oat milk")
        rule.node("todo.editor").performImeAction()
        rule.runOnIdle { assertEquals(listOf("milk" to "Oat milk"), edits) }
        rule.node("todo.hit.add").performClick()
        rule.node("todo.editor").performTextReplacement("Bread")
        rule.node("todo.editor").performImeAction()
        rule.node("todo.editor").performTextReplacement("Eggs")
        rule.node("todo.editor").performImeAction()
        rule.runOnIdle { assertEquals(listOf("Bread", "Eggs"), additions) }
    }

    @Test fun deletingAnItemAndUndoingRestoresItsStatusAndOriginalNeighbor() {
        val state = mutableStateOf(TodoListState(status = TodoListState.Status.Ready, active = listOf(milk, bread)))
        val restores = mutableListOf<Triple<String, TodoLibrary.Place, TodoItem.Status>>()
        rule.setHappyContent {
            TodoListContent(state.value, actions(
                delete = { id -> state.value = state.value.copy(active = state.value.active.filterNot { it.id == id }) },
                restore = { id, place, status -> restores += Triple(id, place, status) },
            ))
        }
        rule.waitUntilAtLeastOneExists(hasTestTag("todo.row.bread"), 5_000)
        val delete = rule.node("todo.row.bread").fetchSemanticsNode().config[SemanticsActions.CustomActions].first { it.label == "Delete" }
        // Keep the five-second undo window open while the test inspects it.
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { delete.action() }
        rule.waitUntil(5_000) { state.value.active.none { it.id == "bread" } }
        rule.mainClock.advanceTimeBy(400)
        rule.waitUntilAtLeastOneExists(hasTestTag("todo.undo.button"), 5_000)
        rule.node("todo.undo.button").performClick()
        rule.runOnIdle { assertEquals(listOf(Triple("bread", TodoLibrary.Place.After("milk"), TodoItem.Status.Active)), restores) }
        rule.mainClock.autoAdvance = true
    }

    @Test fun deletedRowsRestoreToTheEndWithoutReopeningAnEditor() {
        val restores = mutableListOf<Triple<String, TodoLibrary.Place, TodoItem.Status>>()
        rule.setHappyContent {
            TodoListContent(TodoListState(deleted = listOf(milk.copy(status = TodoItem.Status.Deleted)), deletedRead = true),
                actions(restore = { id, place, status -> restores += Triple(id, place, status) }), deleted = true)
        }
        rule.waitUntilAtLeastOneExists(hasTestTag("todo.row.milk"), 5_000)
        rule.onNodeWithContentDescription("Milk").performClick()
        rule.runOnIdle { assertEquals(listOf(Triple("milk", TodoLibrary.Place.End, TodoItem.Status.Active)), restores) }
        rule.node("todo.editor").assertDoesNotExist()
    }

    @Test fun aHeldRowMovesPastItsNeighborAndSendsOnlyTheDropSlot() {
        val moves = mutableListOf<Pair<String, Int>>()
        rule.setHappyContent {
            TodoListContent(TodoListState(status = TodoListState.Status.Ready, active = listOf(milk, bread)),
                actions(move = { id, index -> moves += id to index }))
        }
        rule.waitUntilAtLeastOneExists(hasTestTag("todo.row.milk"), 5_000)
        rule.node("todo.row.milk").performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(360)
        rule.runOnIdle { assertEquals(emptyList<Pair<String, Int>>(), moves) }
        val lifted = rule.node("todo.row.milk").fetchSemanticsNode().boundsInRoot
        assertTrue("row lifts after 350 ms: $lifted", lifted.height > 44 * rule.density.density)
        rule.node("todo.row.milk").performTouchInput {
            moveBy(Offset(0f, height * 1.1f))
            up()
        }
        rule.waitUntil(5_000) { moves.isNotEmpty() }
        rule.runOnIdle { assertEquals(listOf("milk" to 1), moves) }
    }

    @Test fun talkBackGetsOneTodoWithItsAuthorPendingStateAndActions() {
        rule.setHappyContent {
            TodoListContent(TodoListState(status = TodoListState.Status.Ready,
                active = listOf(milk.copy(authorUserId = "ada"), bread), names = mapOf("ada" to "Ada Lovelace"), waiting = setOf("milk")), actions())
        }
        rule.waitUntilAtLeastOneExists(hasTestTag("todo.row.milk"), 5_000)
        val todo = rule.onNodeWithContentDescription("Milk")
        todo.assert(hasStateDescription("Not done, Added by Ada Lovelace, Not sent yet"))
        val labels = todo.fetchSemanticsNode().config[SemanticsActions.CustomActions].map { it.label }
        assertTrue(labels.containsAll(listOf("Mark “Milk” done", "Edit", "Delete", "History", "Move down")))
        rule.onAllNodesWithText("AL").assertCountEquals(0)
        todo.performSemanticsAction(SemanticsActions.OnClick) { it() }
        rule.node("todo.editor").assertExists()
    }

    private fun actions(
        add: suspend (String) -> Unit = {},
        edit: suspend (String, String) -> Unit = { _, _ -> },
        delete: suspend (String) -> Unit = {},
        restore: suspend (String, TodoLibrary.Place, TodoItem.Status) -> Unit = { _, _, _ -> },
        move: suspend (String, Int) -> Unit = { _, _ -> },
    ) = TodoActions(add, edit, done = { _, _ -> }, delete, restore, move, history = {}, refresh = {}, dismissFailure = {})
}