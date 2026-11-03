package com.slopus.happy.ui.tablet

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import androidx.navigation.NavHostController
import androidx.navigation.NavGraph
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.files.ChangesTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeDockTags
import com.slopus.happy.ui.home.NewSessionTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.session.SessionInfoTags
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import com.slopus.happy.ui.layout.ContentTokens
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val TABLET = "w1280dp-h800dp-xhdpi"
private const val TABLET_WIDTH = 1280

/**
 * happy-ios docs/IPAD.md on a Happy CLI account: from 840 wide (Material
 * expanded) home itself is the sidebar (30% of the window, held to
 * 340–360) beside the main panel, whose root the sidebar replaces at once
 * and whose empty state is the owl; the root's back is the sidebar's
 * toggle. Below 840 it is the phone's one stack, which keeps a book
 * foldable one pane both ways (750 and 832).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = TABLET)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabletShellTest {
    @get:Rule
    val rule = createComposeRule()

    private val server = FakeHappyServer().start()
    private lateinit var graph: AppGraph
    private lateinit var nav: NavHostController

    @After
    fun tearDown() = server.close()

    private fun session(id: String, updatedAt: Long) = server.addSession(
        id,
        updatedAt = updatedAt,
        metadata = buildJsonObject {
            put("path", "/repo/$id")
            put("host", "devbox")
            put("machineId", "m1")
            put("summary", buildJsonObject { put("text", "Chat $id"); put("updatedAt", 1) })
        },
    )

    private fun signIn(machine: Boolean = true) {
        if (machine) server.addMachine("m1")
        graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = server.url,
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        runBlocking { graph.auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))) }
        rule.setContent { HappyApp(graph, onNavigationReady = { nav = it }) }
    }

    private fun waitFor(tag: String) = rule.waitUntilAtLeastOneExists(hasTestTag(tag), 5_000)

    private fun row(title: String) = rule.onNode(hasTestTag(FlatRowTags.ROW) and hasAnyDescendant(hasText(title)), useUnmergedTree = true)

    /** The screens on the stack, by route. */
    private fun stack(): List<String> = nav.currentBackStack.value.filter { it.destination !is NavGraph }.map { entry ->
        val d = entry.destination
        when {
            d.hasRoute<HomeRoute>() -> "home"
            d.hasRoute<SessionRoute>() -> "chat"
            d.hasRoute<SessionInfoRoute>() -> "info"
            else -> d.route.orEmpty()
        }
    }

    private fun count(tag: String) = rule.onAllNodes(hasTestTag(tag) and com.slopus.happy.ui.isOnActivePage, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test
    fun homeIsTheSidebarBesideTheOwl() {
        session("a", 200)
        session("b", 100)
        signIn()
        waitFor(FlatRowTags.ROW)
        val sidebar = rule.node(SidebarTags.SIDEBAR).bounds
        // floor(1280 * 0.3) = 384, held to 360.
        assertBox("sidebar", sidebar, 0.dp, 0.dp, 360.dp, sidebar.bottom)
        val detail = rule.node(TabletShellTags.DETAIL).bounds
        assertBox("detail", detail, 360.dp, 0.dp, (TABLET_WIDTH - 360).dp, detail.bottom)
        rule.node(MainPanelTags.PLACEHOLDER).assertExists()
        // The owl, 128, centred in the main panel.
        val owl = rule.onNode(hasTestTag(com.slopus.happy.ui.components.StateAnimationTags.ANIMATION) and hasAnyAncestor(hasTestTag(MainPanelTags.PLACEHOLDER)), useUnmergedTree = true).bounds
        assertBox("owl", owl, (360 + (TABLET_WIDTH - 360 - 128) / 2).dp, ((detail.bottom.value - 128) / 2).dp, 128.dp, 128.dp)
        // Home's one bar, in the sidebar: the account switcher and the name, no settings.
        rule.onAllNodesWithTag(AccountMenuTags.BUTTON, useUnmergedTree = true).assertCountEquals(1)
        assertTrue("the switcher is in the sidebar", rule.node(AccountMenuTags.BUTTON).bounds.right <= sidebar.right)
        assertEquals(0, count(HomeTags.SETTINGS))
        assertEquals(0, count(HomeTags.COMPOSE))
        rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true).assertCountEquals(2)
        // The foot: settings at the start, "New session" at the end.
        assertBox("settings", rule.node(SidebarTags.SETTINGS).bounds, 16.dp, sidebar.bottom - 64.dp, 48.dp, 48.dp)
        val compose = rule.node(SidebarTags.COMPOSE).bounds
        assertDp("compose 16 off the sidebar's end", 344, compose.right)
        rule.onNode(hasTestTag(SidebarTags.COMPOSE)).assertTextContains("New session")
        // The empty panel's toggle hides the sidebar.
        rule.onNode(hasTestTag(MainPanelTags.TOGGLE) and com.slopus.happy.ui.isOnActivePage).assertContentDescriptionEquals("Hide Sidebar")
    }

    @Test
    fun theSidebarReplacesTheMainPanelsRootAtOnce() {
        session("a", 200)
        session("b", 100)
        signIn()
        waitFor(FlatRowTags.ROW)
        row("Chat a").performClick()
        waitFor(ChatScreenTags.SCREEN)
        val chat = rule.node(ChatScreenTags.SCREEN).bounds
        assertDp("chat fills the main panel", 360, chat.left)
        assertDp("chat to the window's edge", TABLET_WIDTH, chat.right)
        row("Chat a").assertIsSelected()
        assertEquals(listOf("home", "chat"), stack())
        // The root's back is the sidebar's toggle.
        rule.onNode(hasTestTag(MainPanelTags.TOGGLE) and com.slopus.happy.ui.isOnActivePage).assertContentDescriptionEquals("Hide Sidebar")

        // Another row replaces it: no second chat on the stack.
        row("Chat b").performClick()
        rule.waitUntil(5_000) { runCatching { row("Chat b").assertIsSelected() }.isSuccess }
        assertEquals(listOf("home", "chat"), stack())
        row("Chat a").assertIsNotSelectedOrUnselectable()

        // Deeper in the panel, a screen keeps its own back; the open row brings the root back.
        rule.waitUntilAtLeastOneExists(hasTestTag(ChatScreenTags.TITLE_BUTTON) and hasClickAction(), 5_000)
        rule.node(ChatScreenTags.TITLE_BUTTON).performClick()
        waitFor(SessionInfoTags.CHANGES)
        assertEquals(listOf("home", "chat", "info"), stack())
        assertEquals("info's back is a back", 0, count(MainPanelTags.TOGGLE))
        row("Chat b").performClick()
        rule.waitUntil(5_000) { stack() == listOf("home", "chat") }
        rule.waitForIdle()
        rule.node(MainPanelTags.TOGGLE).assertExists()
    }

    // What opens over the empty panel from elsewhere (a link, Add's restore) keeps its back to the owl, as on iOS.
    @Test
    fun whatOpensOverTheEmptyPanelFromElsewhereKeepsItsBack() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.runOnIdle { nav.navigate(SessionRoute("a")) }
        waitFor(ChatScreenTags.SCREEN)
        rule.waitForIdle()
        assertEquals(0, count(MainPanelTags.TOGGLE))
        assertTrue("the chat has its back", rule.onAllNodes(androidx.compose.ui.test.hasContentDescription("Back") and com.slopus.happy.ui.isOnActivePage, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        // Opened from the sidebar, the same chat is the root again: the toggle.
        row("Chat a").performClick()
        rule.waitForIdle()
        rule.node(MainPanelTags.TOGGLE).assertExists()
    }

    // A session's sub-screens keep its row selected: the selection is the main panel's root.
    @Test
    fun aSessionsSubScreensKeepItsRowSelected() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.node(FlatRowTags.ROW).performClick()
        // The title is drawn before the session has loaded, and opens its info only after.
        rule.waitUntilAtLeastOneExists(hasTestTag(ChatScreenTags.TITLE_BUTTON) and hasClickAction(), 5_000)
        rule.node(ChatScreenTags.TITLE_BUTTON).performClick()
        waitFor(SessionInfoTags.CHANGES)
        rule.node(FlatRowTags.ROW).assertIsSelected()
        rule.node(SessionInfoTags.CHANGES).performClick()
        rule.waitUntil(5_000) {
            listOf(ChangesTags.SPINNER, ChangesTags.MESSAGE, ChangesTags.NOTICES).any {
                rule.onAllNodesWithTag(it, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
            }
        }
        rule.node(FlatRowTags.ROW).assertIsSelected()
    }

    /** "New session" at the sidebar's foot: the compose chat as the main panel's root, never the phone's dock. */
    @Test
    fun newSessionComposesInTheMainPanel() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.onAllNodesWithTag(HomeDockTags.DOCK, useUnmergedTree = true).assertCountEquals(0)
        rule.node(SidebarTags.COMPOSE).performClick()
        waitFor(ChatScreenTags.SCREEN)
        rule.onAllNodesWithTag(NewSessionTags.SCREEN, useUnmergedTree = true).assertCountEquals(0)
        assertDp("the compose chat in the main panel", 360, rule.node(ChatScreenTags.SCREEN).bounds.left)
        assertDp("to the window's edge", TABLET_WIDTH, rule.node(ChatScreenTags.SCREEN).bounds.right)

        rule.node(SidebarTags.COMPOSE).performClick()
        rule.waitForIdle()
        assertEquals(listOf("home", "chat"), stack())
        // Back from the root empties the panel: the owl again.
        rule.runOnIdle { nav.popBackStack() }
        waitFor(MainPanelTags.PLACEHOLDER)
        rule.onAllNodesWithTag(ChatScreenTags.SCREEN, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun theToggleHidesAndShowsTheSidebar() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.node(FlatRowTags.ROW).performClick()
        waitFor(ChatScreenTags.SCREEN)
        rule.node(MainPanelTags.TOGGLE).performClick()
        rule.waitUntil(5_000) { graph.localSettings.values.value.zenMode }
        rule.waitForIdle()
        assertEquals(0, count(SidebarTags.SIDEBAR))
        assertBox("detail", rule.node(TabletShellTags.DETAIL).bounds, 0.dp, 0.dp, TABLET_WIDTH.dp, rule.node(TabletShellTags.DETAIL).bounds.bottom)
        assertDp("the chat takes the window", 0, rule.node(ChatScreenTags.SCREEN).bounds.left)
        rule.onNode(hasTestTag(MainPanelTags.TOGGLE) and com.slopus.happy.ui.isOnActivePage).assertContentDescriptionEquals("Show Sidebar").performClick()
        rule.waitUntil(5_000) { !graph.localSettings.values.value.zenMode }
        rule.waitForIdle()
        assertDp("the sidebar is back", 360, rule.node(ChatScreenTags.SCREEN).bounds.left)
        rule.node(FlatRowTags.ROW).assertIsSelected()
    }

    // With no computer linked the sidebar is home's link page, and there is nothing to start: settings alone.
    @Test
    fun noComputerKeepsTheShell() {
        signIn(machine = false)
        waitFor(HomeTags.LINK)
        val sidebar = rule.node(SidebarTags.SIDEBAR).bounds
        assertTrue("the link page is the sidebar's", rule.node(HomeTags.LINK).bounds.right <= sidebar.right)
        rule.node(AccountMenuTags.BUTTON).assertExists()
        rule.node(SidebarTags.SETTINGS).assertExists()
        assertEquals(0, count(SidebarTags.COMPOSE))
        rule.node(MainPanelTags.PLACEHOLDER).assertExists()
    }

    // An unfolded foldable on its side, 841 wide: the shell, its sidebar at the least, 340.
    @Test
    @Config(qualifiers = "w841dp-h701dp-xhdpi")
    fun foldableLandscapeGetsTheNarrowestSidebar() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        val sidebar = rule.node(SidebarTags.SIDEBAR).bounds
        assertDp("30% of 841 is held to 340", 340, sidebar.right - sidebar.left)
        assertDp("the main panel after it", 340, rule.node(TabletShellTags.DETAIL).bounds.left)
    }

    // At exactly 840, Material's expanded class, the shell starts.
    @Test
    @Config(qualifiers = "w840dp-h750dp-xhdpi")
    fun theShellStartsAt840() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        val sidebar = rule.node(SidebarTags.SIDEBAR).bounds
        assertDp("sidebar 340", 340, sidebar.right - sidebar.left)
        assertDp("the main panel after it", 340, rule.node(TabletShellTags.DETAIL).bounds.left)
    }

    // The same foldable upright, 673 wide, and a phone: no shell, the phone home.
    @Test
    @Config(qualifiers = "w673dp-h841dp-xhdpi")
    fun foldablePortraitIsAPhone() = assertPhoneHome(ContentTokens.Medium.keyline(673.dp))

    // happy-app's old 768 cutoff: medium, one pane.
    @Test
    @Config(qualifiers = "w768dp-h1024dp-xhdpi")
    fun at768ItIsOnePane() = assertPhoneHome(ContentTokens.Medium.keyline(768.dp))

    // A Galaxy Z Fold7 on its side, 832 wide: medium, one pane, the centred column.
    @Test
    @Config(qualifiers = "w832dp-h750dp-xxhdpi")
    fun foldSidewaysIsOnePane() = assertPhoneHome(ContentTokens.Medium.keyline(832.dp))

    // The Fold upright, 750 wide: one pane.
    @Test
    @Config(qualifiers = "w750dp-h832dp-xxhdpi")
    fun foldUprightIsOnePane() = assertPhoneHome(ContentTokens.Medium.keyline(750.dp))

    @Test
    @Config(qualifiers = PHONE)
    fun phoneIsUnchanged() = assertPhoneHome(HomeCardSpec.inset)

    /** The phone's home, its rows' cards [cardInset] in: 16 on a phone, Material's 24 margin on a medium window. */
    private fun assertPhoneHome(cardInset: androidx.compose.ui.unit.Dp) {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.onAllNodesWithTag(SidebarTags.SIDEBAR, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(MainPanelTags.TOGGLE, useUnmergedTree = true).assertCountEquals(0)
        rule.node(AccountMenuTags.BUTTON).assertExists()
        rule.node(HomeTags.COMPOSE).assertExists()
        assertDp("home row inset in its card", cardInset, rule.node(FlatRowTags.ROW).bounds.left)
        rule.node(FlatRowTags.ROW).performClick()
        waitFor(ChatScreenTags.SCREEN)
        assertDp("the chat keeps its back button", 48, rule.node(HeaderTags.LEFT).bounds.let { it.right - it.left })
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteraction.assertIsNotSelectedOrUnselectable() =
        assert(androidx.compose.ui.test.SemanticsMatcher("not selected") { !it.config.getOrElse(androidx.compose.ui.semantics.SemanticsProperties.Selected) { false } })
}
