package com.slopus.happy.ui.bots

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.BotEditForm
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A personal bot's settings: the picture, the name and the instructions, Save once something changed. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BotSettingsTest {
    @get:Rule val rule = createComposeRule()

    private val form = BotEditForm.of(
        kotlinx.serialization.json.buildJsonObject {
            put("name", kotlinx.serialization.json.JsonPrimitive("Researcher"))
            put("instructions", kotlinx.serialization.json.JsonPrimitive("Read papers."))
        },
    )

    @Test
    fun thePictureNameAndInstructionsStackUnderTheBarAndSaveWaitsForAChange() {
        val done = mutableListOf<String>()
        var state by mutableStateOf(BotSettingsState("research", form))
        rule.setHappyContent {
            BotSettingsScreen(
                state, photo = null,
                onEdit = { change -> state = state.copy(form = change(state.form!!)) },
                onSave = { done += "save" },
                onChangePhoto = { done += "photo" },
                onRemovePhoto = { done += "remove" },
                onBack = { done += "back" },
            )
        }
        val picture = rule.node(BotSettingsTags.PICTURE).bounds
        assertBox("picture", picture, ((PHONE_WIDTH - 100) / 2f).dp, (64 + 16).dp + GlassSpec.feather, 100.dp, 100.dp)
        val change = rule.node(BotSettingsTags.CHANGE_PHOTO).bounds
        assertDp("Change Photo 8 under", picture.bottom + 8.dp, change.top)
        val name = rule.node(BotSettingsTags.NAME).bounds
        val instructions = rule.node(BotSettingsTags.INSTRUCTIONS).bounds
        assertTrue("the name above the instructions", name.bottom < instructions.top)
        // A text field's tag reads its text's box, inside the field's own insets.
        assertDp("the instructions 160 high", 160.dp - ItemSpec.paddingVertical * 2, instructions.bottom - instructions.top)
        rule.onNodeWithText("Read papers.").assertIsDisplayed()
        // Without a picture there is nothing to remove.
        rule.onNodeWithText("Remove Photo").assertDoesNotExist()

        rule.node(BotSettingsTags.SAVE).assertIsNotEnabled()
        rule.node(BotSettingsTags.INSTRUCTIONS).performTextReplacement("Read papers. Cite them.")
        rule.node(BotSettingsTags.SAVE).assertIsEnabled().performClick()
        assertEquals("Read papers. Cite them.", state.form!!.instructions)

        // A blank name can't go, and its card says why.
        rule.node(BotSettingsTags.NAME).performTextReplacement("  ")
        rule.node(BotSettingsTags.SAVE).assertIsNotEnabled()
        rule.onNodeWithText("A bot needs a name.").performScrollTo().assertIsDisplayed()

        rule.node(BotSettingsTags.CHANGE_PHOTO).performClick()
        assertEquals(listOf("save", "photo"), done)
    }

    @Test
    fun backWithUnsavedChangesAsksFirst() {
        var left = 0
        var state by mutableStateOf(BotSettingsState("research", form))
        rule.setHappyContent {
            BotSettingsScreen(state, null, { change -> state = state.copy(form = change(state.form!!)) }, {}, {}, {}, { left++ })
        }
        rule.node(BotSettingsTags.NAME).performTextReplacement("Scholar")
        rule.node(com.slopus.happy.ui.components.HeaderTags.LEFT).performClick()
        rule.onNodeWithText("Discard your changes?").assertIsDisplayed()
        assertEquals(0, left)
        rule.onNodeWithText("Discard").performClick()
        assertEquals(1, left)
    }

    @Test
    fun aPictureCanBeRemovedAndABotNoLongerEditableReadsOnly() {
        val done = mutableListOf<String>()
        var state by mutableStateOf(BotSettingsState("research", form, picture = "/v0/bots/research/avatar", thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"))
        rule.setHappyContent { BotSettingsScreen(state, null, {}, {}, {}, { done += "remove" }, {}) }
        rule.onNodeWithText("Remove Photo").performScrollTo().performClick()
        assertEquals(listOf("remove"), done)
        state = state.copy(editable = false)
        rule.waitForIdle()
        rule.node(BotSettingsTags.SAVE).assertDoesNotExist()
        rule.node(BotSettingsTags.CHANGE_PHOTO).assertDoesNotExist()
        rule.onNodeWithText("Remove Photo").assertDoesNotExist()
    }

    @Test
    fun untilTheBotIsReadASpinner() {
        rule.setHappyContent { BotSettingsScreen(BotSettingsState("research"), null, {}, {}, {}, {}, {}) }
        rule.node(BotSettingsTags.LOADING).assertExists()
        rule.node(BotSettingsTags.NAME).assertDoesNotExist()
    }
}
