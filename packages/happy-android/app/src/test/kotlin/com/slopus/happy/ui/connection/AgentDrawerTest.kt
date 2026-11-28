package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.with
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.tablet.MainPanelKey
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The phone's drawer: what it lists and in what order, what it lights, and home without its places. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentDrawerTest {
    @get:Rule val rule = createComposeRule()

    private val bootstrap = Wire.bootstrap(
        surfaces = listOf(
            Wire.surface("cal", "Week", "calendar", mapOf(Wire.USER to "1")),
            Wire.surface("doc", "Plan", "document", mapOf(Wire.USER to "2")),
            Wire.surface("list", "Groceries", "todo", mapOf(Wire.USER to "3")),
        ),
        bots = listOf(
            Wire.bot("b1", "Happy", Wire.agent("ab1")),
            Wire.bot("bs", "Chief", Wire.agent("abs"), orderKey = "0").with("kind", "shared"),
        ),
        tasks = listOf(Wire.task("t1", "Fix login", Wire.agent("at1"))),
        memberships = listOf(Wire.membership("t1", "1")),
        projects = listOf(Wire.project("p1", "happy", listOf(Wire.agent("ap1", title = "Android home")))),
    )
    private val feed = AgentFeed.derive(AgentHomeLayoutTest.catalog(bootstrap), feedUnread = 3, plugins = true, pipelines = true)

    @Test
    fun theDrawerListsHomesPlacesInItsOrderThenTheOtherSurfaces() {
        val items = AgentDrawerItems.of(feed)
        assertEquals(
            listOf(MainPanelKey.FEED, MainPanelKey.ARTIFACTS, MainPanelKey.DOCUMENTS, MainPanelKey.TODOS, MainPanelKey.PLUGINS, MainPanelKey.PIPELINES),
            items.places.map { it.panelKey() },
        )
        // Documents and todo lists are under their rows; the shared bot stays on home.
        assertEquals(listOf("cal"), items.surfaces.map { it.id })
    }

    @Test
    fun theStacksRootLightsItsItemAndAnythingFromHomeLightsHome() {
        fun selected(root: String?) = AgentDrawerItems.selected(root, feed)
        assertEquals(AgentDrawerItems.HOME, selected(null))
        assertEquals(MainPanelKey.DOCUMENTS, selected(MainPanelKey.DOCUMENTS))
        assertEquals(MainPanelKey.surface("cal"), selected(MainPanelKey.surface("cal")))
        // A document or todo list opened straight (search, a link) is in its section.
        assertEquals(MainPanelKey.DOCUMENTS, selected(MainPanelKey.surface("doc")))
        assertEquals(MainPanelKey.TODOS, selected(MainPanelKey.surface("list")))
        assertEquals(MainPanelKey.SETTINGS, selected(MainPanelKey.SETTINGS))
        assertEquals(AgentDrawerItems.HOME, selected(MainPanelKey.conversation("at1")))
    }

    @Test
    fun homeWithTheDrawerIsTheSharedBotBotsAndTasksAlone() {
        val keys = feed.withoutPlaces().rows.map { it.key }
        assertEquals(listOf("section-places", "agent-abs", "section-bots", "agent-ab1", "section-tasks", "agent-at1"), keys)
        // With no shared bot, the places' heading goes too.
        val plain = AgentFeed.derive(AgentHomeLayoutTest.catalog(Wire.bootstrap(bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1"))))))
        assertEquals(listOf("section-bots", "agent-ab1"), plain.withoutPlaces().rows.map { it.key })
    }

    @Test
    fun itDrawsTheAccountItemsAndSettingsAndPicksThem() {
        val picked = mutableListOf<String>()
        val accounts = AccountMenu(listOf(AccountMenuEntry("c1", "Studio", agent = true, active = true), AccountMenuEntry("c2", "Laptop", agent = true, active = false)))
        rule.setHappyContent {
            AgentDrawer(
                name = "Studio", accounts = accounts, items = AgentDrawerItems.of(feed), selected = MainPanelKey.DOCUMENTS,
                onSwitchAccount = { picked += "switch:$it" }, onAdd = {}, onCloud = null,
                onHome = { picked += "home" }, onPlace = { picked += it.panelKey().orEmpty() }, onSettings = { picked += "settings" },
            )
        }
        rule.onNodeWithText("Studio").assertExists()
        rule.node(AgentDrawerTags.item(MainPanelKey.DOCUMENTS)).assertIsSelected()
        rule.node(AgentDrawerTags.item(AgentDrawerItems.HOME)).assertIsNotSelected()
        rule.onNodeWithText("3").assertExists()
        rule.node(AgentDrawerTags.item(AgentDrawerItems.HOME)).performClick()
        rule.node(AgentDrawerTags.item(MainPanelKey.TODOS)).performClick()
        rule.node(AgentDrawerTags.item(MainPanelKey.surface("cal"))).performClick()
        rule.node(AgentDrawerTags.SETTINGS).performClick()
        rule.node(AgentDrawerTags.HEADER).performClick()
        rule.node(AccountMenuTags.entry("c2")).performClick()
        assertEquals(listOf("home", MainPanelKey.TODOS, MainPanelKey.surface("cal"), "settings", "switch:c2"), picked)
    }
}
