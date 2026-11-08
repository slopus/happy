package com.slopus.happy.ui.connection

import androidx.compose.ui.unit.dp
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.Wire
import com.slopus.happy.search.SearchAnswer
import com.slopus.happy.search.SearchHit
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.NOW
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.big
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.catalog
import com.slopus.happy.ui.connection.AgentHomeLayoutTest.Companion.sample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Home's search: what an empty search shows (happy-ios SearchTests), the
 * phone's half of search ranked as the daemon ranks, its fusion with
 * the daemon's, and the pull that closes search.
 */
class AgentSearchTest {
    private val feed = AgentFeed.derive(catalog(sample))

    private val label = { row: AgentFeedRow ->
        when (row) {
            is AgentFeedRow.Conversation -> row.title ?: "New chat"
            is AgentFeedRow.Folder -> row.name
            is AgentFeedRow.Surface -> row.name
            AgentFeedRow.Artifacts -> "Artifacts"
            is AgentFeedRow.Feed -> "Activity"
            AgentFeedRow.Todos -> "Todos"
            is AgentFeedRow.Section -> null
        }
    }

    private val words = AgentSearchWords(
        actions = "Quick actions",
        settings = "Settings",
        surfaceType = { if (it == "todo") "Todo list" else it.replaceFirstChar(Char::uppercase) },
        artifactType = { if (it == "html") "Web page" else it },
        day = { millis, time, utc -> "day $millis${if (time) " at" else ""}${if (utc) " utc" else ""}" },
    )

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

    private fun found(query: String, sources: AgentSearchSources = AgentSearchSources.None, remote: SearchAnswer? = null) =
        agentSearchResults(feed, query, label, words, emptyList(), emptyList(), sources, remote).map { it.key }

    @Test
    fun aQueryFindsHomesThingsFlatUnderTheDaemonsKeys() {
        // A subtask and a worktree's chat stand alone, without what they nest under on home.
        assertEquals(listOf("agent:as1"), found("review"))
        // The worktree named for it too opens nothing on the phone, so isn't offered.
        assertEquals(listOf("agent:aw1"), found("scroll"))
        assertTrue(found("happy").none { it.startsWith("project:") })
        // Each kind's best first, the kinds in the daemon's provider order: the document before the task.
        assertEquals(listOf("document:s1", "agent:at3"), found("plan"))
        // Home's own pages, which only the phone has.
        assertEquals(listOf("home:artifacts"), found("artif"))
        assertTrue(found("zzzz").isEmpty())
        val subtask = agentSearchResults(feed, "review", label, words, emptyList(), emptyList()).single() as AgentSearchResult.Found
        assertEquals(0, ((subtask.local as AgentSearchResult.Home).item.row as AgentFeedRow.Conversation).depth)
    }

    @Test
    fun resultsAreOneCardThenActionsAndSettingsUnderHeadings() {
        val action = AgentSearchEntry("new-work", "New task", com.slopus.happy.ui.components.Ionicon.CreateOutline) {}
        val setting = AgentSearchEntry("prefs", "Preferences", com.slopus.happy.ui.components.Ionicon.SettingsOutline) {}
        val found = agentSearchResults(feed, "re", label, words, listOf(action), listOf(setting))
        val card = found.takeWhile { it is AgentSearchResult.Found }.map { (it as AgentSearchResult.Found).place }
        assertTrue(card.size > 1)
        assertTrue(card.first().first && card.drop(1).none { it.first })
        assertTrue(card.last().last && card.dropLast(1).none { it.last })
        assertEquals(listOf("heading-Settings", "entry-prefs"), found.drop(card.size).map { it.key })
        // Nothing typed: the recent ones alone, no heading, no action.
        val empty = agentSearchResults(feed, " ", label, words, listOf(action), listOf(setting))
        assertTrue(empty.all { it is AgentSearchResult.Home })
    }

    @Test
    fun severalWordsAnswerInAnyOrderAndWhatIsNotTheTitleRanksUnderIt() {
        // desktop's rowRank (28342477): a word's start, never a prefix, for words out of order; case and accents don't count.
        assertEquals(1, AgentSearch.rank("Fix login redirect", "redirect fix"))
        assertEquals(2, AgentSearch.rank("Fix login redirect", "direct login"))
        assertEquals(0, AgentSearch.rank("Fix login redirect", "fix LOGIN"))
        assertEquals(1, AgentSearch.rank("Café menu", "menu cafe"))
        assertEquals(null, AgentSearch.rank("Fix login redirect", "fix logout"))
        // The kind's name is found three below the title, and the words may be split between the two.
        assertEquals(3, AgentSearch.rank("Team", "calendar", listOf("Calendar")))
        assertEquals(4, AgentSearch.rank("Team", "calendar team", listOf("Calendar")))
        assertEquals(0, AgentSearch.rank("Calendar sync", "calendar", listOf("Calendar")))
        // Among equals, the lower tier, then the given order.
        assertEquals(listOf("b", "a", "c"), AgentSearch.ranked(listOf("a", "b", "c"), "x", tier = { if (it == "b") 0 else 1 }) { "x $it" })
    }

    private val sources = AgentSearchSources(
        surfaces = listOf(
            AgentSearchSources.Surface(AgentFeedRow.Surface("d2", "Plan for Q3", "document"), joined = false),
            AgentSearchSources.Surface(AgentFeedRow.Surface("s1", "Launch plan", "document"), joined = true),
            AgentSearchSources.Surface(AgentFeedRow.Surface("d1", "Plans archive", "document"), joined = true),
            AgentSearchSources.Surface(AgentFeedRow.Surface("l1", "Planning", "todo"), joined = true),
            AgentSearchSources.Surface(AgentFeedRow.Surface("c1", "Team", "calendar"), joined = true),
        ),
        todos = listOf(AgentSearchSources.Todo("todo1", "Plan the offsite", AgentFeedRow.Surface("l2", "Errands", "todo"))),
        artifacts = listOf(
            com.slopus.happy.artifacts.ArtifactRef("a1", 2, "html", "Sprint plan", followsLatest = true),
            com.slopus.happy.artifacts.ArtifactRef("a2", 1, "markdown", "Notes", followsLatest = true),
        ),
    )

    @Test
    fun aQueryFindsDocumentsTodosArtifactsAndSurfacesRankedAsTheDaemonRanks() {
        assertEquals(
            listOf(
                // First of each kind, in provider order: equally good, joined before not.
                "document:d1", "todo:todo1", "artifact:a1", "surface:l1", "agent:at3",
                // Then the second of each, and so on.
                "document:d2", "document:s1",
            ),
            found("plan", sources),
        )
        // The kind's name finds a Surface; an artifact by its type too.
        assertEquals(listOf("surface:c1"), found("calendar", sources))
        assertEquals(listOf("artifact:a1"), found("web page", sources))
        // Nothing typed: none of it.
        assertTrue(agentSearchResults(feed, "", label, words, emptyList(), emptyList(), sources).all { it is AgentSearchResult.Home })
    }

    @Test
    fun theDaemonsResultsFuseWithThePhonesByKey() {
        val remote = SearchAnswer(
            "plan",
            listOf(
                SearchHit.VaultFile("vault_file:f1", 1, "v1", "f1", "Launch plan.md", "/Docs/Launch plan.md", match = "content", line = 4, snippet = "The launch   plan moves"),
                SearchHit.Document("document:d2", 2, "d2", "Plan for Q3", match = "content", line = 2, snippet = "Plan the quarter"),
                SearchHit.Agent("agent:at3", 3, "at3", "Plan the launch", "task", workspaceId = "wt3"),
            ),
        )
        val results = agentSearchResults(feed, "plan", label, words, emptyList(), emptyList(), sources, remote).map { it as AgentSearchResult.Found }
        // document:d2 and agent:at3 are in both lists, their scores added: 1/62 + 1/66 over 1/63 + 1/65.
        // Then 1/61 each, the daemon's before the phone's.
        assertEquals(listOf("document:d2", "agent:at3", "vault_file:f1", "document:d1"), results.take(4).map { it.key })
        val byKey = results.associateBy { it.key }
        // A thing both found is the phone's row, with the words the daemon found it by under it, as on desktop.
        assertEquals("Plan for Q3", byKey.getValue("document:d2").title)
        assertEquals("Plan the quarter", byKey.getValue("document:d2").detail)
        assertTrue(byKey.getValue("document:d2").local is AgentSearchResult.Home)
        // Otherwise the line says what it is: the phone's task a task, its document a document.
        assertEquals("Task", byKey.getValue("agent:at3").detail)
        assertEquals("Document", byKey.getValue("document:d1").detail)
        assertEquals(null, byKey.getValue("agent:at3").drawn)
        assertEquals("The launch plan moves", byKey.getValue("vault_file:f1").detail)
        assertEquals("Launch plan", searchHitTitle(SearchHit.VaultFile("vault_file:f2", 1, "v1", "f2", "Launch plan.artifact", "/Apps/Launch plan.artifact", kind = "artifact")))
        // Home's own pages draw as home draws them.
        assertTrue(agentSearchResults(feed, "artif", label, words, emptyList(), emptyList()).filterIsInstance<AgentSearchResult.Found>().single().drawn is AgentSearchResult.Home)
        // What the daemon found only for an earlier query isn't the caller's to fuse in: nothing else changes.
        assertEquals(found("plan", sources), agentSearchResults(feed, "plan", label, words, emptyList(), emptyList(), sources).map { it.key })
    }

    @Test
    fun aMessageIsFoundUnderItsConversation() {
        val at3 = feed.rows.filterIsInstance<AgentFeedRow.Conversation>().single { it.agentId == "at3" }
        val remote = SearchAnswer(
            "launch",
            listOf(
                SearchHit.Message("message:m1", 1, "at3", "m1", "user", "when is the   launch?", 1, "w9", null),
                SearchHit.Message("message:m2", 2, "gone", "m2", "agent", snippet = "launch day", createdAt = 2, workspaceId = "w9"),
                // In no workspace, as desktop leaves it out.
                SearchHit.Message("message:m3", 3, "at3", "m3", snippet = "launch", workspaceId = null),
            ),
        )
        val found = agentSearchResults(feed, "launch", label, words, emptyList(), emptyList(), remote = remote).filterIsInstance<AgentSearchResult.Found>().associateBy { it.key }
        // Its words are its title, its conversation as home names it and its day under them (desktop's `remoteRow`).
        assertEquals("when is the launch?", found.getValue("message:m1").title)
        assertEquals("${label(at3)} · day 1", found.getValue("message:m1").detail)
        assertEquals(null, found.getValue("message:m1").drawn)
        // One the phone doesn't hold is a chat; an agent's says so.
        assertEquals("Chat · Agent · day 2", found.getValue("message:m2").detail)
        assertFalse("message:m3" in found)
    }

    @Test
    fun theDaemonsResultsSayWhatAndWhereTheyAreAsOnDesktop() {
        val remote = SearchAnswer(
            "launch",
            listOf(
                SearchHit.VaultFolder("vault_folder:f3", 1, "c1", "f3", "Old", "/Apps/Old.artifact"),
                SearchHit.Todo("todo:t1", 2, "l1", "t1", "Book the launch venue", "completed"),
                SearchHit.CalendarEvent("calendar_event:e1", 3, "c1", "e1", "Launch", allDay = true, start = 5),
                SearchHit.CalendarEvent("calendar_event:e2", 4, "c1", "e2", "Launch party", start = 6, match = "content", snippet = "Bring the banner"),
                SearchHit.Surface("surface:x1", 5, "x1", "whiteboard", "Launch sketches"),
                SearchHit.Agent("agent:ap9", 6, "ap9", "Launch chat", "chat", workspaceId = "p1", projectId = "p1"),
                SearchHit.Artifact("artifact:r1", 7, "r1", "Launch site", "html"),
                // What the phone has nowhere to open.
                SearchHit.Agent("agent:old", 8, "old", "Launch retro", "task", archived = true, workspaceId = "w"),
                SearchHit.Project("project:p1", 9, "p1", "launch"),
                SearchHit.Workspace("workspace:w1", 10, "w1", "p1", "launch-fix"),
            ),
        )
        val found = agentSearchResults(feed, "launch", label, words, emptyList(), emptyList(), sources, remote).filterIsInstance<AgentSearchResult.Found>()
        val lines = found.filter { it.hit != null && it.local == null }.associate { it.key to (it.title to it.detail) }
        assertEquals("Old" to "Team · /Apps/Old", lines["vault_folder:f3"])
        assertEquals("Book the launch venue" to "Done · Planning", lines["todo:t1"])
        assertEquals("Launch" to "Team · day 5 utc", lines["calendar_event:e1"])
        assertEquals("Launch party" to "Bring the banner", lines["calendar_event:e2"])
        assertEquals("Launch sketches" to "Shared", lines["surface:x1"])
        assertEquals("Launch chat" to "Chat · happy", lines["agent:ap9"])
        assertEquals("Launch site" to "Web page", lines["artifact:r1"])
        assertEquals(emptyList<String>(), found.map { it.key }.filter { it in setOf("agent:old", "project:p1", "workspace:w1") })
    }

    @Test
    fun eachSectionStandsWhereItsBestAnswerPutsIt() {
        val setting = AgentSearchEntry("theme", "Theme", com.slopus.happy.ui.components.Ionicon.SettingsOutline) {}
        val held = AgentSearchSources(surfaces = listOf(AgentSearchSources.Surface(AgentFeedRow.Surface("z2", "Rethemed notes", "document"), joined = true)))
        // "theme" is inside a word of a title the phone holds, but starts the setting: the settings come first, as on desktop.
        assertEquals(listOf("heading-Settings", "entry-theme", "document:z2"), agentSearchResults(feed, "theme", label, words, emptyList(), listOf(setting), held).map { it.key })
        // Once the daemon has answered with anything, what was found comes first: nothing has been chosen yet.
        val answered = SearchAnswer("theme", listOf(SearchHit.Document("document:z1", 1, "z1", "Themes", match = "name")))
        assertEquals(
            listOf("document:z1", "document:z2", "heading-Settings", "entry-theme"),
            agentSearchResults(feed, "theme", label, words, emptyList(), listOf(setting), held, answered).map { it.key },
        )
    }

    @Test
    fun theCardHoldsTwelveAndEachSectionSix() {
        val many = AgentSearchSources(artifacts = (0 until 15).map { com.slopus.happy.artifacts.ArtifactRef("a$it", 1, "html", "Chart $it", followsLatest = true) })
        val found = agentSearchResults(feed, "chart", label, words, emptyList(), emptyList(), many)
        assertEquals((0 until 12).map { "artifact:a$it" }, found.map { it.key })
        val places = found.filterIsInstance<AgentSearchResult.Found>().map { it.place }
        assertTrue(places.first().first && places.last().last && places.drop(1).dropLast(1).none { it.first || it.last })
        val entries = (0 until 9).map { AgentSearchEntry("e$it", "Chart setting $it", com.slopus.happy.ui.components.Ionicon.SettingsOutline) {} }
        val settings = agentSearchResults(feed, "chart setting", label, words, emptyList(), entries)
        assertEquals(listOf("heading-Settings") + (0 until 6).map { "entry-e$it" }, settings.map { it.key })
    }

    @Test
    fun theSourcesAreTheCatalogsSurfacesAndWhatThePhoneKept() {
        val bootstrap = Wire.bootstrap(
            surfaces = listOf(
                Wire.surface("s1", "Groceries", "todo"),
                Wire.surface("s2", "Theirs", "document", mapOf("u2" to "1")),
                Wire.surface("s3", "Old", "document", archived = true),
                Wire.surface("s4", "A bot", "bot"),
                Wire.surface("s5", "Leaving", "document"),
            ),
        )
        val current = catalog(bootstrap)
        val kept = mapOf(
            com.slopus.happy.todos.TodoLibrary.resource("s1") to kotlinx.serialization.json.buildJsonObject {
                put("todos", kotlinx.serialization.json.JsonArray(listOf(
                    com.slopus.happy.todos.TodoItem("t1", "s1", "Milk"),
                    com.slopus.happy.todos.TodoItem("t2", "s1", "Eggs", com.slopus.happy.todos.TodoItem.Status.Completed),
                    com.slopus.happy.todos.TodoItem("t3", "s1", "# Dairy"),
                    com.slopus.happy.todos.TodoItem("t4", "s1", "Cheese", com.slopus.happy.todos.TodoItem.Status.Deleted),
                ).map { it.json() }))
            },
            com.slopus.happy.artifacts.ArtifactCatalogFeed.RESOURCE to kotlinx.serialization.json.buildJsonObject {
                put("artifacts", kotlinx.serialization.json.buildJsonArray {
                    add(kotlinx.serialization.json.buildJsonObject { put("id", kotlinx.serialization.json.JsonPrimitive("a1")); put("title", kotlinx.serialization.json.JsonPrimitive("Chart")); put("type", kotlinx.serialization.json.JsonPrimitive("image")) })
                })
            },
        )
        val read = AgentSearchSources.read(current, AgentFeed.derive(current, leaving = setOf("s5")), kept::get)
        assertEquals(listOf("s1" to true, "s2" to false), read.surfaces.map { it.row.id to it.joined }.sortedBy { it.first })
        assertEquals(listOf("Milk"), read.todos.map { it.text })
        assertEquals("s1", read.todos.single().list.id)
        assertEquals(listOf("a1"), read.artifacts.map { it.id })
        val create = com.slopus.happy.todos.TodoOp("s1", "local", com.slopus.happy.todos.TodoOp.Kind.Create("Bread", "1"), 5.0)
        val complete = com.slopus.happy.todos.TodoOp("s1", "t1", com.slopus.happy.todos.TodoOp.Kind.Status(com.slopus.happy.todos.TodoItem.Status.Completed), 6.0)
        val pending = listOf(create, complete).mapIndexed { i, op -> com.slopus.happy.agent.Intent("i$i", op.intentKind, op.todoId, op.value, i.toLong()) }
        val offline = AgentSearchSources.read(current, AgentFeed.derive(current), kept::get, pending)
        assertEquals("search sees the same optimistic list as the editor", listOf("Bread"), offline.todos.map { it.text })
    }

    @Test
    fun aPullClosesFarOrFlung() {
        assertTrue(AgentSearch.pullCloses(100.dp, 0.dp))
        assertTrue(AgentSearch.pullCloses(24.dp, 700.dp))
        assertFalse(AgentSearch.pullCloses(99.dp, 699.dp))
        assertFalse(AgentSearch.pullCloses(23.dp, 2000.dp))
    }
}
