package com.slopus.happy.ui.todos

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TodoListsContentTest {
    @get:Rule val rule = createComposeRule()
    private val entries = listOf(TodoListEntry("g", "Groceries", 3), TodoListEntry("l", "Launch", 0), TodoListEntry("u", "Unopened", null))

    @Test fun keptCountsDistinguishEmptyFromUnopenedAndRowsOpenTheirSurface() {
        var opened: String? = null
        rule.setHappyContent { TodoListsContent(entries, true, false, { opened = it }, {}) }
        rule.onNodeWithText("3 to do").assertExists()
        rule.onNodeWithText("Nothing to do").assertExists()
        rule.onNodeWithText("Unopened").performClick()
        assertEquals("u", opened)
        val first = rule.node("todo.lists.g").bounds
        val second = rule.node("todo.lists.l").bounds
        assertDp("first card top", 8, first.top)
        assertDp("tiled row", 60, first.bottom - first.top)
        assertDp("rows touch", first.bottom, second.top)
    }

    @Test @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun listIndexUsesTheTabletReadableColumn() {
        rule.setHappyContent { ProvideWindowLayout { TodoListsContent(entries, true, false, {}, {}) } }
        val row = rule.node("todo.lists.g").bounds
        assertDp("column starts", 240, row.left)
        assertDp("column width", 800, row.width)
    }
}