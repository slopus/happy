package com.slopus.happy.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * happy-cli's Claude run reports a finished /clear and /compact as completion
 * events (claudeRemote.ts, through apiSession.ts `sendSessionEvent`); the
 * chat draws those as its context divider and nothing else.
 */
class ContextBoundaryTest {
    @Test fun `the CLI's completion events name their boundary`() {
        assertEquals(ContextBoundary.Cleared, AgentEvent.Message("Context was reset").contextBoundary())
        assertEquals(ContextBoundary.Compacted, AgentEvent.Message("Compaction completed").contextBoundary())
    }

    @Test fun `every other event is not a boundary`() {
        assertNull(AgentEvent.Message("Compaction started").contextBoundary())
        assertNull(AgentEvent.Message("Turn started").contextBoundary())
        assertNull(AgentEvent.Message("Context was reset.").contextBoundary())
        assertNull(AgentEvent.Switch("local").contextBoundary())
        assertNull(AgentEvent.LimitReached(1_700_000_000).contextBoundary())
        assertNull(AgentEvent.Message("Context reset in terminal").contextBoundary())
        assertNull(AgentEvent.Ready.contextBoundary())
    }

    @Test fun `only an event row can be a boundary row`() {
        val reset = ChatRow.Event(ChatMessage.Event("e", 0, AgentEvent.Message("Context was reset")))
        val compacted = ChatRow.Event(ChatMessage.Event("e", 0, AgentEvent.Message("Compaction completed")))
        val switch = ChatRow.Event(ChatMessage.Event("e", 0, AgentEvent.Switch("local")))
        val text = ChatRow.AgentText(ChatMessage.AgentText("a", 0, "Context was reset"), emptyList())
        assertTrue(reset.isContextBoundaryRow())
        assertTrue(compacted.isContextBoundaryRow())
        assertFalse(switch.isContextBoundaryRow())
        assertFalse(text.isContextBoundaryRow())
    }

    @Test fun `a local clear wrapper names the cleared boundary`() {
        val clear = commandWrapper("clear")
        assertEquals(ContextBoundary.Cleared, localCommandBoundary(clear, hasLocalId = false))
        assertEquals(AgentEvent.Message("Context was reset"), localCommandBoundary(clear, hasLocalId = false)?.completionEvent())
    }

    @Test fun `a local compact wrapper names the compacted boundary with any args`() {
        assertEquals(ContextBoundary.Compacted, localCommandBoundary(commandWrapper("compact"), hasLocalId = false))
        assertEquals(
            ContextBoundary.Compacted,
            localCommandBoundary(commandWrapper("compact", "keep the plan"), hasLocalId = false),
        )
        assertEquals(
            AgentEvent.Message("Compaction completed"),
            localCommandBoundary(commandWrapper("compact"), hasLocalId = false)?.completionEvent(),
        )
    }

    @Test fun `only the SDK's clear and compact wrappers are boundaries`() {
        assertNull("the person's own echo has a local id", localCommandBoundary(commandWrapper("clear"), hasLocalId = true))
        assertNull("a raw /clear is not the wrapper", localCommandBoundary("/clear", hasLocalId = false))
        assertNull("clear takes no args", localCommandBoundary(commandWrapper("clear", "foo"), hasLocalId = false))
        assertNull("another command", localCommandBoundary(commandWrapper("model"), hasLocalId = false))
    }
}
