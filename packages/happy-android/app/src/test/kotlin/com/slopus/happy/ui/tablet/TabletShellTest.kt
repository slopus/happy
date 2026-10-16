package com.slopus.happy.ui.tablet

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
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
import com.slopus.happy.ui.files.ChangesTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeDockTags
import com.slopus.happy.ui.home.NewSessionTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.session.SessionInfoTags
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val TABLET = "w1280dp-h800dp-xhdpi"
private const val TABLET_WIDTH = 1280

/**
 * SidebarNavigator.tsx on a signed-in window: the sidebar (30% of the window,
 * 250–360) beside the stack from 768 wide, the persistent header's zen and
 * back over both, Home blank in the detail; just the stack below 768.
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
        rule.setContent { HappyApp(graph) }
    }

    private fun waitFor(tag: String) = rule.waitUntilAtLeastOneExists(hasTestTag(tag), 5_000)

    @Test
    fun sidebarBesideABlankDetail() {
        session("a", 200)
        session("b", 100)
        signIn()
        waitFor(FlatRowTags.ROW)
        val sidebar = rule.node(TabletSidebarTags.SIDEBAR).bounds
        // floor(1280 * 0.3) = 384, held to 360.
        assertBox("sidebar", sidebar, 0.dp, 0.dp, 360.dp, sidebar.bottom)
        val detail = rule.node(TabletShellTags.DETAIL).bounds
        assertBox("detail", detail, 360.dp, 0.dp, (TABLET_WIDTH - 360).dp, detail.bottom)
        rule.node(HomeTags.TABLET_BLANK).assertExists()
        // The phone home's header is not drawn: its list lives in the sidebar.
        rule.onAllNodesWithTag(HomeTags.FILTER, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true).assertCountEquals(2)

        // The persistent header: 28 controls 16 in, 4 apart, centred in the 64 row; back dimmed with nowhere to go.
        val header = rule.node(TabletShellTags.HEADER).bounds
        assertDp("header row", 64, header.bottom - header.top)
        val zen = rule.node(TabletShellTags.ZEN).bounds
        assertBox("zen", zen, 16.dp, header.top + 18.dp, 28.dp, 28.dp)
        assertBox("back", rule.node(TabletShellTags.BACK).bounds, 48.dp, zen.top, 28.dp, 28.dp)

        // New session sits 8 under the header row, 16 in.
        val newSession = rule.node(TabletSidebarTags.NEW_SESSION).bounds
        assertDp("new session 16 in", 16, newSession.left - sidebar.left - 1.dp / 2)
        assertTrue("new session under the header", newSession.top >= header.bottom + 8.dp)
        val settings = rule.node(TabletSidebarTags.SETTINGS).bounds
        assertDp("settings row at the sidebar's foot", sidebar.bottom - 0.5.dp, settings.bottom)
    }

    @Test
    fun openingASessionShowsItBesideTheSelectedRow() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.node(FlatRowTags.ROW).performClick()
        waitFor(ChatScreenTags.SCREEN)
        val chat = rule.node(ChatScreenTags.SCREEN).bounds
        assertDp("chat fills the detail", 360, chat.left)
        assertDp("chat to the window's edge", TABLET_WIDTH, chat.right)
        rule.node(FlatRowTags.ROW).assertIsSelected()
        // The persistent header's back replaces the chat's own.
        rule.onAllNodesWithTag(HeaderTags.LEFT, useUnmergedTree = true).let { lefts ->
            lefts.fetchSemanticsNodes().forEach { assertEquals(0, it.size.width) }
        }
        rule.node(TabletShellTags.BACK).performClick()
        waitFor(HomeTags.TABLET_BLANK)
        rule.onAllNodesWithTag(ChatScreenTags.SCREEN, useUnmergedTree = true).assertCountEquals(0)
    }

    // SessionsList.tsx selectedSessionId: any `/session/<id>/…` screen keeps its row selected.
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

    /**
     * SidebarView.tsx: New session opens /new in the detail; the phone home's
     * dock is not drawn on a tablet. new/index.tsx draws its own back there,
     * which nothing hides. `router.navigate('/new')` with /new on top stays
     * one screen: a second tap adds no entry, so one Back leaves.
     */
    @Test
    fun newSessionOpensInTheDetail() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.onAllNodesWithTag(HomeDockTags.DOCK, useUnmergedTree = true).assertCountEquals(0)
        rule.node(TabletSidebarTags.NEW_SESSION).performClick()
        waitFor(NewSessionTags.SCREEN)
        assertDp("new session in the detail", 360, rule.node(NewSessionTags.SCREEN).bounds.left)
        assertDp("its own back, 48 wide", 48, rule.node(NewSessionTags.BACK).bounds.let { it.right - it.left })

        rule.node(TabletSidebarTags.NEW_SESSION).performClick()
        rule.waitForIdle()
        rule.onAllNodesWithTag(NewSessionTags.SCREEN, useUnmergedTree = true).assertCountEquals(1)
        rule.node(NewSessionTags.BACK).performClick()
        waitFor(HomeTags.TABLET_BLANK)
        rule.onAllNodesWithTag(NewSessionTags.SCREEN, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun zenCollapsesTheSidebar() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.node(TabletShellTags.ZEN).performClick()
        rule.waitUntil(5_000) { graph.localSettings.values.value.zenMode }
        rule.waitForIdle()
        rule.onAllNodesWithTag(TabletSidebarTags.SIDEBAR, useUnmergedTree = true).assertCountEquals(0)
        assertBox("detail", rule.node(TabletShellTags.DETAIL).bounds, 0.dp, 0.dp, TABLET_WIDTH.dp, rule.node(TabletShellTags.DETAIL).bounds.bottom)
        // The controls stay put.
        assertDp("zen stays 16 in", 16, rule.node(TabletShellTags.ZEN).bounds.left)
    }

    @Test
    fun noSessionsShowsTheTabletEmptyState() {
        signIn()
        waitFor(EmptySessionsTabletTags.ROOT)
        val sidebar = rule.node(TabletSidebarTags.SIDEBAR).bounds
        val empty = rule.node(EmptySessionsTabletTags.ROOT).bounds
        assertTrue("in the sidebar", empty.left >= sidebar.left && empty.right <= sidebar.right)
        assertDp("64 glyph", 64, rule.node(EmptySessionsTabletTags.ICON).bounds.let { it.bottom - it.top })
    }

    // index.tsx: with no computer linked the link page takes the whole window, shell and all.
    @Test
    fun theLinkPageTakesTheWholeWindow() {
        signIn(machine = false)
        waitFor(HomeTags.LINK)
        rule.onAllNodesWithTag(TabletSidebarTags.SIDEBAR, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(TabletShellTags.HEADER, useUnmergedTree = true).assertCountEquals(0)
        assertDp("link page from the left edge", 0, rule.node(HomeTags.LINK).bounds.left)
    }

    // An unfolded foldable on its side, 841 wide: the shell, with a 252 sidebar (30%).
    @Test
    @Config(qualifiers = "w841dp-h701dp-xhdpi")
    fun foldableLandscapeGetsANarrowSidebar() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        val sidebar = rule.node(TabletSidebarTags.SIDEBAR).bounds
        assertDp("sidebar 30% of 841", 252, sidebar.right - sidebar.left)
        assertDp("detail after it", 252, rule.node(TabletShellTags.DETAIL).bounds.left)
    }

    // The same foldable upright, 673 wide, and a phone: no shell, the phone home.
    @Test
    @Config(qualifiers = "w673dp-h841dp-xhdpi")
    fun foldablePortraitIsAPhone() = assertPhoneHome()

    @Test
    @Config(qualifiers = PHONE)
    fun phoneIsUnchanged() = assertPhoneHome()

    private fun assertPhoneHome() {
        session("a", 200)
        signIn()
        waitFor(FlatRowTags.ROW)
        rule.onAllNodesWithTag(TabletSidebarTags.SIDEBAR, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(TabletShellTags.HEADER, useUnmergedTree = true).assertCountEquals(0)
        rule.node(HomeTags.FILTER).assertExists()
        rule.node(HomeDockTags.DOCK).assertExists()
        assertDp("home row from the left edge", 0, rule.node(FlatRowTags.ROW).bounds.left)
        rule.node(FlatRowTags.ROW).performClick()
        waitFor(ChatScreenTags.SCREEN)
        assertDp("the chat keeps its back button", 48, rule.node(HeaderTags.LEFT).bounds.let { it.right - it.left })
    }
}
