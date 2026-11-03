package com.slopus.happy.ui.connection

import androidx.compose.ui.unit.dp
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.Wire
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.NOW
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.big
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.catalog
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.sample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * happy-ios HappyCore/Agents/Search.swift (SearchTests): what an empty
 * search shows, which of home's rows answer a query and what they keep
 * with them, and the pull that closes search.
 */
class AgentSearchTest {
    private val feed = AgentFeed.derive(catalog(sample))

    private val label = { row: AgentFeedRow ->
        when (row) {
            is AgentFeedRow.Conversation -> row.title ?: "New chat"
            is AgentFeedRow.Folder -> row.name
            is AgentFeedRow.Surface -> row.name
            AgentFeedRow.Artifacts -> "Artifacts"
            is AgentFeedRow.Section -> null
        }
    }

    private fun keys(rows: List<AgentFeedRow>) = rows.map { it.key }

    @Test
    fun emptyShowsTheBotsAndTasksLastActiveNewestFirstABotByItsSubtasks() {
        // The Happy bot's own activity is 20 minutes ago, its subtask's 5: it stands second, after the task a minute ago, alone.
        assertEquals(listOf("agent-at1", "agent-ab1", "agent-ab2", "agent-at2", "agent-at3"), keys(AgentSearch.recent(feed)))
    }

    @Test
    fun emptyShowsEightAmongEqualsInHomesOrderAndNoneNeverActive() {
        val many = AgentFeed.derive(catalog(big(40)))
        assertEquals((0 until 8).map { "agent-at$it" }, keys(AgentSearch.recent(many)))
        val idle = AgentFeed.derive(
            catalog(
                Wire.bootstrap(
                    bots = listOf(
                        Wire.bot("b1", "Never", Wire.agent("ab1", updatedAt = 0)),
                        Wire.bot("b2", "Once", Wire.agent("ab2", updatedAt = NOW), orderKey = "2"),
                    ),
                ),
            ),
        )
        assertEquals(listOf("agent-ab2"), keys(AgentSearch.recent(idle)))
    }

    @Test
    fun aNestedMatchKeepsWhatItNestsUnderInHomesOrder() {
        // The subtask keeps its bot; the worktree's conversation keeps the project and the worktree.
        assertEquals(listOf("agent-ab1", "agent-as1"), keys(AgentSearch.rows(feed, "review", label)))
        val scroll = keys(AgentSearch.rows(feed, "scroll", label))
        assertEquals(3, scroll.size)
        assertEquals("folder-p1", scroll.first())
        assertEquals("agent-aw1", scroll.last())
        // Home's order, not the rank's: the document before the task that starts with the word.
        assertEquals(listOf("surface-s1", "agent-at3"), keys(AgentSearch.rows(feed, "plan", label)))
        assertEquals(listOf("artifacts"), keys(AgentSearch.rows(feed, "artif", label)))
        assertTrue(AgentSearch.rows(feed, "zzzz", label).isEmpty())
    }

    @Test
    fun resultsAreHomesRowsInOneCardThenActionsAndSettingsUnderHeadings() {
        val action = AgentSearchEntry("new-work", "New task", com.slopus.happy.ui.components.Ionicon.CreateOutline) {}
        val setting = AgentSearchEntry("prefs", "Preferences", com.slopus.happy.ui.components.Ionicon.SettingsOutline) {}
        val found = agentSearchResults(feed, "re", label, "Quick actions" to "Settings", listOf(action), listOf(setting))
        val home = found.takeWhile { it is AgentSearchResult.Home }.map { (it as AgentSearchResult.Home).item }
        assertTrue(home.first().first && home.drop(1).none { it.first })
        assertTrue(home.last().last && home.dropLast(1).none { it.last })
        assertEquals(
            listOf("heading-Settings", "entry-prefs"),
            found.drop(home.size).map { it.key },
        )
        // Nothing typed: the recent ones alone, no heading, no action.
        val empty = agentSearchResults(feed, " ", label, "Quick actions" to "Settings", listOf(action), listOf(setting))
        assertTrue(empty.all { it is AgentSearchResult.Home })
    }

    @Test
    fun aPullClosesFarOrFlung() {
        assertTrue(AgentSearch.pullCloses(100.dp, 0.dp))
        assertTrue(AgentSearch.pullCloses(24.dp, 700.dp))
        assertFalse(AgentSearch.pullCloses(99.dp, 699.dp))
        assertFalse(AgentSearch.pullCloses(23.dp, 2000.dp))
    }
}
