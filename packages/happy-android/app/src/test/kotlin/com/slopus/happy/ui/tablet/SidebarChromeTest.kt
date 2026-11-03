package com.slopus.happy.ui.tablet

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeLayoutTest
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.connection.AgentSearchTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.WindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Agent home as the tablet's sidebar (happy-ios f3ac778cb, docs/IPAD.md
 * "The sidebar's chrome"): the bar holds the account and its name alone;
 * search is a 36 field 8 under the list's top, 16 in, scrolling with it,
 * that holds still with Cancel beside it while open; settings is a 48
 * circle at the foot's start, compose a 48 "New task" pill at its end,
 * both 16 off the sides and foot; the row the main panel shows is selected.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SidebarChromeTest {
    @get:Rule val rule = createComposeRule()

    private var settings = 0
    private var composed = 0
    private val actions = AgentHomeActions({}, { composed++ }, { settings++ }, {}, {}, {})
    private val accounts = AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true)))
    private val feed get() = AgentFeed.derive(AgentHomeLayoutTest.catalog(AgentHomeLayoutTest.sample))

    private fun show(feed: AgentFeed = this.feed, selected: String? = MainPanelKey.conversation("ab1")) = rule.setHappyContent {
        CompositionLocalProvider(
            LocalWindowLayout provides WindowLayout.of(360.dp, 800.dp),
            LocalSidebarHome provides SidebarHome(selected),
        ) {
            Box(Modifier.width(360.dp).fillMaxHeight()) {
                AgentHomeScreen("Studio", feed, AgentLinkStatus.Connected, accounts, actions)
            }
        }
    }

    @Test
    fun theBarHoldsTheAccountAloneAndTheFootSettingsAndCompose() {
        show()
        // No search, settings or floating compose in the phone's places.
        for (tag in listOf(AgentHomeTags.SEARCH, AgentHomeTags.SETTINGS, AgentHomeTags.COMPOSE)) {
            assertEquals(tag, 0, rule.onAllNodesWithTagCount(tag))
        }
        rule.node(AccountMenuTags.BUTTON).assertExists()
        rule.node(AgentHomeTags.TITLE).assertExists()

        assertBox("settings", rule.node(SidebarTags.SETTINGS).bounds, 16.dp, (800 - 16 - 48).dp, 48.dp, 48.dp)
        val compose = rule.node(SidebarTags.COMPOSE).bounds
        assertDp("compose 16 off the end", 344, compose.right)
        assertDp("compose 16 off the foot", 800 - 16, compose.bottom)
        assertDp("a 48 pill", 48, compose.height)
        assertTrue("compose clears settings by 12: $compose", compose.left >= 16.dp + 48.dp + 12.dp)
        rule.onNode(hasTestTag(SidebarTags.COMPOSE)).assertTextContains("New task").performClick()
        rule.node(SidebarTags.SETTINGS).performClick()
        assertEquals(1, composed)
        assertEquals(1, settings)
    }

    @Test
    fun theOpenRowIsSelected() {
        show()
        rule.node(AgentHomeTags.row("agent-ab1")).assertIsSelected()
        rule.node(AgentHomeTags.row("agent-at1")).assertIsNotSelectedOrUnselectable()
    }

    @Test
    fun searchIsAFieldAtTheListsTopThatHoldsStillWhileOpen() {
        show()
        val bar = rule.node(AgentHomeTags.BAR).bounds
        val field = rule.node(SidebarTags.SEARCH).bounds
        // The list starts past the bar's feather; the field 8 into it, as home's first card.
        assertBox("field", field, 16.dp, bar.bottom + GlassSpec.feather + 8.dp, 328.dp, 36.dp)

        rule.node(SidebarTags.SEARCH).performClick()
        rule.waitForIdle()
        val cancel = rule.node(SidebarTags.SEARCH_CANCEL).bounds
        val open = rule.onNode(hasTestTag(SidebarTags.SEARCH) and com.slopus.happy.ui.isOnActivePage and androidx.compose.ui.test.hasAnyDescendant(hasTestTag(AgentSearchTags.FIELD)), useUnmergedTree = true).bounds
        assertEquals("open at its rest", field.top.value, open.top.value, 0.5f)
        assertDp("Cancel 16 off the end", 344, cancel.right)
        assertDp("Cancel 8 after the field", open.right + 8.dp, cancel.left)

        rule.node(AgentSearchTags.FIELD).performTextInput("re")
        rule.waitForIdle()
        val results = rule.node(AgentSearchTags.RESULTS).bounds
        assertDp("results 4 under the field", open.bottom + 4.dp, results.top)
        rule.onNode(hasText("Review the PR") and hasAnyAncestorTag(AgentSearchTags.RESULTS), useUnmergedTree = true).assertExists()

        rule.node(SidebarTags.SEARCH_CANCEL).performClick()
        rule.waitForIdle()
        assertEquals(0, rule.onAllNodesWithTagCount(SidebarTags.SEARCH_CANCEL))
        assertEquals(0, rule.onAllNodesWithTagCount(AgentSearchTags.RESULTS))
    }

    @Test
    fun withNothingToStartSettingsIsAlone() {
        show(AgentFeed.Empty)
        rule.node(SidebarTags.SETTINGS).assertExists()
        assertEquals(0, rule.onAllNodesWithTagCount(SidebarTags.COMPOSE))
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTagCount(tag: String) =
        onAllNodes(hasTestTag(tag) and com.slopus.happy.ui.isOnActivePage, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun hasAnyAncestorTag(tag: String) = androidx.compose.ui.test.hasAnyAncestor(hasTestTag(tag))

    private fun androidx.compose.ui.test.SemanticsNodeInteraction.assertIsNotSelectedOrUnselectable() =
        assert(androidx.compose.ui.test.SemanticsMatcher("not selected") { !it.config.getOrElse(androidx.compose.ui.semantics.SemanticsProperties.Selected) { false } })
}
