package com.slopus.happy.ui.connection

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import androidx.compose.ui.unit.height
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** An agent connection's home: strict rows, subtasks, live updates, search over home. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentHomeLayoutTest {
    @get:Rule val rule = createComposeRule()

    private val opened = mutableListOf<String>()
    private var composed = 0
    private var settings = 0
    private val actions = AgentHomeActions(
        onOpenConversation = { opened += it },
        onCompose = { composed++ },
        onSettings = { settings++ },
        onAppearance = {},
        onSwitchAccount = {},
        onAdd = {},
    )
    private val accounts = AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true)))

    companion object {
        const val NOW = 1_755_400_000_000L

        fun catalog(bootstrap: JsonObject) =
            AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))

        /** A fixture: a bot with a subtask, three tasks, and a project with a worktree. */
        val sample = Wire.bootstrap(
            bots = listOf(
                Wire.bot("b1", "Happy", Wire.agent("ab1", updatedAt = NOW - 20 * 60_000, subtasks = listOf(Wire.agent("as1", title = "Review the PR", subtask = true, parent = "ab1", updatedAt = NOW - 5 * 60_000)))),
                Wire.bot("b2", "Research", Wire.agent("ab2", updatedAt = NOW - 3 * 3_600_000), orderKey = "2"),
            ),
            tasks = listOf(
                Wire.task("t1", "Fix login redirect", Wire.agent("at1", status = "running_tools", updatedAt = NOW - 60_000)),
                Wire.task("t2", "Write release notes", Wire.agent("at2", unread = true)),
                Wire.task("t3", "Plan the sprint", Wire.agent("at3", question = true)),
            ),
            memberships = listOf(Wire.membership("t1", "1"), Wire.membership("t2", "2"), Wire.membership("t3", "3")),
            projects = listOf(Wire.project("p1", "happy", listOf(Wire.agent("ap1", title = "Android home feed", updatedAt = NOW - 2 * 86_400_000)))),
            workspaces = listOf(Wire.workspace("w1", "p1", "fix-scroll", listOf(Wire.agent("aw1", title = "Scroll jumps", updatedAt = NOW - 9 * 86_400_000)))),
        )

        fun big(count: Int) = Wire.bootstrap(
            tasks = (0 until count).map { Wire.task("t$it", "Task number $it", Wire.agent("at$it")) },
            memberships = (0 until count).map { Wire.membership("t$it", "%04d".format(it)) },
        )
    }

    private fun feed(bootstrap: JsonObject = sample) = AgentFeed.derive(catalog(bootstrap))

    private fun show(feed: AgentFeed, status: AgentLinkStatus = AgentLinkStatus.Connected, dark: Boolean = false) =
        rule.setHappyContent(dark) { AgentHomeScreen("Studio", feed, status, accounts, actions, now = 1_755_400_000_000L) }

    @Test
    fun rowsHaveTheirKindsHeightAndNoComposer() {
        show(feed())
        val section = rule.node(AgentHomeTags.row("section-bots")).bounds
        assertDp("section height", 46, section.height)
        val bot = rule.node(AgentHomeTags.row("agent-ab1")).bounds
        assertBox("bot row", bot, 0.dp, section.bottom, 411.dp, 60.dp)
        rule.node(AgentHomeTags.row("agent-at1")).assertExists()
        assertDp("task row height", 60, rule.node(AgentHomeTags.row("agent-at1")).bounds.height)
        // No text field anywhere on home.
        rule.onAllNodesWithTag(AgentSearchTags.FIELD, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun theTopBarHasTheMenuAndNameLeftAndSearchSettingsComposeRight() {
        show(feed())
        val bar = rule.node(AgentHomeTags.BAR).bounds
        val menu = rule.node(AccountMenuTags.BUTTON).bounds
        assertTrue(menu.left < 30.dp)
        rule.onNodeWithTag(AgentHomeTags.BAR, useUnmergedTree = true).assertExists()
        val search = rule.node(AgentHomeTags.SEARCH).bounds
        val settingsButton = rule.node(AgentHomeTags.SETTINGS).bounds
        val compose = rule.node(AgentHomeTags.COMPOSE).bounds
        assertTrue(search.right <= settingsButton.left + 0.5.dp && settingsButton.right <= compose.left + 0.5.dp)
        // Every bar control takes a full 48 touch (Compose widens a smaller one's), and is drawn whole inside the bar.
        val tags = mapOf("menu" to AccountMenuTags.BUTTON, "search" to AgentHomeTags.SEARCH, "settings" to AgentHomeTags.SETTINGS, "compose" to AgentHomeTags.COMPOSE)
        for ((label, rect) in listOf("menu" to menu, "search" to search, "settings" to settingsButton, "compose" to compose)) {
            val touch = rule.node(tags.getValue(label)).fetchSemanticsNode().touchBoundsInRoot
            val density = rule.density.density
            assertTrue("$label takes a 48 touch: $touch", touch.width / density >= 47.5f && touch.height / density >= 47.5f)
            assertTrue("$label is inside the bar", rect.left >= bar.left && rect.right <= bar.right && rect.top >= bar.top - 0.5.dp && rect.bottom <= bar.bottom + 0.5.dp)
        }
        assertTrue("compose ends at the bar's end inset", bar.right - compose.right <= 16.dp)
        rule.node(AgentHomeTags.COMPOSE).performClick()
        rule.node(AgentHomeTags.SETTINGS).performClick()
        assertEquals(1, composed)
        assertEquals(1, settings)
    }

    @Test
    fun theBarAndPageAreTheChatsSurface() {
        var surface = 0
        rule.setHappyContent(dark = true) {
            surface = com.slopus.happy.ui.theme.HappyTheme.colors.surface.toArgb()
            AgentHomeScreen("Studio", feed(), AgentLinkStatus.Connected, accounts, actions, now = 1L)
        }
        val bar = rule.node(AgentHomeTags.BAR).captureToImage().toPixelMap()
        assertEquals(surface, bar[bar.width / 2, 4].toArgb())
        val list = rule.node(AgentHomeTags.LIST).captureToImage().toPixelMap()
        assertEquals(surface, list[list.width / 2, list.height - 4].toArgb())
    }

    @Test
    fun idleUpdatesMoveNoRow() {
        var current by mutableStateOf(feed())
        rule.setHappyContent { AgentHomeScreen("Studio", current, AgentLinkStatus.Connected, accounts, actions, now = 1L) }
        val before = listOf("agent-ab2", "agent-at1", "agent-at2", "agent-ap1").associateWith { rule.node(AgentHomeTags.row(it)).bounds }
        // Work starts and stops, results come in, a question is asked, a title is generated.
        var catalog = catalog(sample)
        catalog = catalog.apply(Wire.event("c1", "agent.updated", Wire.updated("agentId", "at1", "01", "02", buildJsonObject { put("status", "idle") }))).catalog
        catalog = catalog.apply(Wire.event("c2", "agent.updated", Wire.updated("agentId", "ab2", "01", "02", buildJsonObject { put("status", "thinking"); put("pendingQuestionId", "q") }))).catalog
        catalog = catalog.apply(Wire.event("c3", "agent.updated", Wire.updated("agentId", "ap1", "01", "02", buildJsonObject { put("title", "A much longer generated title that will not fit on one line at all") }))).catalog
        current = AgentFeed.derive(catalog)
        rule.waitForIdle()
        before.forEach { (key, rect) -> assertEquals(key, rect, rule.node(AgentHomeTags.row(key)).bounds) }
    }

    @Test
    fun subtasksShowAndHideUnderTheirParent() {
        show(feed())
        rule.onAllNodesWithTag(AgentHomeTags.row("agent-as1"), useUnmergedTree = true).assertCountEquals(0)
        val research = rule.node(AgentHomeTags.row("agent-ab2")).bounds
        rule.node(AgentHomeTags.toggle("ab1")).performClick()
        rule.waitForIdle()
        val sub = rule.node(AgentHomeTags.row("agent-as1")).bounds
        val parent = rule.node(AgentHomeTags.row("agent-ab1")).bounds
        assertDp("subtask under its parent", parent.bottom, sub.top)
        assertDp("subtask row height", 60, sub.height)
        val avatar = rule.onAllNodesWithTag(AgentHomeTags.ROW_AVATAR, useUnmergedTree = true)[1].bounds
        assertBox("subtask avatar", avatar, 16.dp + 28.dp, sub.top + 14.dp, 32.dp, 32.dp)
        assertDp("the next bot moves down a row", research.top + 60.dp, rule.node(AgentHomeTags.row("agent-ab2")).bounds.top)
        // Rapid toggling settles where the last tap left it.
        repeat(5) { rule.node(AgentHomeTags.toggle("ab1")).performClick() }
        rule.waitForIdle()
        rule.onAllNodesWithTag(AgentHomeTags.row("agent-as1"), useUnmergedTree = true).assertCountEquals(0)
        assertEquals(research, rule.node(AgentHomeTags.row("agent-ab2")).bounds)
    }

    @Test
    fun aRowAddedAboveKeepsTheReaderWhereTheyAre() {
        var current by mutableStateOf(feed(big(60)))
        rule.setHappyContent { AgentHomeScreen("Studio", current, AgentLinkStatus.Connected, accounts, actions, now = 1L) }
        rule.node(AgentHomeTags.LIST).performScrollToIndex(30)
        rule.waitForIdle()
        val anchor = rule.onAllNodesWithTag(AgentHomeTags.LIST, useUnmergedTree = true)[0]
        val before = rule.node(AgentHomeTags.row("agent-at30")).bounds
        // A new task joins at the top, and one far above changes.
        val catalog = catalog(big(60))
            .withTask(Wire.task("tn", "Brand new", Wire.agent("atn")))
            .apply(Wire.event("c1", "agent.updated", Wire.updated("agentId", "at2", "01", "02", buildJsonObject { put("status", "thinking") }))).catalog
        current = AgentFeed.derive(catalog)
        rule.waitForIdle()
        anchor.assertExists()
        assertEquals(before, rule.node(AgentHomeTags.row("agent-at30")).bounds)
    }

    @Test
    fun searchLiesOverHomeAndLeavesItWhereItWas() {
        show(feed(big(40)))
        rule.node(AgentHomeTags.LIST).performScrollToIndex(20)
        rule.waitForIdle()
        val row = rule.node(AgentHomeTags.row("agent-at20")).bounds
        val bar = rule.node(AgentHomeTags.BAR).bounds

        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.waitForIdle()
        assertEquals(bar, rule.node(AgentHomeTags.BAR).bounds)
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)
        rule.onAllNodesWithTag(AgentSearchTags.RESULTS, useUnmergedTree = true).assertCountEquals(0)

        rule.node(AgentSearchTags.FIELD).performTextInput("number 3")
        rule.waitForIdle()
        val panel = rule.node(AgentSearchTags.RESULTS).bounds
        assertDp("the panel starts under the bar", bar.bottom, panel.top)
        rule.node(AgentSearchTags.result("agent-at3")).assertExists()
        // Home stays composed under the panel, rows and scroll as they were.
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)

        rule.node(AgentSearchTags.FIELD).performTextReplacement("zzzz")
        rule.waitForIdle()
        rule.node(AgentSearchTags.NO_RESULTS).assertExists()
        assertTrue("nothing found is one line, not a page", rule.node(AgentSearchTags.RESULTS).bounds.height < 80.dp)
        // A tap on dimmed home ends the search where it was.
        rule.node(AgentSearchTags.SCRIM).performClick()
        rule.waitForIdle()
        rule.onAllNodesWithTag(AgentSearchTags.FIELD, useUnmergedTree = true).assertCountEquals(0)
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)
        rule.node(AgentHomeTags.SEARCH).performClick()

        rule.node(AgentSearchTags.FIELD).performTextReplacement("number 3")
        rule.node(AgentSearchTags.result("agent-at3")).performClick()
        rule.waitForIdle()
        assertEquals(listOf("at3"), opened)
        rule.onAllNodesWithTag(AgentSearchTags.RESULTS, useUnmergedTree = true).assertCountEquals(0)
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)
    }

    @Test
    fun searchFindsActionsAndSettings() {
        show(feed())
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("appear")
        rule.waitForIdle()
        rule.node(AgentSearchTags.result("entry-appearance")).assertExists()
        rule.node(AgentSearchTags.FIELD).performTextReplacement("new")
        rule.node(AgentSearchTags.result("entry-new-chat")).performClick()
        assertEquals(1, composed)
        rule.node(AgentSearchTags.FIELD).performTextReplacement("Settings")
        rule.node(AgentSearchTags.result("entry-settings")).performClick()
        assertEquals(1, settings)
        // "Remove connection" only opens settings, where removing asks first.
        rule.node(AgentSearchTags.FIELD).performTextReplacement("remove")
        rule.node(AgentSearchTags.result("entry-remove")).performClick()
        assertEquals(2, settings)
    }

    @Test
    fun theLinkDroppingAndComingBackMovesNothing() {
        val rows = feed()
        var status by mutableStateOf(AgentLinkStatus.Connected)
        var syncing by mutableStateOf(false)
        rule.setHappyContent { AgentHomeScreen("Studio", rows, status, accounts, actions, now = NOW, syncing = syncing) }
        val bar = rule.node(AgentHomeTags.BAR).bounds
        val title = rule.node(AgentHomeTags.TITLE).bounds
        val first = rule.node(AgentHomeTags.row("section-bots")).bounds
        fun stillPut(at: String) {
            assertEquals("bar, $at", bar, rule.node(AgentHomeTags.BAR).bounds)
            assertEquals("title, $at", title, rule.node(AgentHomeTags.TITLE).bounds)
            assertEquals("first row, $at", first, rule.node(AgentHomeTags.row("section-bots")).bounds)
        }
        val flips = listOf(
            AgentLinkStatus.Connecting to false, AgentLinkStatus.Connected to true,
            AgentLinkStatus.Connected to false, AgentLinkStatus.Offline to false,
            AgentLinkStatus.Connecting to false, AgentLinkStatus.Connected to true,
            AgentLinkStatus.Connected to false, AgentLinkStatus.Connected to false,
        )
        for ((next, catchingUp) in flips) {
            // Mid-fade, with the old line and the new one both drawn, and once it has settled.
            rule.mainClock.autoAdvance = false
            status = next
            syncing = catchingUp
            Snapshot.sendApplyNotifications()
            rule.mainClock.advanceTimeByFrame()
            rule.mainClock.advanceTimeBy(64)
            assertTrue("the line is on its way, $next", rule.onAllNodesWithTag(AgentHomeTags.STATUS, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
            stillPut("fading to $next")
            rule.mainClock.autoAdvance = true
            rule.waitForIdle()
            stillPut("settled on $next")
            rule.onAllNodesWithTag(AgentHomeTags.STATUS, useUnmergedTree = true)
                .assertCountEquals(1)
            val label = when (next) {
                AgentLinkStatus.Connected -> if (catchingUp) "syncing" else "online"
                AgentLinkStatus.Connecting -> "connecting"
                else -> "offline"
            }
            rule.onNodeWithText(label, useUnmergedTree = true).assertExists()
        }
    }

    @Test
    fun loadingOfflineAndEmptyHaveTheirOwnPages() {
        var status by mutableStateOf(AgentLinkStatus.Connecting)
        var current by mutableStateOf(AgentFeed.Empty)
        rule.setHappyContent { AgentHomeScreen("Studio", current, status, accounts, actions) }
        rule.node(AgentHomeTags.SPINNER).assertExists()
        rule.node(AgentHomeTags.STATUS).assertExists()
        status = AgentLinkStatus.Offline
        rule.waitForIdle()
        rule.node(AgentHomeTags.OFFLINE).assertExists()
        // Offline with a cached home: the rows, and the state under the name.
        current = feed()
        rule.waitForIdle()
        rule.node(AgentHomeTags.row("agent-ab1")).assertExists()
        rule.node(AgentHomeTags.STATUS).assertExists()
        status = AgentLinkStatus.Revoked
        rule.waitForIdle()
        rule.node(AgentHomeTags.BANNER).assertExists()
        status = AgentLinkStatus.Connected
        current = feed(Wire.bootstrap())
        rule.waitForIdle()
        rule.node(AgentHomeTags.EMPTY).assertExists()
        rule.onAllNodesWithTag(AgentHomeTags.STATUS, useUnmergedTree = true).assertCountEquals(1)
    }

    @Test
    fun rowsGrowWithTheFontButStayFixed() {
        var row = 0.dp
        var section = 0.dp
        rule.setHappyContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                row = AgentHomeSpec.conversationHeight()
                section = AgentHomeSpec.sectionHeight()
                AgentHomeScreen("Studio", feed(), AgentLinkStatus.Connected, accounts, actions, now = 1L)
            }
        }
        // The lines scale as Android 14 scales them (non-linearly); the paddings don't.
        assertTrue("taller than at 1.0", row > 70.dp)
        assertDp("conversation row", row, rule.node(AgentHomeTags.row("agent-ab1")).bounds.height)
        assertDp("section row", section, rule.node(AgentHomeTags.row("section-bots")).bounds.height)
    }
}
