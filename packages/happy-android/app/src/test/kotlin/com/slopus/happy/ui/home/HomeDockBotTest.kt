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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.BOT_FACE_STYLE_ASSET
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.resolveNewSessionOptions
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Bots in the focused dock, against HomeDock.tsx and BotFacePicker.tsx
 * (Android branch):
 * - Session | Bot heads the screen only when the computer's Happy Agent
 *   publishes `capabilities.bots`; the segments are radios, the picked one
 *   selected.
 * - Making a bot keeps only the MACHINE row; the faces take the other
 *   rows' place: four faces 10 apart, at most 52 square, the 40 die after
 *   them, "Art by Lisa Wischofsky" under them.
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
    private val faces = BotFaces { File("src/main/assets/$BOT_FACE_STYLE_ASSET").readText() }
    private val seeds = listOf("abc12345", "k3j9x0aa", "zzzzzzzz", "happy")

    private val kinds = mutableListOf<Boolean>()
    private val names = mutableListOf<String>()
    private val picks = mutableListOf<Int>()
    private var rolls = 0
    private var submits = 0
    private val actions = HomeDockActions(
        onPromptChange = {}, onFocusChange = {}, onSubmit = { submits++ }, onCancel = {},
        onSelect = { _, _ -> }, onOpenPicker = {}, onHarnessHelp = {},
        onBotKindChange = { kinds += it }, onBotNameChange = { names += it },
        onBotFacePick = { picks += it }, onBotFacesRoll = { rolls++ },
    )

    private fun state(creating: Boolean, name: String = "") = runBlocking {
        val style = faces.style()
        HomeDockState(
            prompt = "a prompt",
            options = resolveNewSessionOptions(NewSessionDraft(selectedMachineId = "b1"), listOf(botRig), emptyList(), AgentDefaultOverrides()),
            labels = NewSessionLabels(),
            phase = null,
            focused = true,
            canAttachImages = !creating,
            bot = HomeDockBot(creating, name, seeds.map { faces.picture(it) }, slot = 1, style.artist, style.artistUrl),
        )
    }

    private fun show(state: HomeDockState) {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent { Box(Modifier.fillMaxSize()) { HomeDockFocus(state, actions) } }
        rule.mainClock.advanceTimeBy(1000)
    }

    @Test
    fun aSessionComposerOffersBotsAboveIt() {
        show(state(creating = false))
        rule.node(BotFaceTags.kind(false)).assert(hasRole(Role.RadioButton)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        rule.node(BotFaceTags.kind(true)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        rule.node(BotFaceTags.LEDE).assertDoesNotExist()
        rule.node(HomeDockTags.row(NewSessionPage.Project)).assertIsDisplayed()
        rule.node(BotFaceTags.PICKER).assertDoesNotExist()
        rule.node(BotFaceTags.kind(true)).performClick()
        assertEquals(listOf(true), kinds)
        rule.assertActionsLabelled()
    }

    @Test
    fun makingABotTakesANameAndAFace() {
        show(state(creating = true))
        rule.node(BotFaceTags.LEDE).assertIsDisplayed()
        rule.node(HomeDockTags.row(NewSessionPage.Machine)).assertIsDisplayed()
        rule.node(HomeDockTags.row(NewSessionPage.Project)).assertDoesNotExist()
        rule.node(HomeDockTags.ADD_IMAGE).assertDoesNotExist()
        rule.node(HomeDockTags.PERMISSION).assertDoesNotExist()
        rule.node(HomeDockTags.MODEL).assertDoesNotExist()
        rule.onNodeWithText("Name your bot", useUnmergedTree = true).assertIsDisplayed()
        rule.node(HomeDockTags.PRIMARY).assert(hasContentDescription("Create bot")).assertIsNotEnabled()

        val first = rule.node(BotFaceTags.face(0)).bounds
        val second = rule.node(BotFaceTags.face(1)).bounds
        val die = rule.node(BotFaceTags.DIE).bounds
        assertDp("face at most 52", 52, first.width)
        assertDp("faces 10 apart", first.right + 10.dp, second.left)
        assertDp("die 10 after the last face", rule.node(BotFaceTags.face(3)).bounds.right + 10.dp, die.left)
        assertDp("die 40", 40, die.width)
        rule.node(BotFaceTags.face(1)).assert(hasRole(Role.RadioButton)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        rule.node(BotFaceTags.face(0)).assert(hasContentDescription("Face 1"))
        rule.onNodeWithText("Art by Lisa Wischofsky", useUnmergedTree = true).assertIsDisplayed()

        rule.node(BotFaceTags.face(2)).performClick()
        rule.node(BotFaceTags.DIE).performClick()
        rule.node(HomeDockTags.INPUT).performTextReplacement("Release\nBot")
        assertEquals(listOf(2), picks)
        assertEquals(1, rolls)
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
