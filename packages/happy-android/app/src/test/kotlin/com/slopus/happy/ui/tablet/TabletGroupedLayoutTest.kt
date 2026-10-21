package com.slopus.happy.ui.tablet

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.ProjectWorkspaceGroup
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.VisibleGitChanges
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeScreenActions
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val SIDEBAR = 360

/**
 * The sidebar grouped by project, at its 360 width:
 * - MachineHeader: 8 above, 24 in, the name at most 60% of the row.
 * - WorkspaceSection: 12 above a 36 heading (14/20 over 12/16), 8 below; a
 *   30 "+" 22 from the edge whose centre shares an x with the card's dots;
 *   the card 12 in either side, 56 rows.
 * - SessionItem: an 88 card 16 in, 12 below the last of its day.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabletGroupedLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val opened = mutableListOf<String>()
    private val stopped = mutableListOf<String>()
    private val newIn = mutableListOf<String?>()
    private val machines = mutableListOf<String>()

    private val callbacks = HomeListCallbacks(
        onOpen = { opened += it },
        onMenu = {},
        onArchive = {},
        onSetArchiveHidden = {},
        onToggleProject = {},
        onOpenMachine = { machines += it },
        onCreateWorkspace = {},
        onProjectMenu = { _, _ -> },
    )
    private val actions = HomeScreenActions(
        onSettings = {},
        onAppearance = {},
        onSetGrouping = {},
        onNewSession = {},
        onTroubleshoot = {},
        onOpenUrl = {},
        onWhatsNew = {},
    )
    private val grouped = TabletGroupedActions(onStop = { stopped += it }, onNewInCheckout = { newIn += it?.id })

    private fun session(id: String, state: SessionState = SessionState.Waiting, hasUnread: Boolean = false, model: String? = null) =
        SessionRowData(id = id, name = "Chat $id", state = state, hasUnread = hasUnread, machineId = "m1", path = "/repo/$id", modelName = model)

    private val rows = listOf(
        TabletGroupedRow.MachineHeader("m1", "A computer with a rather long name that cannot fit"),
        TabletGroupedRow.Checkout(
            projectKey = "p",
            projectName = "happy",
            workspace = ProjectWorkspaceGroup("", null, listOf(session("a", SessionState.Thinking), session("b", hasUnread = true))),
            branch = null,
            changes = VisibleGitChanges(false, 12, 3),
            lastOfProject = true,
        ),
        TabletGroupedRow.ArchiveToggle(hidden = false),
        TabletGroupedRow.ArchivedSession(session("old", SessionState.Waiting, hasUnread = true, model = "Opus"), first = true, last = true),
    )

    private fun show(selected: String? = null) = rule.setHappyContent {
        Box(Modifier.width(SIDEBAR.dp).fillMaxHeight()) {
            TabletGroupedList(rows, null, null, callbacks, actions, grouped, selected, bottomSpacer = {})
        }
    }

    @Test
    fun machineRuleAndCheckoutGeometry() {
        show()
        val machine = rule.node(TabletGroupedTags.MACHINE).bounds
        val name = rule.node(TabletGroupedTags.MACHINE_NAME).bounds
        // 60% of the 312 between the paddings.
        assertDp("the name is held to 60% of the row", 187.2.dp, name.right - name.left)
        assertDp("8 above the name", machine.top + 8.dp, name.top)
        assertDp("24 in", 24.dp, rule.node(TabletGroupedTags.MACHINE).bounds.left + 24.dp - machine.left)
        val checkout = rule.node(TabletGroupedTags.CHECKOUT).bounds
        assertDp("checkout under the rule", machine.bottom, checkout.top)

        // The rule's 11 text lands between pixels; the heading below is measured from the card.
        val card = rule.node(TabletGroupedTags.CARD).bounds
        assertBox("card", card, 12.dp, card.top, (SIDEBAR - 24).dp, 112.dp)
        assertEquals("12 + 36 + 8 above the card", 56f, (card.top - checkout.top).value, 0.5f)
        val add = rule.node(TabletGroupedTags.ADD).bounds
        assertBox("add", add, (SIDEBAR - 22 - 30).dp, card.top - 8.dp - 33.dp, 30.dp, 30.dp)
        val compact = rule.onAllNodesWithTag(TabletGroupedTags.COMPACT_ROW, useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals(2, compact.size)

        // The "+" sits over the dots: both centred 22 + 15 from the edge.
        val dot = rule.onAllNodesWithTag(TabletGroupedTags.INDICATOR, useUnmergedTree = true)[0].bounds
        assertDp("dot slot", 18, dot.right - dot.left)
        assertDp("dot under +", (add.left + add.right) / 2, (dot.left + dot.right) / 2)
        // A project's 4 trails its last checkout.
        assertDp("project gap", card.bottom + 8.dp + 4.dp, checkout.bottom)
    }

    @Test
    fun archivedCard() {
        show(selected = "old")
        val card = rule.node(TabletGroupedTags.ARCHIVED).bounds
        assertBox("archived card", card, 16.dp, card.top, (SIDEBAR - 32).dp, 88.dp)
        rule.node(TabletGroupedTags.ARCHIVED).assertIsSelected()
        rule.node(TabletGroupedTags.ARCHIVED_STATUS).assertTextEquals("Opus · new results")
    }

    @Test
    fun tapsOpenTheChatTheComputerAndANewSessionInTheCheckout() {
        show()
        rule.onAllNodesWithTag(TabletGroupedTags.COMPACT_ROW, useUnmergedTree = true)[1].performClick()
        rule.node(TabletGroupedTags.MACHINE).performClick()
        rule.node(TabletGroupedTags.ADD).performClick()
        assertEquals(listOf("b"), opened)
        assertEquals(listOf("m1"), machines)
        assertEquals(listOf<String?>("a"), newIn)
    }

    @Test
    fun swipingACompactRowOnlyStopsIt() {
        show()
        rule.onAllNodesWithTag(TabletGroupedTags.COMPACT_ROW, useUnmergedTree = true)[0].performTouchInput { swipeLeft() }
        rule.waitForIdle()
        rule.onAllNodesWithTag(FlatRowTags.ARCHIVE_ACTION, useUnmergedTree = true)[0].performClick()
        assertEquals(listOf("a"), stopped)
    }
}
