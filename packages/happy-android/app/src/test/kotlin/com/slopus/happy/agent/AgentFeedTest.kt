package com.slopus.happy.agent

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home's rows from the catalog, and the journal merged into it. */
class AgentFeedTest {
    @Test
    fun lineCountsBelongToTheExactWorkspaceAndDisappearWhenCleanOrUnavailable() {
        val snapshot = Wire.bootstrap(
            tasks = listOf(Wire.task("task", "Task", Wire.agent("parent", workspaceId = "root", subtasks = listOf(
                Wire.agent("child", workspaceId = "child-tree", subtask = true, parent = "parent"),
            )))),
            memberships = listOf(Wire.membership("task", "1")),
        )
        val counts = WorkspaceLineChanges("ready", 1234, 7, false, 1.0)
        val feed = AgentFeed.derive(catalog(snapshot), git = mapOf("child-tree" to counts))
        assertEquals(null, feed.conversations.first { it.agentId == "parent" }.lineChanges)
        assertEquals(counts, feed.conversations.first { it.agentId == "child" }.lineChanges)
        for (hidden in listOf(counts.copy(comparison = "unavailable"), counts.copy(insertions = 0, deletions = 0))) {
            assertTrue(AgentFeed.derive(catalog(snapshot), git = mapOf("child-tree" to hidden)).conversations.all { it.lineChanges == null })
        }
    }

    private fun catalog(bootstrap: kotlinx.serialization.json.JsonObject) =
        AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))

    private val sample = Wire.bootstrap(
        bots = listOf(
            Wire.bot("b2", "Second", Wire.agent("ab2"), orderKey = "2", thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"),
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
            listOf(
                "section-places", "artifacts",
                "section-bots", "agent-ab1", "agent-as1", "agent-as2", "agent-ab2",
                "section-tasks", "agent-at2", "agent-at1",
                "section-projects", "folder-p1", "agent-ap1", "folder-w1", "agent-aw1",
            ),
            feed.rows.map { it.key },
        )
        val rows = feed.conversations.associateBy { it.agentId }
        assertEquals("Happy", rows.getValue("ab1").title)
        assertEquals(ConversationKind.Subtask, rows.getValue("as1").kind)
        assertEquals(2, rows.getValue("as2").depth)
        assertTrue(rows.getValue("at1").working)
        assertTrue(rows.getValue("at2").unread)
        assertTrue(rows.getValue("aw1").blocked)
        // A project's conversations a level under its folder, a worktree's two.
        assertEquals(1, rows.getValue("ap1").depth)
        assertEquals(2, rows.getValue("aw1").depth)
        assertEquals("as1", rows.getValue("as2").parentId)
        assertEquals(listOf("rig" to 0, "fix-login" to 1), feed.rows.filterIsInstance<AgentFeedRow.Folder>().map { it.name to it.depth })
    }

    @Test
    fun desktopsHideProjectsLeavesTheProjectsOutLiveAndTheNewerVersionWins() {
        val keys = { catalog: AgentCatalog -> AgentFeed.derive(catalog).rows.map { it.key } }
        val shown = catalog(sample)
        assertTrue("section-projects" in keys(shown))

        // In the snapshot: no projects, their worktrees or their conversations; bots and tasks stay.
        val hidden = catalog(sample.with("userSettings", kotlinx.serialization.json.JsonArray(listOf(Wire.projectsHidden(true, "v2")))))
        assertTrue(hidden.projectsHidden)
        assertEquals(
            listOf("section-places", "artifacts", "section-bots", "agent-ab1", "agent-as1", "agent-as2", "agent-ab2", "section-tasks", "agent-at2", "agent-at1"),
            keys(hidden),
        )

        // Shown again on the desktop: `user_settings.updated` brings them back at once.
        val again = hidden.apply(Wire.event("c1", "user_settings.updated", buildJsonObject { put("setting", Wire.projectsHidden(false, "v3")) })).catalog
        assertFalse(again.projectsHidden)
        assertEquals(keys(shown), keys(again))

        // An older copy (a late event, a snapshot read before the change) never undoes a newer one.
        val stale = again.apply(Wire.event("c2", "user_settings.updated", buildJsonObject { put("setting", Wire.projectsHidden(true, "v1")) })).catalog
        assertFalse(stale.projectsHidden)
        val snapshot = again.withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(),
            sample.with("userSettings", kotlinx.serialization.json.JsonArray(listOf(Wire.projectsHidden(true, "v2"))))))
        assertFalse(snapshot.projectsHidden)

        // Cleared (null) or anything but `true` shows them.
        val cleared = hidden.withSetting(Wire.setting(DesktopSettings.PROJECTS_VISIBILITY, kotlinx.serialization.json.JsonNull, "v9"))
        assertFalse(cleared.projectsHidden)

        // A change made on this phone shows over the agent's until it is answered, and a stale answer keeps a later change.
        val local = shown.withPendingSetting(DesktopSettings.PROJECTS_VISIBILITY, DesktopSettings.projectsVisibility(true), "m1", 5L)
        assertTrue(local.projectsHidden)
        val relocal = local.withPendingSetting(DesktopSettings.PROJECTS_VISIBILITY, DesktopSettings.projectsVisibility(false), "m2", 6L)
        val answered = relocal.settingAcknowledged(DesktopSettings.PROJECTS_VISIBILITY, "m1", Wire.projectsHidden(true, "v4"))
        assertFalse(answered.projectsHidden)
        assertEquals("m2", answered.pendingSettings.getValue(DesktopSettings.PROJECTS_VISIBILITY).mutationId)
        val done = answered.settingAcknowledged(DesktopSettings.PROJECTS_VISIBILITY, "m2", Wire.projectsHidden(false, "v5"))
        assertTrue(done.pendingSettings.isEmpty())
        assertFalse(done.projectsHidden)
    }

    @Test
    fun onlyABotWithAPictureHasOne() {
        val rows = AgentFeed.derive(catalog(sample)).conversations.associateBy { it.agentId }
        assertEquals("/v0/bots/b2/avatar", rows.getValue("ab2").picture)
        assertEquals("1QcSHQRnh493V4dIh4eXh1h4kJUI", rows.getValue("ab2").thumbhash)
        for (id in listOf("ab1", "as1", "at1", "ap1", "aw1")) assertEquals(id, null, rows.getValue(id).picture)
    }

    /**
     * API.md "Projects": `avatar` is `{kind: "image", thumbhash, source}`
     * (bytes at /v0/projects/:id/avatar, whether the person chose it for a
     * local folder or the agent made it), `{kind: "home"}`, or null. A
     * project without a picture wears the placeholder its id picks; a
     * worktree wears nothing.
     */
    @Test
    fun everyProjectWearsAMarkAndASubtasksWorktreeIsListedOnce() {
        val feed = AgentFeed.derive(catalog(Wire.bootstrap(
            bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1", subtasks = listOf(Wire.agent("as1", subtask = true, parent = "ab1", workspaceId = "w2"))))),
            projects = listOf(
                Wire.project("p1", "happy", emptyList(), avatar = "image", thumbhash = "3OcRJYB4d3h3iIeHeEh3eIhw+j2w"),
                Wire.project("p2", "site", emptyList(), orderKey = "2"),
                Wire.project("home", "Home", emptyList(), orderKey = "3", avatar = "home"),
                Wire.project("p/4", "odd", emptyList(), orderKey = "4", avatar = "image"),
            ),
            workspaces = listOf(Wire.workspace("w1", "p1", "feature", emptyList()), Wire.workspace("w2", "p1", "subtask-tree", emptyList(), orderKey = "2")),
        )))
        val folders = feed.rows.filterIsInstance<AgentFeedRow.Folder>()
        assertEquals(listOf("happy", "feature", "site", "Home", "odd"), folders.map { it.name })
        assertEquals(
            listOf(
                FolderMark.Picture("/v0/projects/p1/avatar", "3OcRJYB4d3h3iIeHeEh3eIhw+j2w"),
                null,
                FolderMark.Placeholder("p2"),
                FolderMark.Home,
                FolderMark.Picture("/v0/projects/p%2F4/avatar", null),
            ),
            folders.map { it.mark },
        )
    }

    /** An avatar the wire doesn't describe (an unknown kind, desktop's own `url` form) is no picture. */
    @Test
    fun anUnknownProjectAvatarIsThePlaceholder() {
        val project = buildJsonObject {
            put("id", "p1")
            put("avatar", buildJsonObject { put("url", "https://example.com/a.png") })
        }
        assertEquals(FolderMark.Placeholder("p1"), FolderMark.of("p1", project))
        assertEquals(FolderMark.Placeholder("p1"), FolderMark.of("p1", buildJsonObject { put("id", "p1") }))
    }

    /**
     * happy-ios SidebarRows: a bot or task wears the placeholder its own
     * (owner) id picks, unless it is the person's Happy (Happy's mark) or a
     * bot with a picture; a subtask and a project's conversation wear none.
     */
    @Test
    fun botsAndTasksArePlacedByTheirOwnIds() {
        val feed = AgentFeed.derive(catalog(Wire.bootstrap(
            bots = listOf(
                Wire.bot("b1", "Scout", Wire.agent("ab1")),
                Wire.bot("b2", "Happy", Wire.agent("ab2"), orderKey = "2").let { JsonObject(it + ("systemKey" to JsonPrimitive("chief_of_staff"))) },
            ),
            tasks = listOf(Wire.task("t1", "Ship", Wire.agent("at1"))),
            memberships = listOf(Wire.membership("t1", "1")),
        )))
        val rows = feed.conversations.associateBy { it.agentId }
        assertEquals("b1", rows.getValue("ab1").seed)
        assertFalse(rows.getValue("ab1").happy)
        assertTrue(rows.getValue("ab2").happy)
        assertEquals("t1", rows.getValue("at1").seed)
        // The Chief of Staff goes by the name the computer gives its bot (desktop ca4c303f), not one guessed.
        assertEquals("Happy", feed.chiefOfStaffName())
        assertEquals(null, AgentFeed.derive(catalog(Wire.bootstrap(bots = listOf(Wire.bot("b1", "Scout", Wire.agent("ab1")))))).chiefOfStaffName())
    }

    /** Desktop's bot attention (731c8bbc, 1dc8b566; iOS SidebarRows): hidden leaves the bot out, muted quiets it and its subtasks. */
    @Test
    fun aBotHiddenOnTheDesktopIsLeftOutAndAMutedOneIsQuiet() {
        fun attention(bot: String, muted: Boolean = false, hidden: Boolean = false) = Wire.setting(
            DesktopSettings.BOT_PREFIX + bot, buildJsonObject { put("muted", muted); put("hidden", hidden) }, "v1",
        )
        val feed = AgentFeed.derive(catalog(Wire.bootstrap(
            bots = listOf(
                Wire.bot("b1", "Loud", Wire.agent("ab1", status = "running", unread = true, question = true)),
                Wire.bot("b2", "Quiet", Wire.agent("ab2", status = "running", unread = true, question = true, wait = true,
                    subtasks = listOf(Wire.agent("as2", title = "Sub", status = "running", unread = true, subtask = true, parent = "ab2"))), orderKey = "2"),
                Wire.bot("b3", "Hidden", Wire.agent("ab3"), orderKey = "3"),
            ),
            userSettings = listOf(attention("b2", muted = true), attention("b3", hidden = true)),
        )))
        val rows = feed.conversations.associateBy { it.agentId }
        assertEquals(setOf("ab1", "ab2", "as2"), rows.keys)
        assertTrue(rows.getValue("ab1").unread && rows.getValue("ab1").blocked)
        for (quiet in listOf("ab2", "as2")) {
            val row = rows.getValue(quiet)
            assertFalse(quiet, row.working || row.unread || row.blocked || row.waiting)
        }
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
        // Artifacts is always there, as on desktop; nothing else is.
        assertEquals(listOf("section-places", "artifacts"), empty.rows.map { it.key })
    }

    @Test
    fun theSurfacesThePersonJoinedFollowArtifactsInTheirOrder() {
        val bootstrap = Wire.bootstrap(
            surfaces = listOf(
                Wire.surface("s1", "Groceries", "todo", mapOf("u2" to "0", Wire.USER to "3")),
                Wire.surface("s2", "Launch plan", "document", mapOf(Wire.USER to "1")),
                Wire.surface("s3", "Week", "calendar", mapOf(Wire.USER to "2")),
                Wire.surface("s4", "Not mine", "todo", mapOf("u2" to "1")),
                Wire.surface("s5", "Old", "todo", archived = true),
            ),
            bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1"))),
        )
        val rows = AgentFeed.derive(catalog(bootstrap)).rows
        assertEquals(
            listOf("section-places", "artifacts", "surface-s2", "surface-s3", "surface-s1", "section-bots", "agent-ab1"),
            rows.map { it.key },
        )
        assertEquals(AgentFeedRow.Surface("s3", "Week", "calendar"), rows[3])
    }

    @Test
    fun aComputerWithNoAccountListsItsOnePersonsSurfaces() {
        fun local(id: String, name: String, orderKey: String) = buildJsonObject {
            put("id", id); put("name", name); put("type", "todo"); put("status", "active"); put("archivedAt", JsonNull)
            put("members", JsonArray(listOf(buildJsonObject { put("userId", JsonNull); put("orderKey", orderKey) })))
        }
        val bootstrap = JsonObject(
            Wire.bootstrap(surfaces = listOf(local("s1", "Groceries", "2"), local("s2", "Launch", "1"))) +
                ("profile" to buildJsonObject { put("userId", JsonNull) }),
        )
        assertEquals(
            listOf("section-places", "artifacts", "surface-s2", "surface-s1"),
            AgentFeed.derive(catalog(bootstrap)).rows.map { it.key },
        )
    }

    @Test
    fun aSurfaceEventReadsTheSnapshotAgain() {
        val applied = catalog(Wire.bootstrap()).apply(Wire.event("c1", "surface.created", buildJsonObject { put("surfaceId", "s9") }))
        assertEquals(listOf(AgentCatalog.Stale(AgentCatalog.Stale.SNAPSHOT, "")), applied.stale)
        assertEquals("c1", applied.catalog.cursor)
        // A todo inside a list changes nothing home shows.
        assertTrue(catalog(Wire.bootstrap()).apply(Wire.event("c2", "todo.created", buildJsonObject { put("surfaceId", "s9") })).stale.isEmpty())
    }

    /** Desktop's `activity == "running"`: what shimmers a row's title on home. */
    @Test
    fun aConversationRunsWhileItWorksOutsideAQuestionOrAWait() {
        val feed = AgentFeed.derive(
            catalog(
                Wire.bootstrap(
                    bots = listOf(
                        Wire.bot("b1", "Idle", Wire.agent("idle"), orderKey = "1"),
                        Wire.bot("b2", "Busy", Wire.agent("busy", status = "thinking"), orderKey = "2"),
                        Wire.bot("b3", "Asking", Wire.agent("asking", status = "running_tools", question = true), orderKey = "3"),
                        Wire.bot("b4", "Waiting", Wire.agent("waiting", status = "working", wait = true), orderKey = "4"),
                        // Idle itself, but its subtask works: the work it handed off is its own.
                        Wire.bot(
                            "b5", "Delegating",
                            Wire.agent("parent", subtasks = listOf(Wire.agent("child", status = "working", subtask = true, parent = "parent"))),
                            orderKey = "5",
                        ),
                    ),
                ),
            ),
        )
        val rows = feed.conversations.associateBy { it.agentId }
        assertFalse(rows.getValue("idle").running)
        assertTrue(rows.getValue("busy").running)
        assertFalse("a question outranks the work", rows.getValue("asking").running)
        assertFalse("a scheduled wait is still", rows.getValue("waiting").running)
        assertTrue(rows.getValue("waiting").working)
        assertTrue(rows.getValue("child").running)
        assertTrue(rows.getValue("parent").delegating)
        assertTrue(rows.getValue("parent").running)
    }

    @Test
    fun aFolderRunsWhileAConversationInItRunsAndNoneAsks() {
        fun folders(vararg projectAgents: kotlinx.serialization.json.JsonObject, worktree: List<kotlinx.serialization.json.JsonObject> = emptyList()) =
            AgentFeed.derive(
                catalog(
                    Wire.bootstrap(
                        projects = listOf(Wire.project("p1", "rig", projectAgents.toList())),
                        workspaces = listOf(Wire.workspace("w1", "p1", "fix", worktree)),
                    ),
                ),
            ).rows.filterIsInstance<AgentFeedRow.Folder>().associate { it.id to it.running }

        assertEquals(mapOf("p1" to false, "w1" to false), folders(Wire.agent("a"), worktree = listOf(Wire.agent("b"))))
        // The project's own chat works: the project shimmers, its idle worktree doesn't.
        assertEquals(mapOf("p1" to true, "w1" to false), folders(Wire.agent("a", status = "working"), worktree = listOf(Wire.agent("b"))))
        // Work in a worktree runs in its project too.
        assertEquals(mapOf("p1" to true, "w1" to true), folders(Wire.agent("a"), worktree = listOf(Wire.agent("b", status = "thinking"))))
        // A question anywhere under it stills the folder, as desktop's awaitingInput outranks running.
        assertEquals(
            mapOf("p1" to false, "w1" to false),
            folders(Wire.agent("a", status = "working"), worktree = listOf(Wire.agent("b", question = true))),
        )
    }
}
