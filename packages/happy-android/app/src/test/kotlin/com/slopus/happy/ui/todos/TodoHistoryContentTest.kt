package com.slopus.happy.ui.todos

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoRevision
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TodoHistoryContentTest {
    @get:Rule val rule = createComposeRule()

    @Test fun historySaysWhoChangedWhatIncludingAnAgentActingForAPerson() {
        val todo = TodoItem("milk", "groceries", "Oat milk", version = "2")
        val rows = listOf(
            TodoHistoryRow(TodoRevision(todo, userId = "ada", agentId = "agent"), TodoRevision.Change.EditedAnd(TodoRevision.Change.Completed), "4 Nov, 12:30"),
            TodoHistoryRow(TodoRevision(todo.copy(version = "1"), source = "tool"), TodoRevision.Change.Created, "4 Nov, 12:20"),
            TodoHistoryRow(TodoRevision(todo.copy(version = "0")), TodoRevision.Change.Reopened, "4 Nov, 12:10"),
        )
        rule.setHappyContent { TodoHistoryContent(rows, mapOf("ada" to "Ada")) }
        rule.onNodeWithText("Ada · An agent").assertExists()
        rule.onNodeWithText("Changed and marked done · 4 Nov, 12:30").assertExists()
        rule.onNodeWithText("An agent").assertExists()
        rule.onNodeWithText("Added · 4 Nov, 12:20").assertExists()
        rule.onNodeWithText("Someone").assertExists()
        rule.onNodeWithText("Marked not done · 4 Nov, 12:10").assertExists()
    }
}