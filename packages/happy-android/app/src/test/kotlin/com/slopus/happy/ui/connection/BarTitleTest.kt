package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.LinkState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.LinkStatusTags
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
 * Home's title as the link changes (iOS 7aee3a9b8 `HostedLinkTitleTests`):
 * the status rises 6 into the name's place as the name lifts 6 away, both
 * fading over 250 ms, and one status gives way to the next under a spinner
 * that stays.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BarTitleTest {
    @get:Rule
    val rule = createComposeRule()

    private var link by mutableStateOf(LinkState.Online)

    private fun show() = rule.setHappyContent { BarTitle("Studio Mac", link, TITLE, STATUS) }

    /** Sets the link with the clock held, and lets one frame take it up. */
    private fun change(to: LinkState) {
        link = to
        Snapshot.sendApplyNotifications()
        rule.mainClock.advanceTimeByFrame()
    }

    private fun words(text: String) = rule.onNodeWithText(text, useUnmergedTree = true).getUnclippedBoundsInRoot()

    @Test
    fun theStatusRisesIntoTheNamesPlaceAsTheNameLiftsAway() {
        show()
        val name = rule.node(TITLE).bounds
        rule.mainClock.autoAdvance = false
        change(LinkState.Connecting)
        rule.mainClock.advanceTimeBy(BarTitleSpec.DURATION_MILLIS / 2L)
        // Halfway, both are there: the name on its way up, the status on its way up from below.
        val lifting = rule.node(TITLE).bounds
        val rising = words("Connecting…")
        assertTrue("the name lifts (${lifting.top} vs ${name.top})", lifting.top < name.top && lifting.top > name.top - BarTitleSpec.slide)
        rule.mainClock.advanceTimeBy(BarTitleSpec.DURATION_MILLIS.toLong())
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val settled = words("Connecting…")
        assertTrue("the status rises from below (${rising.top} vs ${settled.top})", rising.top > settled.top && rising.top < settled.top + BarTitleSpec.slide)
        rule.onAllNodesWithTag(TITLE, useUnmergedTree = true).assertCountEquals(0)
        assertDp("the status where the name was", name.left, rule.node(STATUS).bounds.left)
    }

    @Test
    fun oneStatusForAnotherKeepsTheSpinner() {
        link = LinkState.WaitingForNetwork
        show()
        rule.onNodeWithText("Waiting for network…", useUnmergedTree = true).assertExists()
        val spinner = rule.node(LinkStatusTags.SPINNER).bounds
        rule.mainClock.autoAdvance = false
        change(LinkState.Connecting)
        rule.mainClock.advanceTimeBy(BarTitleSpec.DURATION_MILLIS / 2L)
        // Only the words change, the old ones lifting away over the new; the spinner holds still, one of it.
        rule.onAllNodesWithTag(LinkStatusTags.SPINNER, useUnmergedTree = true).assertCountEquals(1)
        assertEquals(spinner, rule.node(LinkStatusTags.SPINNER).bounds)
        rule.onNodeWithText("Waiting for network…", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Connecting…", useUnmergedTree = true).assertExists()
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onAllNodesWithText("Waiting for network…", useUnmergedTree = true).assertCountEquals(0)
        assertEquals(spinner, rule.node(LinkStatusTags.SPINNER).bounds)
        assertDp("6 after the spinner", spinner.right + 6.dp, words("Connecting…").left)
    }

    private companion object {
        const val TITLE = "title"
        const val STATUS = "status"
    }
}
