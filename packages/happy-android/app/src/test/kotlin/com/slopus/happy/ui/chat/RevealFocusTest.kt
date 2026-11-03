package com.slopus.happy.ui.chat

import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.markdown.parseMarkdown
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which relay reply reveals (iOS 70c8f6de7's RevealFocusTests, for the rows the relay chat has). */
class RevealFocusTest {
    private fun agent(id: String) = ChatRow.AgentText(ChatMessage.AgentText(id, 0, id), parseMarkdown(id))
    private fun user(id: String) = (com.slopus.happy.chat.ChatReduction.buildRow(ChatMessage.UserText(id, null, 0, id), false) as ChatRow.User)

    @Test fun theHistoryTheChatOpensWithNeverReveals() {
        val focus = RevealFocus()
        assertNull(focus.update(listOf(agent("a2"), user("u1")), working = true))
    }

    @Test fun theNewestReplyRevealsWhileTheAgentWorks() {
        val focus = RevealFocus()
        focus.update(listOf(user("u1")), working = true)
        assertEquals("a1", focus.update(listOf(agent("a1"), user("u1")), working = true))
        assertEquals("growing keeps it", "a1", focus.update(listOf(agent("a1"), user("u1")), working = true))
        assertNull("the turn ended", focus.update(listOf(agent("a1"), user("u1")), working = false))
    }

    @Test fun aNewerRowFinishesTheOneBefore() {
        val focus = RevealFocus()
        focus.update(listOf(user("u1")), working = true)
        focus.update(listOf(agent("a1"), user("u1")), working = true)
        assertEquals("a2", focus.update(listOf(agent("a2"), agent("a1"), user("u1")), working = true))
    }

    @Test fun aBurstShowsWhole() {
        val focus = RevealFocus()
        focus.update(listOf(user("u1")), working = true)
        assertNull(focus.update(listOf(agent("a2"), agent("a1"), user("u1")), working = true))
    }

    @Test fun aReplyThatCameWhileIdleDoesntReveal() {
        val focus = RevealFocus()
        focus.update(listOf(user("u1")), working = false)
        assertNull(focus.update(listOf(agent("a1"), user("u1")), working = false))
    }
}
