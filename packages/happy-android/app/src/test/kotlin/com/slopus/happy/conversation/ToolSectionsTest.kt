package com.slopus.happy.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Group tool calls ([ToolSections], desktop's `conversationToolSections`). */
class ToolSectionsTest {
    private fun tool(key: String, status: String = "completed", presentation: Presentation? = null) =
        ConversationRow.Tool(key, key, ToolUse("Read", status, presentation, id = key))

    private fun text(key: String) = ConversationRow.Text(key, "words", emptyList())

    private fun end(endedAt: Long) = ConversationRow.TurnEnd("r1:status", "r1", "completed", 1_000, 3, null, endedAt = endedAt)

    private val times = mapOf("m1:0" to 1_000L, "m1:1" to 1_000L, "m2:0" to 4_000L, "m3:0" to 9_000L)
    private fun at(row: ConversationRow) = times[row.key]

    @Test fun aRunBetweenWordsIsOneEndedSectionTimedToWhatFollows() {
        val ended = HashSet<String>()
        val rows = ToolSections.group(listOf(text("m0:0"), tool("m1:0"), tool("m1:1"), text("m2:0")), working = true, ended = ended, at = ::at)
        val section = rows[1] as ConversationRow.Section
        assertEquals(3, rows.size)
        assertEquals("m1:0", section.key)
        assertEquals(2, section.calls.size)
        assertFalse(section.live)
        assertEquals(3_000L, section.durationMs)
        assertTrue("m1:0" in ended)
    }

    @Test fun theLastRunIsLiveWhileTheAgentWorksAndStaysEndedOnceSeenEnding() {
        val ended = HashSet<String>()
        val running = ToolSections.group(listOf(text("m0:0"), tool("m1:0")), working = true, ended = ended)
        assertTrue((running[1] as ConversationRow.Section).live)
        // The agent stopped working for a moment: the section ends.
        assertFalse((ToolSections.group(listOf(text("m0:0"), tool("m1:0")), working = false, ended = ended)[1] as ConversationRow.Section).live)
        // Working again with nothing after it, it doesn't open by itself.
        assertFalse((ToolSections.group(listOf(text("m0:0"), tool("m1:0")), working = true, ended = ended)[1] as ConversationRow.Section).live)
        // A call of its own under way does.
        assertTrue((ToolSections.group(listOf(text("m0:0"), tool("m1:0"), tool("m1:1", "running")), working = true, ended = ended)[1] as ConversationRow.Section).live)
    }

    @Test fun aTurnsEndEndsItsSectionsEvenWithACallStillRunning() {
        val rows = ToolSections.group(listOf(tool("m1:0"), tool("m1:1", "running"), end(9_000)), working = false, ended = HashSet(), at = ::at)
        val section = rows[0] as ConversationRow.Section
        assertFalse(section.live)
        assertEquals(8_000L, section.durationMs)
    }

    @Test fun mediaAndArtifactsKeepTheirRowsAndOpenedTurnsAreLeftApart() {
        val media = ConversationRow.Tool("m2:0", "m2:0", ToolUse("view_image", "completed", Presentation.Media(emptyList())))
        val rows = ToolSections.group(listOf(tool("m1:0"), media, tool("m3:0")), working = false, ended = HashSet())
        assertEquals(listOf(ConversationRow.Section::class, ConversationRow.Tool::class, ConversationRow.Section::class), rows.map { it::class })
        val apart = ToolSections.group(listOf(tool("m1:0"), tool("m1:1")), working = false, ended = HashSet(), apart = setOf("m1:0", "m1:1"))
        assertTrue(apart.all { it is ConversationRow.Tool })
    }

    @Test fun aFileEditFoldsWithItsTurnUnderGroupToolCallsAndAWatchedTurnKeepsItsRows() {
        val edit = ConversationRow.Tool("m1:0", "m1:0", ToolUse("Edit", "completed", Presentation.FileDiff(emptyList())))
        val turn = listOf(edit, tool("m1:1"), text("m2:0"), end(9_000))
        assertTrue(TurnFold.fold("r1", turn, open = false).any { it.key == "m1:0" })
        assertFalse(TurnFold.fold("r1", turn, open = false, grouped = true).any { it.key == "m1:0" })
        val quiet = TurnFold.fold("r1", turn, open = false, grouped = true, quiet = true)
        assertEquals(listOf("m1:0", "m1:1", "m2:0", ConversationRow.traceKey("r1"), "r1:status"), quiet.map { it.key })
        assertTrue((quiet[3] as ConversationRow.Trace).open)
    }
}
