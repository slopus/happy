package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Home's project chats are carried to another place in their list, as the
 * desktop's tab strip carries its tabs and iOS's sidebar its bots and tasks
 * (8386b4dd5c): a hold readies the row, the finger moving on lifts it, and
 * letting go asks for the move after the chat now above it; a hold let go
 * without moving opens the chat's preview instead. A chat's own list is its
 * only place, its subtasks go with it, and a screen reader moves it a place at
 * a time.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeChatDragTest {
    @get:Rule val rule = createComposeRule()

    private fun folder(id: String, depth: Int = 0) = AgentFeedRow.Folder(id, id, depth)

    private fun chat(id: String, owner: String = "p1", depth: Int = 1, parentId: String? = null) = AgentFeedRow.Conversation(
        id, id.uppercase(), if (parentId == null) ConversationKind.Project else ConversationKind.Subtask, depth, workspaceId = owner, parentId = parentId,
    )

    private fun card(vararg rows: AgentFeedRow) = rows.mapIndexed { i, row -> AgentHomeItem.Row(row, first = i == 0, last = i == rows.lastIndex) }

    private fun ids(items: List<AgentHomeItem>) = items.map { it.key.substringAfter('-') }

    @Test fun `a list's chats take the order given with their subtasks, and the card keeps its foot`() {
        val items = card(folder("p1"), chat("a"), chat("a1", depth = 2, parentId = "a"), chat("b"), chat("c"))
        val arranged = arrangedHomeItems(items, "p1", listOf("c", "a", "b"), folded = null)
        assertEquals(listOf("p1", "c", "a", "a1", "b"), ids(arranged))
        assertEquals(listOf(false, false, false, false, true), arranged.map { (it as AgentHomeItem.Row).last })
        // Carried, a chat's subtasks fold away.
        assertEquals(listOf("p1", "b", "a", "c"), ids(arrangedHomeItems(items, "p1", listOf("b", "a", "c"), folded = "a")))
        // Nothing to arrange: the list itself, so no row composes again.
        assertSame(items, arrangedHomeItems(items, "p1", listOf("a", "b", "c"), folded = null))
        assertSame(items, arrangedHomeItems(items, null, null, folded = null))
    }

    @Test fun `a worktree's chats move among themselves only`() {
        val items = card(folder("p1"), chat("a"), chat("b"), folder("w1", depth = 1), chat("w", owner = "w1", depth = 2), chat("x", owner = "w1", depth = 2))
        assertEquals(listOf("p1", "a", "b", "w1", "x", "w"), ids(arrangedHomeItems(items, "w1", listOf("x", "w"), folded = null)))
        val moves = homeRowMoves(items)
        assertEquals(HomeRowMoves(up = false, upAfter = null, down = true, downAfter = "b"), moves["a"])
        assertEquals(HomeRowMoves(up = true, upAfter = null, down = false, downAfter = null), moves["b"])
        assertEquals(HomeRowMoves(up = true, upAfter = null, down = false, downAfter = null), moves["x"])
    }

    @Test fun `a held chat is carried as the finger moves, with no preview, and goes after the chat now above it`() {
        val moves = mutableListOf<Pair<String, String?>>()
        val holds = mutableListOf<String>()
        rule.setHappyContent {
            AgentHomeList(
                // Under a bar, as home's list starts under its glass bar.
                card(folder("p1"), chat("a"), chat("b"), chat("c")), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(top = 56.dp),
                onHold = { row, _ -> holds += row.agentId },
                onReorder = { row, afterId -> moves += row.agentId to afterId },
            )
        }
        val c = rule.node(AgentHomeTags.row("agent-c"))
        c.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(700)
        // Held, with the finger still down: no preview.
        rule.runOnIdle { assertEquals(emptyList<String>(), holds) }
        c.performTouchInput {
            moveBy(Offset(0f, -height * 2.2f))
            up()
        }
        rule.waitUntil(5_000) { moves.isNotEmpty() }
        rule.runOnIdle {
            assertEquals(listOf("c" to null), moves)
            // Carried, the chat never showed its preview.
            assertEquals(emptyList<String>(), holds)
        }
    }

    @Test fun `a hold let go without moving opens the preview and carries nothing`() {
        val moves = mutableListOf<Pair<String, String?>>()
        val holds = mutableListOf<String>()
        rule.setHappyContent {
            AgentHomeList(
                card(folder("p1"), chat("a"), chat("b")), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(),
                onHold = { row, _ -> holds += row.agentId }, onReorder = { row, afterId -> moves += row.agentId to afterId },
            )
        }
        val b = rule.node(AgentHomeTags.row("agent-b"))
        b.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(700)
        rule.runOnIdle { assertEquals(emptyList<String>(), holds) }
        b.performTouchInput { up() }
        rule.waitForIdle()
        assertEquals(listOf("b"), holds)
        assertEquals(emptyList<Pair<String, String?>>(), moves)
    }

    @Test fun `a chat that cannot be carried, or a screen reader's long press, opens the preview at once`() {
        val holds = mutableListOf<String>()
        rule.setHappyContent {
            AgentHomeList(
                // a is alone in its list; b and c share theirs.
                card(folder("p1"), chat("a"), folder("p2"), chat("b", owner = "p2"), chat("c", owner = "p2")), rememberLazyListState(), onOpen = {},
                contentPadding = PaddingValues(), onHold = { row, _ -> holds += row.agentId }, onReorder = { _, _ -> },
            )
        }
        val a = rule.node(AgentHomeTags.row("agent-a"))
        a.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(700)
        // Nothing to carry it among: the preview shows while the finger is down.
        rule.runOnIdle { assertEquals(listOf("a"), holds) }
        a.performTouchInput { up() }
        rule.waitForIdle()
        // A screen reader's long press has no finger on the list.
        rule.onNodeWithText("B").performSemanticsAction(SemanticsActions.OnLongClick)
        rule.runOnIdle { assertEquals(listOf("a", "b"), holds) }
    }

    @Test fun `at the bar the list scrolls only toward a place in the chat's own list`() {
        val moves = mutableListOf<Pair<String, String?>>()
        // Other projects above, so the list could scroll on up past this one.
        val above = (1..8).flatMap { n -> card(folder("q$n"), chat("x$n", owner = "q$n")) }
        lateinit var state: LazyListState
        rule.setHappyContent {
            state = rememberLazyListState(initialFirstVisibleItemIndex = above.size)
            AgentHomeList(
                above + card(folder("p1"), chat("a"), chat("b"), chat("c")), state, onOpen = {}, contentPadding = PaddingValues(top = 56.dp),
                onHold = { _, _ -> }, onReorder = { row, afterId -> moves += row.agentId to afterId },
            )
        }
        // Scrolled to its end, the projects above off screen.
        val start = rule.runOnIdle {
            assertTrue("the list could scroll on up", state.canScrollBackward)
            state.firstVisibleItemIndex to state.firstVisibleItemScrollOffset
        }
        val c = rule.node(AgentHomeTags.row("agent-c"))
        val list = rule.node(AgentHomeTags.LIST).fetchSemanticsNode().boundsInRoot
        val row = c.fetchSemanticsNode().boundsInRoot
        c.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(700)
        // Up under the bar and held there: every place in its list is in sight, so nothing scrolls.
        c.performTouchInput { moveBy(Offset(0f, list.top + 20f - row.center.y)) }
        rule.mainClock.advanceTimeBy(1_000)
        rule.runOnIdle { assertEquals(start, state.firstVisibleItemIndex to state.firstVisibleItemScrollOffset) }
        c.performTouchInput { up() }
        rule.waitUntil(5_000) { moves.isNotEmpty() }
        assertEquals(listOf("c" to null), moves)
    }

    @Test fun `a chat that leaves the list while another is carried is no place to go after`() {
        val moves = mutableListOf<Pair<String, String?>>()
        var items by mutableStateOf(card(folder("p1"), chat("a"), chat("b"), chat("c"), chat("d")))
        rule.setHappyContent {
            AgentHomeList(
                items, rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(),
                onHold = { _, _ -> }, onReorder = { row, afterId -> moves += row.agentId to afterId },
            )
        }
        val d = rule.node(AgentHomeTags.row("agent-d"))
        d.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(700)
        // Carried up past c, after b ...
        d.performTouchInput { moveBy(Offset(0f, -height * 1.2f)) }
        // ... as b is archived on another device: it goes after a, the chat now before it.
        rule.runOnIdle { items = card(folder("p1"), chat("a"), chat("c"), chat("d")) }
        rule.waitForIdle()
        d.performTouchInput { up() }
        rule.waitUntil(5_000) { moves.isNotEmpty() }
        assertEquals(listOf("d" to "a"), moves)
    }

    @Test fun `a screen reader moves a chat a place at a time`() {
        val moves = mutableListOf<Pair<String, String?>>()
        rule.setHappyContent {
            AgentHomeList(
                card(folder("p1"), chat("a"), chat("b"), chat("c")), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(),
                onReorder = { row, afterId -> moves += row.agentId to afterId },
            )
        }
        val actions = rule.onNodeWithText("B").fetchSemanticsNode().config[SemanticsActions.CustomActions]
        actions.first { it.label == "Move up" }.action()
        actions.first { it.label == "Move down" }.action()
        rule.runOnIdle { assertEquals(listOf("b" to null, "b" to "c"), moves) }
    }
}
