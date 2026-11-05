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
            is AgentFeedRow.Feed -> "Activity"
            AgentFeedRow.Todos -> "Todos"
            is AgentFeedRow.Section -> null
        }
    }

    private val words = AgentSearchWords(
        actions = "Quick actions",
        settings = "Settings",
        documents = "Documents",
        todos = "Todos",
        artifacts = "Artifacts",
        shared = "Shared",
        surfaceType = { if (it == "todo") "Todo list" else it.replaceFirstChar(Char::uppercase) },
        artifactType = { if (it == "html") "Web page" else it },
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
        val found = agentSearchResults(feed, "re", label, words, listOf(action), listOf(setting))
        val home = found.takeWhile { it is AgentSearchResult.Home }.map { (it as AgentSearchResult.Home).item }
        assertTrue(home.first().first && home.drop(1).none { it.first })
        assertTrue(home.last().last && home.dropLast(1).none { it.last })
        assertEquals(
            listOf("heading-Settings", "entry-prefs"),
            found.drop(home.size).map { it.key },
        )
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
    fun aQueryFindsDocumentsTodosArtifactsAndSharedSurfacesAfterHomesRows() {
        val found = agentSearchResults(feed, "plan", label, words, emptyList(), emptyList(), sources).map { it.key }
        assertEquals(
            listOf(
                // Home's rows: the joined document is here, and not again below.
                "surface-s1", "agent-at3",
                // Equally good, joined before not; the list before its todos.
                "heading-Documents", "surface-d1", "surface-d2",
                "heading-Todos", "surface-l1", "todo-todo1",
                "heading-Artifacts", "artifact-a1",
            ),
            found,
        )
        // The kind's name finds a Surface; an artifact by its type too.
        assertEquals(listOf("heading-Shared", "surface-c1"), agentSearchResults(feed, "calendar", label, words, emptyList(), emptyList(), sources).map { it.key })
        assertEquals(listOf("heading-Artifacts", "artifact-a1"), agentSearchResults(feed, "web page", label, words, emptyList(), emptyList(), sources).map { it.key })
        // Nothing typed: none of it.
        assertTrue(agentSearchResults(feed, "", label, words, emptyList(), emptyList(), sources).all { it is AgentSearchResult.Home })
    }

    @Test
    fun eachSectionShowsSix() {
        val many = AgentSearchSources(artifacts = (0 until 9).map { com.slopus.happy.artifacts.ArtifactRef("a$it", 1, "html", "Chart $it", followsLatest = true) })
        val found = agentSearchResults(feed, "chart", label, words, emptyList(), emptyList(), many)
        assertEquals(listOf("heading-Artifacts") + (0 until 6).map { "artifact-a$it" }, found.map { it.key })
        val places = found.filterIsInstance<AgentSearchResult.Artifact>().map { it.place }
        assertTrue(places.first().first && places.last().last && places.drop(1).dropLast(1).none { it.first || it.last })
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
