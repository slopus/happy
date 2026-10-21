package com.slopus.happy.ui.session

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.AgentWorkGroup
import com.slopus.happy.chat.WorkHeaderPlacement
import com.slopus.happy.model.AgentGoal
import com.slopus.happy.model.AgentGoalAction
import com.slopus.happy.model.PENDING_CHAT_PREFIX
import com.slopus.happy.model.PendingChat
import com.slopus.happy.model.RigActivityIndicator
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.WorktreeTabs
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.AgentWorkGroupHeader
import com.slopus.happy.ui.chat.AgentWorkGroupHeaderTags
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What Home puts on the session screen, against happy-app (Android branch):
 * - AgentGoalBar.tsx: full width, padded 12/10, 8 above what follows; the
 *   "Current goal" label (12/16) over the goal (14/19); then the offered
 *   actions, edit, stop, clear, as 30 buttons 4 apart, centred, the last
 *   12 in from the end; none when the agent offers none.
 * - RigActivityBar.tsx: 16/5 in, each indicator 10 after the last,
 *   "{count} agents" with " +{queued} queued"; nothing when idle.
 * - PendingChatPlaceholder.tsx: "Starting a new chat…" centred, then the
 *   queued messages 10 below, else the anchor's directory 6 below.
 * - WorktreeTabStrip.tsx: 10 above, 6 below, 16 in; a 40 capsule; tabs 4
 *   in and 2 apart, 32 high and centred; the 40 `+` at the end. A blue dot
 *   on an unread tab unless it is the open one; an orange one on a chat
 *   stopped on the user; "New chat" for each stand-in. A tap selects, a
 *   long press asks for the tab's actions with the tab beside it.
 * - AgentWorkGroupHeader.tsx: 16 in and 8 above, 28 high, "Worked 1m2s"
 *   and 6 on its chevron; "Hide" on the trailing copy; a tap toggles.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionBarsTest {
    @get:Rule
    val rule = createComposeRule()

    private val allActions = setOf(AgentGoalAction.Edit, AgentGoalAction.Stop, AgentGoalAction.Clear)

    @Test
    fun theGoalBarNamesTheGoalAndOffersItsActionsAtTheEnd() {
        val pressed = ArrayList<AgentGoalAction>()
        rule.setHappyContent {
            Column { AgentGoalBar(AgentGoal("claude", "c", "Ship the port", allActions), onAction = { pressed += it }, inFlight = null) }
        }
        val bar = rule.node(SessionBarTags.GOAL).bounds
        // The tagged box carries the 8 below it.
        assertBox("goal bar", bar, 0.dp, 0.dp, PHONE_WIDTH.dp, 63.dp)
        val text = rule.node(SessionBarTags.GOAL_TEXT).bounds
        assertDp("goal text top", 26, text.top)
        assertDp("goal text height", 19, text.height)
        rule.onNodeWithText("Current goal").assertIsDisplayed()

        val clear = rule.node(SessionBarTags.goalAction(AgentGoalAction.Clear)).bounds
        val stop = rule.node(SessionBarTags.goalAction(AgentGoalAction.Stop)).bounds
        val edit = rule.node(SessionBarTags.goalAction(AgentGoalAction.Edit)).bounds
        assertBox("clear", clear, (PHONE_WIDTH - 12 - 30).dp, 12.5.dp, 30.dp, 30.dp)
        assertDp("stop before clear", clear.left - 4.dp, stop.right)
        assertDp("edit before stop", stop.left - 4.dp, edit.right)

        rule.node(SessionBarTags.goalAction(AgentGoalAction.Clear)).performClick()
        assertEquals(listOf(AgentGoalAction.Clear), pressed)
    }

    /**
     * TalkBack, as AgentGoalBar and WorktreeTabStrip label them: the bar is
     * one stop reading "Current goal: …", its actions buttons named Edit,
     * Stop and Clear goal; the tabs are tabs named after their chat, the
     * open one selected, and `+` is the "New session" button.
     */
    @Test
    fun theBarsReadForTalkBack() {
        val tabs = WorktreeTabs(
            tabs = listOf(SessionRowData("a", name = "Alpha"), SessionRowData("b", name = "Beta")),
            pending = listOf(PendingChat(PENDING_CHAT_PREFIX + "p", "a", knownSessionIds = listOf("a", "b"), createdAt = 0)),
        )
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            Column {
                AgentGoalBar(AgentGoal("claude", "c", "Ship the port", allActions), onAction = {}, inFlight = null)
                WorktreeTabStrip(tabs, "a", onSelect = {}, onMenu = { _, _ -> }, onNewTab = {}, listState = rememberLazyListState())
            }
        }
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithTag(SessionBarTags.GOAL).assert(hasContentDescription("Current goal: Ship the port"))
        for (label in listOf("Edit goal", "Stop goal", "Clear goal")) {
            rule.onNode(hasContentDescription(label) and hasRole(Role.Button)).assertExists()
        }
        rule.onNodeWithTag(WorktreeTabTags.tab("a")).assert(hasRole(Role.Tab) and hasContentDescription("Alpha")).assertIsSelected()
        rule.onNodeWithTag(WorktreeTabTags.tab("b")).assert(hasRole(Role.Tab)).assertIsNotSelected()
        rule.onNode(hasContentDescription("New session") and hasRole(Role.Button)).assertExists()
        rule.assertActionsLabelled()
    }

    @Test
    fun aGoalWithoutCapabilitiesHasNoButtons() {
        rule.setHappyContent { AgentGoalBar(AgentGoal("codex", "t", "Goal"), onAction = {}, inFlight = null) }
        AgentGoalAction.entries.forEach { rule.node(SessionBarTags.goalAction(it)).assertDoesNotExist() }
    }

    @Test
    fun rigActivityListsWhatRunsBesideTheChat() {
        rule.setHappyContent {
            Column {
                RigActivityBar(listOf(RigActivityIndicator("subagents", 2, queued = 3), RigActivityIndicator("processes", 1)))
                RigActivityBar(emptyList())
            }
        }
        rule.onNodeWithText("2 +3 queued agents").assertIsDisplayed()
        rule.onNodeWithText("1 processes").assertIsDisplayed()
        val agents = rule.node(SessionBarTags.activity("subagents")).bounds
        val processes = rule.node(SessionBarTags.activity("processes")).bounds
        assertDp("first indicator left", 16, agents.left)
        assertDp("first indicator top", 5, agents.top)
        assertDp("second indicator 10 on", agents.right + 10.dp, processes.left)
    }

    @Test
    fun aPendingChatShowsWhatWaitsElseWhereItWillRun() {
        val chat = PendingChat(PENDING_CHAT_PREFIX + "1", "a", knownSessionIds = emptyList(), createdAt = 0)
        var pending by mutableStateOf(chat)
        rule.mainClock.autoAdvance = false
        rule.setHappyContent { Box(Modifier.fillMaxSize()) { PendingChatPlaceholder(pending, anchorPath = "~/proj") } }
        rule.mainClock.advanceTimeBy(100)
        val title = rule.node(SessionBarTags.PENDING_TITLE).bounds
        assertDp("title centred", (PHONE_WIDTH.dp - title.width) / 2, title.left)
        val path = rule.node(SessionBarTags.PENDING_DETAIL)
        path.assertTextEquals("~/proj")
        assertDp("path 6 under the title", title.bottom + 6.dp, path.bounds.top)

        pending = chat.copy(queued = listOf("first", "second"))
        rule.mainClock.advanceTimeBy(100)
        val queued = rule.node(SessionBarTags.PENDING_DETAIL)
        queued.assertTextEquals("first\n\nsecond")
        assertDp("queued 10 under the title", rule.node(SessionBarTags.PENDING_TITLE).bounds.bottom + 10.dp, queued.bounds.top)
    }

    @Test
    fun theTabStripDrawsTheCheckoutsChatsThenTheStartingOnes() {
        val selected = ArrayList<String>()
        val menus = ArrayList<Pair<String, String?>>()
        var added = 0
        val tabs = WorktreeTabs(
            tabs = listOf(
                SessionRowData("a", name = "Alpha", hasUnread = true),
                SessionRowData("b", name = "Beta", hasUnread = true),
                SessionRowData("c", name = "Gamma", state = SessionState.PermissionRequired),
            ),
            pending = listOf(PendingChat(PENDING_CHAT_PREFIX + "p", "a", knownSessionIds = listOf("a", "b", "c"), createdAt = 0)),
        )
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            Column {
                WorktreeTabStrip(tabs, "a", onSelect = { selected += it }, onMenu = { id, next -> menus += id to next }, onNewTab = { added++ }, listState = rememberLazyListState())
            }
        }
        rule.mainClock.advanceTimeBy(100)
        assertBox("strip", rule.node(WorktreeTabTags.STRIP).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, 56.dp)
        val pill = rule.node(WorktreeTabTags.PILL).bounds
        assertBox("pill", pill, 16.dp, 10.dp, (PHONE_WIDTH - 32).dp, 40.dp)
        val alpha = rule.node(WorktreeTabTags.tab("a")).bounds
        val beta = rule.node(WorktreeTabTags.tab("b")).bounds
        assertDp("first tab 4 in", 20, alpha.left)
        assertDp("tab top", 14, alpha.top)
        assertDp("tab height", 32, alpha.height)
        assertDp("tabs 2 apart", alpha.right + 2.dp, beta.left)
        assertBox("add", rule.node(WorktreeTabTags.ADD).bounds, (PHONE_WIDTH - 16 - 40).dp, 10.dp, 40.dp, 40.dp)

        rule.node(WorktreeTabTags.tab("a")).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        rule.node(WorktreeTabTags.dot("a")).assertDoesNotExist()
        rule.node(WorktreeTabTags.dot("b")).assertIsDisplayed()
        rule.node(WorktreeTabTags.dot("c")).assertIsDisplayed()
        rule.node(WorktreeTabTags.tab(PENDING_CHAT_PREFIX + "p")).assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("New chat")))

        rule.node(WorktreeTabTags.tab("b")).performClick()
        rule.node(WorktreeTabTags.tab("a")).performTouchInput { longClick() }
        rule.node(WorktreeTabTags.ADD).performClick()
        rule.mainClock.advanceTimeBy(1000)
        assertEquals(listOf("b"), selected)
        assertEquals(listOf("a" to "b"), menus)
        assertEquals(1, added)
    }

    @Test
    fun aWorkGroupHeaderSaysHowLongItWorkedAndToggles() {
        val group = AgentWorkGroup("work-1", "u1", emptyList(), false, false, startedAt = 1_000, completedAt = 63_000)
        var toggles = 0
        rule.setHappyContent {
            Column {
                AgentWorkGroupHeader(group, expanded = false, onToggle = { toggles++ })
                AgentWorkGroupHeader(group, expanded = true, onToggle = {}, placement = WorkHeaderPlacement.Trailing)
            }
        }
        rule.onNodeWithText("Worked 1m2s").assertIsDisplayed()
        rule.onNodeWithText("Hide").assertIsDisplayed()
        val header = rule.onNodeWithText("Worked 1m2s", useUnmergedTree = true)
        val leadingNode = rule.onAllNodesWithTag(AgentWorkGroupHeaderTags.HEADER, useUnmergedTree = true)[0]
        val leading = leadingNode.bounds
        assertBox("leading header", leading, 16.dp, 8.dp, (PHONE_WIDTH - 32).dp, 28.dp)
        assertDp("chevron 6 after the label", header.bounds.right + 6.dp, rule.onAllNodesWithTag(AgentWorkGroupHeaderTags.CHEVRON, useUnmergedTree = true)[0].bounds.left)
        leadingNode.performClick()
        assertEquals(1, toggles)
    }
}
