package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.LocalHomeRowObserver
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Home's rows compose again only when what they draw changes (iOS
 * 2932427fe): a working agent's activity time, its parent or its folder
 * change nothing on its line, so they compose nothing; a tap still opens
 * the row as it is now.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentHomeRecompositionTest {
    @get:Rule val rule = createComposeRule()

    private val compositions = HashMap<String, Int>()
    // One instance: a new lambda would be a new local value and recompose every row by itself.
    private val observer: (String) -> Unit = { id -> compositions[id] = (compositions[id] ?: 0) + 1 }
    private val opened = mutableListOf<String>()
    private val onOpen: (String) -> Unit = { opened += it }

    private fun row(id: String, title: String, activityAt: Long = 1, unread: Boolean = false, workspaceId: String? = null, parentId: String? = null) =
        AgentFeedRow.Conversation(id, title, ConversationKind.Task, 0, seed = id, working = true, activityAt = activityAt, unread = unread, workspaceId = workspaceId, parentId = parentId)

    private fun items(rows: List<AgentFeedRow.Conversation>) = rows.mapIndexed { i, row -> AgentHomeItem.Row(row, first = i == 0, last = i == rows.lastIndex) }

    @Test fun `only what a row draws composes it again`() {
        var rows by mutableStateOf(listOf(row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma")))
        rule.setHappyContent {
            CompositionLocalProvider(LocalHomeRowObserver provides observer) {
                AgentHomeList(items(rows), rememberLazyListState(), onOpen, PaddingValues())
            }
        }
        rule.waitForIdle()
        assertEquals(mapOf("a" to 1, "b" to 1, "c" to 1), compositions)

        // A working agent's activity ticks, and it moves under a parent and into a folder: nothing on its line.
        repeat(5) { tick ->
            rows = listOf(row("a", "Alpha", activityAt = 100L + tick, workspaceId = "w", parentId = "p"), rows[1], rows[2])
            rule.waitForIdle()
        }
        assertEquals(mapOf("a" to 1, "b" to 1, "c" to 1), compositions)

        // Unread shows its dot: that row alone.
        rows = listOf(rows[0], row("b", "Beta", unread = true), rows[2])
        rule.waitForIdle()
        assertEquals(mapOf("a" to 1, "b" to 2, "c" to 1), compositions)

        // A renamed row says its new name, and a tap opens it.
        rows = listOf(row("a", "Alpha renamed", activityAt = 200), rows[1], rows[2])
        rule.waitForIdle()
        assertEquals(2, compositions["a"])
        rule.onNodeWithText("Alpha renamed").performClick()
        assertEquals(listOf("a"), opened)
    }
}
