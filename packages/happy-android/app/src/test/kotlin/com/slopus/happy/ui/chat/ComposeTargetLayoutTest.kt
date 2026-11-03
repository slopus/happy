package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.Ionicon
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
 * A Happy account's new work (happy-ios NewWorkLayout(givingWay:),
 * NewWorkStatusLayout): the kind 220 wide, 16 over 44 rows 8 apart, 10 over
 * the note, centred in its room; short of room the note goes first, then
 * the gaps close to 14 and 6. The computer row's chip is 18 high, ends 16
 * from the row's end and rises 9 over its top, as wide as its words and at
 * most 150, taking no part in the row's layout.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposeTargetLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(room: Dp, status: NewWorkStatus? = NewWorkStatus("● Online", Color.Green), note: Boolean = true) = rule.setHappyContent {
        Box(Modifier.fillMaxWidth().height(room).testTag(ROOM)) {
            NewWorkGivingWay(
                shown = true,
                kind = {
                    NewWorkSegments(
                        labels = listOf("Session", "Bot", "Task"),
                        selected = 0,
                        enabled = true,
                        tag = { "kind.$it" },
                        onPick = {},
                        segmentEnabled = { it != 2 },
                    )
                },
                rows = listOf<@Composable () -> Unit>(
                    { NewWorkMenuRow(Ionicon.DesktopOutline, "MacBook-Pro.local", true, {}, Modifier.testTag(NewWorkTags.MACHINE), status = status) },
                    { NewWorkMenuRow(Ionicon.FolderOutline, "~/repo", true, {}, Modifier.testTag(NewWorkTags.FOLDER)) },
                ),
                note = if (note) { { Text("What a bot is, on one line.", Modifier.testTag(NewWorkTags.NOTE)) } } else null,
            )
        }
    }

    @Test fun `with room the block stands centred, 24 in and 320 wide`() {
        show(600.dp)
        val room = rule.node(ROOM).bounds
        val kind = rule.node(NewWorkTags.KIND).bounds
        val machine = rule.node(NewWorkTags.MACHINE).bounds
        val folder = rule.node(NewWorkTags.FOLDER).bounds
        val note = rule.node(NewWorkTags.NOTE).bounds
        assertDp("kind 220", 220, kind.width)
        assertDp("row 320", 320, machine.width)
        assertDp("centred across", ((411 - 320) / 2f).dp, machine.left)
        assertDp("row 44", 44, machine.height)
        assertDp("16 under the kind", kind.bottom + 16.dp, machine.top)
        assertDp("8 between rows", machine.bottom + 8.dp, folder.top)
        assertDp("10 over the note", folder.bottom + 10.dp, note.top)
        assertEquals("centred in its room", ((room.top + room.bottom) / 2).value, ((kind.top + note.bottom) / 2).value, 1f)
    }

    @Test fun `the chip rides the computer row's top-right corner`() {
        show(600.dp)
        val machine = rule.node(NewWorkTags.MACHINE).bounds
        val chip = rule.node(NewWorkTags.MACHINE_STATUS).bounds
        assertDp("18 high", 18, chip.height)
        assertDp("rises 9 over the row", machine.top - 9.dp, chip.top)
        assertDp("16 from the row's end", machine.right - 16.dp, chip.right)
        assertTrue("as wide as its words", chip.width < 150.dp && chip.width > 30.dp)
    }

    @Test fun `the chip takes no part in the row's layout`() {
        show(600.dp, status = null)
        val without = rule.node(NewWorkTags.MACHINE).bounds
        rule.node(NewWorkTags.MACHINE_STATUS).assertDoesNotExist()
        assertDp("row 44 without a chip", 44, without.height)
    }

    @Test fun `a long status is cut at 150`() {
        show(600.dp, status = NewWorkStatus("● Happy Agent offline, and a great deal more besides", Color.Red))
        assertDp("at most 150", 150, rule.node(NewWorkTags.MACHINE_STATUS).bounds.width)
    }

    @Test fun `a kind no computer makes shows but takes no press`() {
        show(600.dp)
        rule.node("kind.1").assertIsEnabled()
        rule.node("kind.2").assertIsNotEnabled()
    }

    @Test fun `short of room the note goes first`() {
        // kind 32 + 16 + 44 + 8 + 44 = 144, the note's 10 and its line on top; margins 12 each.
        show(176.dp)
        val kind = rule.node(NewWorkTags.KIND).bounds
        val machine = rule.node(NewWorkTags.MACHINE).bounds
        assertDp("the gaps kept", kind.bottom + 16.dp, machine.top)
        val placed = rule.onAllNodes(hasTestTag(NewWorkTags.NOTE), useUnmergedTree = true).fetchSemanticsNodes().single()
        assertTrue("the note is there, unseen", placed.layoutInfo.isPlaced)
    }

    @Test fun `with less room still the gaps close`() {
        show(160.dp, note = false)
        val kind = rule.node(NewWorkTags.KIND).bounds
        val machine = rule.node(NewWorkTags.MACHINE).bounds
        val folder = rule.node(NewWorkTags.FOLDER).bounds
        assertDp("14 under the kind, clear of the chip", kind.bottom + 14.dp, machine.top)
        assertDp("6 between rows", machine.bottom + 6.dp, folder.top)
    }

    private companion object {
        const val ROOM = "room"
    }
}
