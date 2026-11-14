package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
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
import com.slopus.happy.ui.components.StateArt
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
 * NewWorkStatusLayout), at most 256 wide, top to bottom: the picture 16
 * over the kind 220 wide, 16 over the note, 16 over 44 rows 8 apart,
 * centred in its room; as Happy Agent's new work, short of room nothing
 * closes or shrinks: the block stands 12 over the composer and runs up
 * under the bar, picture first. Laid out with a picture's and
 * three rows' room kept, the kind holds still whatever the kind shows. The
 * computer row's chip is 18 high, ends 16 from the row's end and rises 9
 * over its top, as wide as its words and at most 150, taking no part in the
 * row's layout.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposeTargetLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    /** What a kind shows: its picture and how many rows. */
    private data class Shown(val art: StateArt?, val rows: Int)

    private fun show(
        room: Dp,
        status: NewWorkStatus? = NewWorkStatus("● Online", Color.Green),
        note: Boolean = true,
        art: StateArt? = null,
        shown: MutableState<Shown> = mutableStateOf(Shown(art, 2)),
        reserve: Boolean = false,
    ) = rule.setHappyContent {
        val (picture, count) = shown.value
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
                    { NewWorkMenuRow(Ionicon.DesktopOutline, "MacBook-Pro.local", true, {}, 90.dp, Modifier.testTag(NewWorkTags.MACHINE), status = status) },
                    { NewWorkMenuRow(Ionicon.FolderOutline, "~/repo", true, {}, 90.dp, Modifier.testTag(NewWorkTags.FOLDER)) },
                    { NewWorkMenuRow(Ionicon.HardwareChipOutline, "Claude", true, {}, 90.dp, Modifier.testTag(NewWorkTags.HARNESS)) },
                ).take(count),
                note = if (note) { { Text("What a bot is.", Modifier.fillMaxWidth().height(18.dp).testTag(NewWorkTags.NOTE)) } } else null,
                art = picture,
                reserveArt = reserve,
                reserveRows = if (reserve) 3 else 0,
            )
        }
    }

    @Test fun `with room the block stands centred, 24 in and 256 wide`() {
        show(600.dp)
        val room = rule.node(ROOM).bounds
        val kind = rule.node(NewWorkTags.KIND).bounds
        val machine = rule.node(NewWorkTags.MACHINE).bounds
        val folder = rule.node(NewWorkTags.FOLDER).bounds
        val note = rule.node(NewWorkTags.NOTE).bounds
        assertDp("kind 220", 220, kind.width)
        assertDp("row 256", 256, machine.width)
        assertDp("centred across", ((411 - 256) / 2f).dp, machine.left)
        assertDp("the note as wide", 256, note.width)
        assertDp("row 44", 44, machine.height)
        assertDp("16 under the kind", kind.bottom + 16.dp, note.top)
        assertDp("16 over the rows", note.bottom + 16.dp, machine.top)
        assertDp("8 between rows", machine.bottom + 8.dp, folder.top)
        assertEquals("centred in its room", ((room.top + room.bottom) / 2).value, ((kind.top + folder.bottom) / 2).value, 1f)
    }

    @Test fun `the kind holds still as the picture and the rows come and go`() {
        val shown = mutableStateOf(Shown(null, 3))
        show(600.dp, shown = shown, reserve = true)
        val session = rule.node(NewWorkTags.KIND).bounds
        val note = rule.node(NewWorkTags.NOTE).bounds
        val machine = rule.node(NewWorkTags.MACHINE).bounds
        for (each in listOf(Shown(StateArt.Ready, 2), Shown(StateArt.Action, 1), Shown(null, 3))) {
            shown.value = each
            rule.waitForIdle()
            assertEquals("kind at $each", session, rule.node(NewWorkTags.KIND).bounds)
            assertEquals("note at $each", note, rule.node(NewWorkTags.NOTE).bounds)
            assertEquals("computer at $each", machine, rule.node(NewWorkTags.MACHINE).bounds)
        }
        shown.value = Shown(StateArt.Ready, 2)
        rule.waitForIdle()
        val room = rule.node(ROOM).bounds
        val art = rule.node(NewWorkTags.art(StateArt.Ready)).bounds
        // The picture's room and three rows': 144 + 32 + 16 + 18 + 16 + 3 × 44 + 2 × 8 = 374, centred.
        assertEquals("centred at its tallest", ((room.top + room.bottom) / 2).value, (art.top + 187.dp).value, 1f)
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

    @Test fun `a bot stands under the robot, 16 over the kind, centred with the block`() {
        show(600.dp, art = StateArt.Ready)
        val room = rule.node(ROOM).bounds
        val art = rule.node(NewWorkTags.art(StateArt.Ready)).bounds
        val kind = rule.node(NewWorkTags.KIND).bounds
        val folder = rule.node(NewWorkTags.FOLDER).bounds
        assertDp("an empty state's 128", 128, art.width)
        assertDp("square", art.width, art.height)
        assertDp("centred across", ((411 - 128) / 2f).dp, art.left)
        assertDp("16 over the kind", art.bottom + 16.dp, kind.top)
        assertEquals("centred in its room", ((room.top + room.bottom) / 2).value, ((art.top + folder.bottom) / 2).value, 1f)
    }

    @Test fun `short of room nothing shrinks or closes, the block stands on the composer and runs up, picture first`() {
        // The picture and its gap, 144, over kind 32 + 16 + 18 + 16 + 44 + 8 + 44 = 178; 12 over the composer: 20 short.
        show(144.dp + 178.dp + 12.dp - 20.dp, art = StateArt.Action)
        val room = rule.node(ROOM).bounds
        val art = rule.node(NewWorkTags.art(StateArt.Action)).bounds
        val kind = rule.node(NewWorkTags.KIND).bounds
        val note = rule.node(NewWorkTags.NOTE).bounds
        val machine = rule.node(NewWorkTags.MACHINE).bounds
        assertDp("never smaller", 128, art.width)
        assertDp("16 over the kind", art.bottom + 16.dp, kind.top)
        assertDp("16 under the kind", kind.bottom + 16.dp, note.top)
        assertDp("16 over the rows", note.bottom + 16.dp, machine.top)
        assertDp("8 between rows", machine.bottom + 8.dp, rule.node(NewWorkTags.FOLDER).bounds.top)
        assertDp("12 over the composer", room.bottom - 12.dp, rule.node(NewWorkTags.FOLDER).bounds.bottom)
        assertDp("the picture runs under the bar", room.top - 20.dp, art.top)
    }

    @Test fun `with no room the whole block stands on the composer, its top under the bar`() {
        show(200.dp, art = StateArt.Action, note = false)
        val room = rule.node(ROOM).bounds
        val art = rule.node(NewWorkTags.art(StateArt.Action)).bounds
        assertDp("never smaller", 128, art.width)
        assertDp("12 over the composer", room.bottom - 12.dp, rule.node(NewWorkTags.FOLDER).bounds.bottom)
        assertDp("16 under the kind, clear of the chip", rule.node(NewWorkTags.KIND).bounds.bottom + 16.dp, rule.node(NewWorkTags.MACHINE).bounds.top)
        assertTrue("above the room: $art, $room", art.top < room.top)
    }

    private companion object {
        const val ROOM = "room"
    }
}
