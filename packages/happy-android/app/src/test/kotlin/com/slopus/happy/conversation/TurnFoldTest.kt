package com.slopus.happy.conversation

import com.slopus.happy.conversation.ui.UiComponent
import com.slopus.happy.conversation.ui.UiOffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** How a finished turn folds (desktop's `happyAgentConnectGroupProject`, iOS 7f6355041 `TurnFold`). */
class TurnFoldTest {
    private fun user(key: String) = ConversationRow.User(key, key, "Hi", emptyList(), emptyList(), Delivery.Sent, 1)
    private fun text(key: String) = ConversationRow.Text(key, "Done", emptyList())
    private fun tool(key: String, presentation: Presentation? = null, status: String = "completed") =
        ConversationRow.Tool(key, key, ToolUse("exec_command", status, presentation))
    private fun end(tools: Int) = ConversationRow.TurnEnd("r:status", "r", "completed", 1_000, tools, "Done")

    @Test fun aTurnStillRunningIsLeftAlone() {
        val group = listOf(user("u"), tool("t1"), text("a"))
        assertEquals(group, TurnFold.fold("r", group, open = false))
    }

    @Test fun aTurnWithNothingToHideHasNoControl() {
        val group = listOf(user("u"), text("a"), end(0))
        assertEquals(group, TurnFold.fold("r", group, open = false))
    }

    @Test fun closedItKeepsResultsAndTheAnswerAndTheControlRidesTheAnswer() {
        val diff = tool("t2", Presentation.FileDiff(listOf(Presentation.FileDiff.File("a.ts", "update", 1, 1))))
        val group = listOf(user("u"), tool("t1"), diff, text("a"), end(2))
        val folded = TurnFold.fold("r", group, open = false)
        assertEquals(listOf("u", "t2", "r:trace", "a", "r:status"), folded.map { it.key })
        assertEquals(ConversationRow.Trace("r:trace", "r", false, 2), folded[2])
    }

    @Test fun withoutAnAnswerTheControlRidesTheLastStepAndTheEndSitsFurtherOff() {
        val diff = tool("t2", Presentation.FileDiff(listOf(Presentation.FileDiff.File("a.ts", "add", 3, null))))
        val group = listOf(user("u"), tool("t1"), diff, end(2))
        val folded = TurnFold.fold("r", group, open = false)
        assertEquals(listOf("u", "r:trace", "t2", "r:status"), folded.map { it.key })
        assertTrue((folded.last() as ConversationRow.TurnEnd).afterStep)
    }

    @Test fun closedItKeepsItsChatUiAndTheRepliesItSuggestedUnderTheRowThatOfferedThem() {
        val shown = ConversationRow.Ui("m:1:files", UiOffer("m", "u1", "files"), UiComponent.Other("files", "2 files"))
        val pictures = ConversationRow.UiMedia("m:1:pics", emptyList(), emptyList())
        val replies = ConversationRow.Replies("m:3", "m", "c1", listOf("Yes"))
        val group = listOf(user("u"), tool("t1"), shown, pictures, tool("t2"), replies, text("a"), end(2))
        val folded = TurnFold.fold("r", group, open = false)
        // The call right above the stack stays with it, though a call folds away.
        assertEquals(listOf("u", "m:1:files", "m:1:pics", "t2", "m:3", "r:trace", "a", "r:status"), folded.map { it.key })
    }

    @Test fun openTheControlRidesTheFirstStep() {
        val group = listOf(user("u"), tool("t1"), tool("t2"), text("a"), end(2))
        val opened = TurnFold.fold("r", group, open = true)
        assertEquals(listOf("u", "r:trace", "t1", "t2", "a", "r:status"), opened.map { it.key })
        assertTrue((opened[1] as ConversationRow.Trace).open)
    }
}
