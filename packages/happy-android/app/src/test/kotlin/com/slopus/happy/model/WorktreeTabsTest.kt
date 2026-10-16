package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * worktreeTabs.ts neighbouringTabId and useWorktreeTabSuccessor: an
 * archived tab hands over to the one before it, else the one after, among
 * its checkout's chats oldest first; only in the project layout.
 */
class WorktreeTabsTest {
    private fun data(vararg sessions: Session) = buildSessionListViewData(SessionListInputs(sessions.toList(), emptyMap()))

    private fun tab(id: String, createdAt: Long, workspaceId: String? = "w1") =
        session(id, rigMetadata(projectId = "p1", workspaceId = workspaceId), createdAt = createdAt)

    @Test
    fun theTabBeforeElseTheOneAfter() {
        val items = data(tab("a", 1), tab("b", 2), tab("c", 3), tab("own", 4, workspaceId = null))
        assertEquals("a", worktreeTabSuccessor(items, "b", SessionListGrouping.Project))
        assertEquals("b", worktreeTabSuccessor(items, "a", SessionListGrouping.Project))
        assertEquals("b", worktreeTabSuccessor(items, "c", SessionListGrouping.Project))
        // Alone in its checkout: no successor, the chat leaves the usual way.
        assertNull(worktreeTabSuccessor(items, "own", SessionListGrouping.Project))
        assertNull(worktreeTabSuccessor(items, "missing", SessionListGrouping.Project))
        assertNull(worktreeTabSuccessor(items, "b", SessionListGrouping.Flat))
    }

    @Test
    fun neighbouringTabId() {
        val rows = listOf(tab("x", 1), tab("y", 2)).map { buildSessionRowData(it, SessionListInputs(emptyList(), emptyMap())) }
        assertEquals("y", neighbouringTabId(rows, "x"))
        assertEquals("x", neighbouringTabId(rows, "y"))
        assertNull(neighbouringTabId(rows.take(1), "x"))
        assertNull(neighbouringTabId(rows, "z"))
    }
}
