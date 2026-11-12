package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.resolveNewSessionOptions
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Bots in the focused dock, against HomeDock.tsx (Android branch):
 * - Session | Bot heads the screen only when the computer's Happy Agent
 *   publishes `capabilities.bots`; the segments are radios, the picked one
 *   selected.
 * - Making a bot keeps only the MACHINE row, and no face is offered: the
 *   bot wears the placeholder its ID picks, as any bot without a picture.
 * - The input names the bot ("Name your bot"); no add-image button, no
 *   permission, model or effort; the primary button reads "Create bot"
 *   and works only with a name the daemon accepts.
 * - Every action reads for TalkBack.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeDockBotTest {
    @get:Rule
    val rule = createComposeRule()

    private val botRig = machine(
        "b1",
        machineMetadata {
            put("machineKind", "rig")
            putJsonObject("capabilities") { put("newSession", true); put("bots", true) }
        },
    )

    private val kinds = mutableListOf<Boolean>()
    private val names = mutableListOf<String>()
    private var submits = 0
    private val actions = HomeDockActions(
        onPromptChange = {}, onFocusChange = {}, onSubmit = { submits++ }, onCancel = {},
        onSelect = { _, _ -> }, onOpenPicker = {}, onHarnessHelp = {},
        onBotKindChange = { kinds += it }, onBotNameChange = { names += it },
    )

    private fun state(creating: Boolean, name: String = "") =
        HomeDockState(
            prompt = "a prompt",
            options = resolveNewSessionOptions(NewSessionDraft(selectedMachineId = "b1"), listOf(botRig), emptyList(), AgentDefaultOverrides()),
            labels = NewSessionLabels(),
            phase = null,
            focused = true,
            canAttachImages = !creating,
            bot = HomeDockBot(creating, name),
        )

    private fun show(state: HomeDockState) {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent { Box(Modifier.fillMaxSize()) { HomeDockFocus(state, actions) } }
        rule.mainClock.advanceTimeBy(1000)
    }

    @Test
    fun aSessionComposerOffersBotsAboveIt() {
        show(state(creating = false))
        rule.node(BotKindTags.kind(false)).assert(hasRole(Role.RadioButton)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        rule.node(BotKindTags.kind(true)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        rule.node(BotKindTags.LEDE).assertDoesNotExist()
        rule.node(HomeDockTags.row(NewSessionPage.Project)).assertIsDisplayed()
        rule.node(BotKindTags.kind(true)).performClick()
        assertEquals(listOf(true), kinds)
        rule.assertActionsLabelled()
    }

    @Test
    fun makingABotTakesOnlyAName() {
        show(state(creating = true))
        rule.node(BotKindTags.LEDE).assertIsDisplayed()
        rule.node(HomeDockTags.row(NewSessionPage.Machine)).assertIsDisplayed()
        rule.node(HomeDockTags.row(NewSessionPage.Project)).assertDoesNotExist()
        rule.node(HomeDockTags.ADD_IMAGE).assertDoesNotExist()
        rule.node(HomeDockTags.PERMISSION).assertDoesNotExist()
        rule.node(HomeDockTags.MODEL).assertDoesNotExist()
        rule.onNodeWithText("Name your bot", useUnmergedTree = true).assertIsDisplayed()
        rule.node(HomeDockTags.PRIMARY).assert(hasContentDescription("Create bot")).assertIsNotEnabled()
        rule.onNode(hasContentDescription("Face 1"), useUnmergedTree = true).assertDoesNotExist()
        rule.onNodeWithText("Art by", substring = true, useUnmergedTree = true).assertDoesNotExist()

        rule.node(HomeDockTags.INPUT).performTextReplacement("Release\nBot")
        assertEquals(listOf("Release Bot"), names)
        rule.assertActionsLabelled()
    }

    @Test
    fun aGoodNameCreatesTheBot() {
        show(state(creating = true, name = "Ada"))
        rule.node(HomeDockTags.PRIMARY).assertIsEnabled().performClick()
        assertEquals(1, submits)
    }
}
