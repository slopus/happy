package com.slopus.happy.agent

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home's rows from the catalog, and the journal merged into it. */
class AgentFeedTest {
    private fun catalog(bootstrap: kotlinx.serialization.json.JsonObject) =
        AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))

    private val sample = Wire.bootstrap(
        bots = listOf(
            Wire.bot("b2", "Second", Wire.agent("ab2"), orderKey = "2"),
            Wire.bot("b1", "Happy", Wire.agent("ab1", subtasks = listOf(Wire.agent("as1", title = "Sub", subtask = true, parent = "ab1",
                subtasks = listOf(Wire.agent("as2", title = "Grandchild", subtask = true, parent = "as1"))))), orderKey = "1"),
            Wire.bot("b3", "Gone", Wire.agent("ab3"), archived = true),
        ),
        tasks = listOf(
            Wire.task("t1", "Fix login", Wire.agent("at1", status = "running_tools")),
            Wire.task("t2", "Write docs", Wire.agent("at2", unread = true)),
            Wire.task("t3", "Not joined", Wire.agent("at3")),
        ),
        memberships = listOf(Wire.membership("t2", "1"), Wire.membership("t1", "2")),
        projects = listOf(Wire.project("p1", "rig", listOf(Wire.agent("ap1", title = "Refactor", orderKey = "1")))),
        workspaces = listOf(Wire.workspace("w1", "p1", "fix-login", listOf(Wire.agent("aw1", title = "In worktree", question = true)))),
    )

    @Test
    fun conversationsComeInTheAgentsOwnOrders() {
        val feed = AgentFeed.derive(catalog(sample))
        assertEquals(
            listOf("section-bots", "agent-ab1", "agent-as1", "agent-as2", "agent-ab2", "section-tasks", "agent-at2", "agent-at1", "section-project-p1", "agent-ap1", "agent-aw1"),
            feed.rows.map { it.key },
        )
        val rows = feed.conversations.associateBy { it.agentId }
        assertEquals("Happy", rows.getValue("ab1").title)
        assertEquals(ConversationKind.Subtask, rows.getValue("as1").kind)
        assertEquals(2, rows.getValue("as2").depth)
        assertTrue(rows.getValue("at1").working)
        assertTrue(rows.getValue("at2").unread)
        assertTrue(rows.getValue("aw1").blocked)
        assertEquals("fix-login", rows.getValue("aw1").detail)
        assertEquals(2, rows.getValue("ab1").childCount)
        assertEquals(1, rows.getValue("as1").childCount)
        assertEquals("as1", rows.getValue("as2").parentId)
    }

    @Test
    fun aChatOpenedFromARowGetsThatRowsName() {
        val feed = AgentFeed.derive(catalog(sample))
        assertEquals("Happy", feed.title("ab1"))
        assertEquals(null, feed.title("nobody"))
        assertEquals(null, AgentFeed.Empty.title("ab1"))
    }

    @Test
    fun anAgentUpdateMergesByVersionAndKeepsUnchangedRows() {
        val before = catalog(sample)
        val feed = AgentFeed.derive(before)
        val event = Wire.event("c1", "agent.updated", Wire.updated("agentId", "at1", "01", "02", buildJsonObject { put("status", "idle"); put("updatedAt", 3L) }))
        val applied = before.apply(event)
        assertTrue(applied.stale.isEmpty())
        assertEquals("c1", applied.catalog.cursor)
        val next = AgentFeed.reuse(feed, AgentFeed.derive(applied.catalog))
        assertFalse(next.conversations.single { it.agentId == "at1" }.working)
        assertSame(feed.rows.first { it.key == "agent-ab1" }, next.rows.first { it.key == "agent-ab1" })
        // Replayed, or an older copy: nothing changes.
        assertSame(applied.catalog.agents, applied.catalog.apply(event).catalog.agents)
    }

    @Test
    fun aMissedUpdateIsMergedAndReadAgain() {
        val applied = catalog(sample).apply(
            Wire.event("c1", "task.updated", Wire.updated("taskId", "t1", "00x", "05", buildJsonObject { put("name", "Renamed") })),
        )
        assertEquals(listOf(AgentCatalog.Stale("task", "t1")), applied.stale)
        assertEquals("Renamed", AgentFeed.derive(applied.catalog).conversations.single { it.agentId == "at1" }.title)
    }

    @Test
    fun aDelayedOwnerSnapshotNeverUndoesANewerAgent() {
        val live = catalog(sample).apply(
            Wire.event("c1", "agent.updated", Wire.updated("agentId", "ab2", "01", "03", buildJsonObject { put("status", "working") })),
        ).catalog
        val reread = live.withResource("bot", Wire.bot("b2", "Second", Wire.agent("ab2", version = "02"), orderKey = "2", version = "02"))
        assertTrue(AgentFeed.derive(reread).conversations.single { it.agentId == "ab2" }.working)
    }

    @Test
    fun newTasksSubtasksAndMembershipsArrive() {
        var current = catalog(sample)
        current = current.apply(Wire.event("c1", "task.created", buildJsonObject { put("task", Wire.task("t4", "New", Wire.agent("at4"))) })).catalog
        // Created but not yet joined: not in the person's list.
        assertFalse(AgentFeed.derive(current).conversations.any { it.agentId == "at4" })
        current = current.apply(Wire.event("c2", "task.joined", buildJsonObject { put("membership", Wire.membership("t4", "0")) })).catalog
        assertEquals("agent-at4", AgentFeed.derive(current).rows[current.let { AgentFeed.derive(it).rows.indexOfFirst { r -> r.key == "section-tasks" } } + 1].key)
        current = current.apply(Wire.event("c3", "agent.created", buildJsonObject {
            put("agent", Wire.agent("as9", title = "Helper", subtask = true, parent = "at4"))
        })).catalog
        val keys = AgentFeed.derive(current).rows.map { it.key }
        assertEquals(keys.indexOf("agent-at4") + 1, keys.indexOf("agent-as9"))
        current = current.apply(Wire.event("c4", "task.left", buildJsonObject { put("membership", Wire.membership("t4", "0")) })).catalog
        assertFalse(AgentFeed.derive(current).conversations.any { it.agentId == "at4" })
    }

    @Test
    fun aTaskMadeHereShowsFirstBeforeItsEventsCome() {
        val current = catalog(sample).withTask(Wire.task("t5", "New Task", Wire.agent("at5")))
        val rows = AgentFeed.derive(current).rows.map { it.key }
        assertEquals(rows.indexOf("section-tasks") + 1, rows.indexOf("agent-at5"))
    }

    @Test
    fun archivedAndHiddenConversationsAreLeftOut() {
        val current = catalog(sample).apply(
            Wire.event("c1", "agent.updated", Wire.updated("agentId", "ap1", "01", "02", buildJsonObject { put("archivedAt", 7L) })),
        ).catalog
        val ids = AgentFeed.derive(current).conversations.map { it.agentId }
        assertFalse("ap1" in ids)
        assertFalse("ab3" in ids)
        assertFalse("at3" in ids)
    }

    @Test
    fun nothingLoadedIsNotEmpty() {
        assertFalse(AgentFeed.derive(AgentCatalog()).loaded)
        val empty = AgentFeed.derive(catalog(Wire.bootstrap()))
        assertTrue(empty.loaded)
        assertTrue(empty.rows.isEmpty())
    }
}
