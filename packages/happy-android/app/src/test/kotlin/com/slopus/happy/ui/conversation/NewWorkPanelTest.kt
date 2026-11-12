package com.slopus.happy.ui.conversation

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.NewWork
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.conversation.WorkKind
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.NewWorkSpec
import com.slopus.happy.ui.chat.NewWorkTags
import com.slopus.happy.ui.chat.PrimaryAction
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

private const val BOT_NOTE = "A bot is like a colleague: one lasting conversation with a folder of its own. Give it a name, then tell it what to do."

/**
 * New work's Task or Bot (happy-ios NewWorkPanel `.work`, NewWorkLayout):
 * one block 24 in from either side and at most 320 wide, centred between
 * the bar and the composer, under the kind's picture 16 over it; the kind
 * 220 wide. A task goes with a blank name, 16 under the kind saying what a task is; a bot's
 * kind stands 16 over a 44 name, 10 over the line saying what a bot is. It
 * fades once the work is made.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NewWorkPanelTest {
    @get:Rule
    val rule = createComposeRule()

    private var state by mutableStateOf(ConversationState(created = false, loaded = true, newWork = NewWork(WorkChoice())))
    private val choices = mutableListOf<WorkChoice>()

    private fun show() = rule.setHappyContent {
        ConversationScreen(
            state,
            ConversationScreenActions(onChoiceChange = { choice ->
                choices += choice
                state = state.copy(newWork = NewWork(choice))
            }),
        )
    }

    @Test fun `a task is its picture over the kind, centred between the bar and the composer, at most 320 wide`() {
        show()
        val panel = rule.node(NewWorkTags.PANEL).bounds
        assertDp("320 wide", 320, panel.width)
        assertDp("centred across", ((411 - 320) / 2f).dp, panel.left)
        val art = rule.node(NewWorkTags.art(StateArt.Action)).bounds
        assertDp("an empty state's 128", NewWorkSpec.art, art.width)
        assertDp("square", art.width, art.height)
        assertDp("over the middle", panel.left + (320.dp - art.width) / 2, art.left)
        val kind = rule.node(NewWorkTags.KIND).bounds
        assertDp("16 over the kind", art.bottom + 16.dp, kind.top)
        assertDp("kind 220", 220, kind.width)
        assertDp("kind centred", panel.left + 50.dp, kind.left)
        val bar = rule.node(ConversationScreenTags.BAR).bounds
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertEquals("centred between the bar and the composer", ((bar.bottom + composer.top) / 2).value, ((art.top + panel.bottom) / 2).value, 1f)
        // A task asks no name; 16 under the kind it says what a task is.
        rule.node(NewWorkTags.NAME_FIELD).assertDoesNotExist()
        val note = rule.node(NewWorkTags.NOTE)
        note.assertTextEquals("A task is for one-off work. It can work across several projects and start subtasks of its own.")
        assertDp("16 under the kind", kind.bottom + 16.dp, note.bounds.top)
        rule.onNodeWithText(BOT_NOTE).assertDoesNotExist()
        assertTrue("a bot's room kept under the kind", panel.bottom > kind.bottom + 16.dp + 44.dp)
        // The old empty line gives way to the panel.
        rule.node(ConversationScreenTags.EMPTY).assertDoesNotExist()
    }

    @Test fun `a bot asks its name under the kind, and says what it is`() {
        state = state.copy(newWork = NewWork(WorkChoice(WorkKind.Bot)))
        show()
        val panel = rule.node(NewWorkTags.PANEL).bounds
        val art = rule.node(NewWorkTags.art(StateArt.Ready)).bounds
        val kind = rule.node(NewWorkTags.KIND).bounds
        assertDp("16 over the kind", art.bottom + 16.dp, kind.top)
        val name = rule.node(NewWorkTags.NAME_FIELD).bounds
        assertDp("16 under the kind", kind.bottom + 16.dp, name.top)
        assertDp("name full width", 320, name.width)
        assertDp("name 44", 44, name.height)
        val note = rule.node(NewWorkTags.NOTE).bounds
        assertDp("10 under the name", name.bottom + 10.dp, note.top)
        assertDp("the note ends the block", panel.bottom, note.bottom)
    }

    @Test fun `Task and Bot stand in the same place, a task keeping a bot's room empty`() {
        show()
        fun places(art: StateArt) = listOf(
            rule.node(NewWorkTags.PANEL).bounds,
            rule.node(NewWorkTags.art(art)).bounds,
            rule.node(NewWorkTags.KIND).bounds,
            rule.node(ConversationComposerTags.COMPOSER).bounds,
        )
        val task = places(StateArt.Action)
        rule.node(NewWorkTags.kind(WorkKind.Bot)).performClick()
        rule.waitForIdle()
        assertEquals("Task to Bot", task, places(StateArt.Ready))
        rule.node(NewWorkTags.kind(WorkKind.Task)).performClick()
        rule.waitForIdle()
        assertEquals("back to Task", task, places(StateArt.Action))
    }

    @Test
    @Config(qualifiers = "w411dp-h420dp-xxhdpi")
    fun `short of room the picture keeps its size and the block shifts up, alike for Task and Bot`() {
        show()
        val task = rule.node(NewWorkTags.art(StateArt.Action)).bounds
        assertDp("never smaller", NewWorkSpec.art, task.width)
        val kind = rule.node(NewWorkTags.KIND).bounds
        val panel = rule.node(NewWorkTags.PANEL).bounds
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertTrue("over the composer: $panel, $composer", panel.bottom <= composer.top)
        rule.node(NewWorkTags.kind(WorkKind.Bot)).performClick()
        rule.waitForIdle()
        assertEquals(task, rule.node(NewWorkTags.art(StateArt.Ready)).bounds)
        assertEquals(kind, rule.node(NewWorkTags.KIND).bounds)
    }

    @Test fun `Bot and a name are handed on as picked, and the line follows the kind`() {
        show()
        rule.node(NewWorkTags.kind(WorkKind.Task)).assertIsSelected()
        rule.node(NewWorkTags.kind(WorkKind.Bot)).performClick()
        rule.waitForIdle()
        rule.node(NewWorkTags.kind(WorkKind.Bot)).assertIsSelected()
        rule.node(NewWorkTags.kind(WorkKind.Task)).assertIsNotSelected()
        rule.node(NewWorkTags.NOTE).assertTextEquals(BOT_NOTE)
        rule.node(NewWorkTags.art(StateArt.Ready)).assertExists()
        rule.node(NewWorkTags.art(StateArt.Action)).assertDoesNotExist()
        rule.node(NewWorkTags.NAME).performTextInput("Release Bot")
        rule.waitForIdle()
        assertEquals(WorkChoice(WorkKind.Bot, "Release Bot"), choices.last())
        // Back to a task: it goes with a blank name, whatever was typed for the bot.
        rule.node(NewWorkTags.kind(WorkKind.Task)).performClick()
        rule.waitForIdle()
        assertEquals(WorkChoice(WorkKind.Task, ""), choices.last())
        rule.node(NewWorkTags.NAME_FIELD).assertDoesNotExist()
        rule.node(NewWorkTags.art(StateArt.Action)).assertExists()
    }

    @Test fun `Return in the name goes on to the composer`() {
        state = state.copy(newWork = NewWork(WorkChoice(WorkKind.Bot)))
        show()
        rule.node(NewWorkTags.NAME).performTextInput("Notes")
        rule.node(NewWorkTags.NAME).performImeAction()
        rule.waitForIdle()
        rule.node(ConversationComposerTags.INPUT).assertIsFocused()
    }

    @Test fun `once a first message is in nothing changes the work and Send still goes`() {
        state = state.copy(newWork = NewWork(WorkChoice(WorkKind.Bot, "B"), locked = true))
        show()
        rule.node(NewWorkTags.kind(WorkKind.Task)).assertIsNotEnabled()
        rule.node(NewWorkTags.NAME).assertIsNotEnabled()
        assertEquals(PrimaryAction.Send, primaryActionOf(hasContent = true, state))
    }

    @Test fun `once made the panel fades and the composer stays clear`() {
        state = state.copy(draft = "Ship it", draftArrivals = 1)
        show()
        rule.node(ConversationComposerTags.INPUT).assertTextEquals("Ship it")
        rule.mainClock.autoAdvance = false
        state = state.copy(created = true, newWork = null, draft = "", draftArrivals = 2)
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(NewWorkSpec.FADE_MILLIS / 2L)
        // Still fading out.
        rule.node(NewWorkTags.PANEL).assertExists()
        rule.mainClock.advanceTimeBy(NewWorkSpec.FADE_MILLIS.toLong() + 100)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.node(NewWorkTags.PANEL).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).assertTextEquals("")
    }

    @Test fun `new work's first message is drawn at once, and the chat it becomes never says it is empty`() {
        show()
        rule.mainClock.autoAdvance = false
        val sent = ConversationRow.User("s:user", "s", "Plain first", parseMarkdown("Plain first"), emptyList(), Delivery.Sending)
        state = state.copy(newWork = NewWork(WorkChoice(), locked = true), rows = listOf(sent))
        Snapshot.sendApplyNotifications()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        rule.onNodeWithText("Plain first").assertExists()
        // Made while the transcript still fades in over the empty page.
        state = state.copy(created = true, newWork = null)
        Snapshot.sendApplyNotifications()
        repeat(30) {
            rule.mainClock.advanceTimeBy(16)
            rule.node(ConversationScreenTags.EMPTY).assertDoesNotExist()
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithText("Plain first").assertIsDisplayed()
        rule.node(ConversationScreenTags.EMPTY).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "w411dp-h260dp-xxhdpi")
    fun `with no room between the bar and the composer the block stands on the composer, running up under the bar`() {
        state = state.copy(newWork = NewWork(WorkChoice(WorkKind.Bot)))
        show()
        val art = rule.node(NewWorkTags.art(StateArt.Ready)).bounds
        val panel = rule.node(NewWorkTags.PANEL).bounds
        val bar = rule.node(ConversationScreenTags.BAR).bounds
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertDp("the picture never goes or shrinks", NewWorkSpec.art, art.width)
        assertEquals("12 over the composer", (composer.top - 12.dp).value, panel.bottom.value, 1f)
        assertTrue("under the bar: $art, $bar", art.top < bar.bottom)
    }

    @Test fun `the block is 24 in on a narrow screen`() {
        assertDp("narrow", 312, NewWorkSpec.blockWidth(360.dp))
        assertDp("wide", 320, NewWorkSpec.blockWidth(900.dp))
    }
}
