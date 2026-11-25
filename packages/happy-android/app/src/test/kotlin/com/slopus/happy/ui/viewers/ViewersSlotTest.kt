package com.slopus.happy.ui.viewers

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.TopBar
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.viewers.Viewer
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The header's viewers ([ViewersSpec]): a 104 slot whatever the count, so
 * the title holds still; faces 18 apart at its end, four then "+N"; Recent
 * with its minutes, Seen at 20.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ViewersSlotTest {
    @get:Rule val rule = createComposeRule()

    private val now = 10_000_000L
    private val people = mapOf("kirill" to TeamUser("kirill", "Kirill"), "anna" to TeamUser("anna", "Anna"), "max" to TeamUser("max", "Max"))
    private val kirill = Viewer("kirill", here = true, lastSeenAt = now)
    private val anna = Viewer("anna", here = false, lastSeenAt = now - 4 * 60_000 - 5_000)
    private val max = Viewer("max", here = false, lastSeenAt = now - 14 * 86_400_000L)
    private fun crowd(count: Int) = (1..count).map { Viewer("u$it", here = it % 2 == 0, lastSeenAt = now - it * 1_000L) }

    /** The faces left to right: the first is drawn on top, so the tree lists them last first. */
    private fun faces() = rule.onAllNodesWithTag(ViewersTags.FACE, useUnmergedTree = true).fetchSemanticsNodes()
        .map { with(rule.density) { it.boundsInRoot.let { r -> androidx.compose.ui.unit.DpRect(r.left.toDp(), r.top.toDp(), r.right.toDp(), r.bottom.toDp()) } } }
        .sortedBy { it.left.value }

    @Test
    fun theTitleHoldsStillFromNoneToTen() {
        var viewers by mutableStateOf<List<Viewer>?>(null)
        rule.setHappyContent {
            TopBar(
                navigationIcon = {},
                title = { Text("Fix the flaky login test", Modifier.testTag("title")) },
                actions = { ViewersRow(viewers, people, clock = { now }) },
            )
        }
        val title = rule.node("title").bounds
        val slot = rule.node(ViewersTags.SLOT).bounds
        assertDp("slot width", 104.dp, slot.right - slot.left)
        for (next in listOf(emptyList(), listOf(kirill), crowd(10), emptyList())) {
            viewers = next
            rule.waitForIdle()
            assertEquals("title with ${next.size}", title, rule.node("title").bounds)
            assertEquals("slot with ${next.size}", slot, rule.node(ViewersTags.SLOT).bounds)
        }
    }

    @Test
    fun fourFacesThenTheRestCounted() {
        rule.setHappyContent { ViewersRow(crowd(10), emptyMap(), clock = { now }) }
        val slot = rule.node(ViewersTags.SLOT).bounds
        val faces = faces()
        assertEquals(4, faces.size)
        assertDp("first face at the slot's start", slot.left, faces[0].left)
        assertDp("18 apart", 18.dp, faces[1].left - faces[0].left)
        rule.onNodeWithText("+6", useUnmergedTree = true).assertExists()
        assertDp("the count in the last cell", slot.right - 32.dp, rule.node(ViewersTags.MORE).bounds.left - 4.dp)
    }

    @Test
    fun tiersDrawAsTheyAre() {
        rule.setHappyContent { ViewersRow(listOf(kirill, anna, max), people, clock = { now }) }
        val slot = rule.node(ViewersTags.SLOT).bounds
        assertDp("the last face at the slot's end", slot.right, faces()[2].right)
        rule.onAllNodesWithTag(ViewersTags.RING, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("4m", useUnmergedTree = true).assertExists()
        rule.onAllNodesWithTag(ViewersTags.BADGE, useUnmergedTree = true).assertCountEquals(1)
        rule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Kirill is here"))).assertExists()
    }

    @Test
    fun aTapListsEveryoneWithWhenTheyWereHere() {
        rule.setHappyContent { ViewersRow(listOf(kirill, anna, max), people, clock = { now }) }
        rule.node(ViewersTags.SLOT).performClick()
        rule.onNodeWithText("Kirill").assertExists()
        rule.onNodeWithText("here now").assertExists()
        rule.onNodeWithText("Anna").assertExists()
        rule.onNodeWithText("4 minutes ago").assertExists()
        rule.onNodeWithText("Max").assertExists()
    }

    @Test
    fun rightToLeftTheFacesRunFromTheOtherEnd() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) { ViewersRow(crowd(10), emptyMap(), clock = { now }) }
        }
        val slot = rule.node(ViewersTags.SLOT).bounds
        val faces = faces()
        assertEquals(4, faces.size)
        assertDp("the first face at the slot's start, on the right", slot.right, faces[3].right)
        assertDp("18 apart", 18.dp, faces[3].left - faces[2].left)
        assertDp("the count at the slot's end, on the left", slot.left + 4.dp, rule.node(ViewersTags.MORE).bounds.left)
    }

    @Test
    fun editorsAreMarkedInTheListAndOnesTheViewersDontNameAdded() {
        val editors = listOf(ViewersEditor("Kirill", Color.Red), ViewersEditor("Old Client", Color.Blue))
        rule.setHappyContent { ViewersRow(listOf(kirill, anna), people, editors = editors, clock = { now }) }
        rule.node(ViewersTags.SLOT).performClick()
        rule.onNodeWithText("here now · editing").assertExists()
        rule.onNodeWithText("Old Client").assertExists()
        rule.onNodeWithText("editing").assertExists()
        rule.onAllNodesWithTag(ViewersTags.EDITOR, useUnmergedTree = true).assertCountEquals(2)
    }

    @Test
    fun editorsAloneStillOpenTheList() {
        rule.setHappyContent { ViewersRow(emptyList(), people, editors = listOf(ViewersEditor("Anna", Color.Red)), clock = { now }) }
        rule.node(ViewersTags.SLOT).performClick()
        rule.onNodeWithText("Anna").assertExists()
    }
}
