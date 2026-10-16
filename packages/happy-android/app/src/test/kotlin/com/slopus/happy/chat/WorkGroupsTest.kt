package com.slopus.happy.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * useGroupedMessages.test.ts, agentTurns.test.ts and ChatList.tsx's
 * expansion rules, newest first: a finished turn's work folds under one
 * group above its answer, the running turn stays flat until it settles,
 * turn ids split answers whose prompt never arrived, questions and
 * attachments are never folded, the setting off passes rows through; an
 * open group lists "Hide", its rows, then its header; watched turns stay
 * open, pending permissions open themselves, closing by hand wins, a new
 * session or the background starts afresh.
 */
class WorkGroupsTest {
    private fun user(id: String, at: Long, pending: Boolean = false) =
        ChatRow.User(ChatMessage.UserText(id, null, at, "q", pending = pending), UserDisplay.Text("q", emptyList()))

    private fun text(id: String, at: Long, turn: String? = null, body: String = "a") =
        ChatRow.AgentText(ChatMessage.AgentText(id, at, body, turn = turn), emptyList())

    private fun tool(id: String, at: Long, name: String = "Bash", turn: String? = null, permission: PermissionStatus? = null) = ChatRow.Tool(
        ChatMessage.ToolCallMessage(
            id,
            at,
            ToolCall(name = name, state = ToolState.Completed, input = null, createdAt = at, permission = permission?.let { ToolPermission("p", it) }),
            turn = turn,
        ),
    )

    private fun keys(items: List<ChatDisplayItem>) = items.map { it.key }

    // Newest first: answer a2 after tools t2/t3 for prompt u2; then the previous turn u1 → t1 → a1.
    private val history = listOf(
        text("a2", 60), tool("t3", 50), tool("t2", 40), user("u2", 30),
        text("a1", 20), tool("t1", 10), user("u1", 0),
    )

    @Test fun aFinishedTurnFoldsItsWorkUnderItsAnswer() {
        val items = groupChatRowsForDisplay(history, enabled = true, collapseCurrentTurn = true)
        assertEquals(listOf("a2", "work-a2", "u2", "a1", "work-a1", "u1"), keys(items))
        val group = (items[1] as ChatDisplayItem.WorkGroup).group
        assertEquals("reading order inside", listOf("t2", "t3"), group.rows.map { it.key })
        assertEquals("u2", group.turnUserMessageId)
        assertEquals(40L, group.startedAt)
        assertEquals(60L, group.completedAt)
    }

    @Test fun theRunningTurnStaysFlatAndTheSettingOffPassesEverything() {
        assertEquals(
            listOf("a2", "t3", "t2", "u2", "a1", "work-a1", "u1"),
            keys(groupChatRowsForDisplay(history, enabled = true, collapseCurrentTurn = false)),
        )
        val withBlank = listOf(text("blank", 70, body = " ")) + history
        assertEquals(history.map { it.key }, keys(groupChatRowsForDisplay(withBlank, enabled = false, collapseCurrentTurn = true)))
    }

    @Test fun aTurnWithoutAnAnswerOrWorkFoldsNothing() {
        val noAnswer = listOf(tool("t1", 10), user("u1", 0))
        assertEquals(listOf("t1", "u1"), keys(groupChatRowsForDisplay(noAnswer, true, true)))
        val answerOnly = listOf(text("a1", 10), user("u1", 0))
        assertEquals(listOf("a1", "u1"), keys(groupChatRowsForDisplay(answerOnly, true, true)))
    }

    @Test fun questionsAttachmentsAndHiddenToolsAreNeverFolded() {
        val rows = listOf(
            text("a1", 50), tool("ask", 40, name = "AskUserQuestion"), tool("pic", 30, name = "file"),
            tool("hidden", 25, name = "ToolSearch"), tool("t1", 20), user("u1", 0),
        )
        assertEquals(listOf("a1", "ask", "pic", "work-a1", "u1"), keys(groupChatRowsForDisplay(rows, true, true)))
    }

    @Test fun turnIdsSplitAnswersWhosePromptNeverArrived() {
        val rows = listOf(text("a2", 40, turn = "B"), tool("t2", 30, turn = "B"), text("a1", 20, turn = "A"), tool("t1", 10, turn = "A"))
        assertEquals(listOf(0, 0, 1, 1), assignTurns(rows.map { it.message }).toList())
        assertEquals(listOf("a2", "work-a2", "a1", "work-a1"), keys(groupChatRowsForDisplay(rows, true, true)))
        // A pending prompt never ends a turn.
        assertEquals(listOf(0, 0, 0), assignTurns(listOf(text("a", 2), user("u", 1, pending = true), tool("t", 0)).map { it.message }).toList())
    }

    @Test fun anOpenGroupDrawsHideItsRowsThenItsHeader() {
        val items = groupChatRowsForDisplay(history, true, true)
        val open = chatListItems(items) { it.id == "work-a2" }
        assertEquals(
            listOf("a2", "work-a2:collapse", "t3", "t2", "work-a2", "u2", "a1", "work-a1", "u1"),
            open.map { it.key },
        )
        assertEquals(WorkHeaderPlacement.Trailing, (open[1] as ChatListItem.WorkHeader).placement)
    }

    @Test fun watchedTurnsStayOpenAndClosingByHandWins() {
        val running = listOf(tool("t2", 40), user("u2", 30))
        var expansion = WorkGroupExpansion().observed("s1", foreground = true, rows = running, currentTurnComplete = false)
        assertEquals(setOf("u2"), expansion.watched)
        expansion = expansion.observed("s1", true, history, currentTurnComplete = true)
        val items = groupChatRowsForDisplay(history, true, true)
        val current = (items[1] as ChatDisplayItem.WorkGroup).group
        val older = (items[4] as ChatDisplayItem.WorkGroup).group
        assertTrue("seen live, so it stays open", expansion.isExpanded(current))
        assertFalse("history stays folded", expansion.isExpanded(older))
        expansion = expansion.toggled(current)
        assertFalse(expansion.isExpanded(current))
        expansion = expansion.toggled(older)
        assertTrue(expansion.isExpanded(older))
        assertSame("nothing moved, nothing new", expansion, expansion.observed("s1", true, history, true))
    }

    @Test fun aPendingPermissionOpensItsGroupUntilClosed() {
        val rows = listOf(text("a", 20), tool("t", 10, permission = PermissionStatus.Pending), user("u", 0))
        val group = (groupChatRowsForDisplay(rows, true, true)[1] as ChatDisplayItem.WorkGroup).group
        assertTrue(group.hasPendingPermission)
        val expansion = WorkGroupExpansion()
        assertTrue(expansion.isExpanded(group))
        assertFalse(expansion.toggled(group).isExpanded(group))
    }

    @Test fun anotherSessionOrTheBackgroundStartsAfresh() {
        val items = groupChatRowsForDisplay(history, true, true)
        val older = (items[4] as ChatDisplayItem.WorkGroup).group
        val opened = WorkGroupExpansion().observed("s1", true, history, true).toggled(older)
        assertFalse("a new session forgets the toggles", opened.observed("s2", true, history, true).isExpanded(older))
        val backgrounded = opened.observed("s1", true, listOf(tool("x", 70)) + history, currentTurnComplete = false).backgrounded(items)
        assertFalse(backgrounded.isExpanded(older))
        assertTrue(backgrounded.watched.isEmpty())
        assertTrue("nothing is watched in the background", opened.observed("s1", false, history, false).watched.isEmpty())
    }

    @Test fun durationsReadLikeHappyApp() {
        assertEquals("45s", formatWorkDuration(45_900))
        assertEquals("2m5s", formatWorkDuration(125_000))
        assertEquals("1h3m", formatWorkDuration(3_780_000))
        assertEquals("0s", formatWorkDuration(-5))
    }
}
