package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ComposerModeResolver
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.sync.SessionComposerTest
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.PickerSheetTags
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerPickerLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val metadata = requireNotNull(SessionMetadata.parse(SessionComposerTest.RIG_METADATA_FIXTURE))

    private fun modes(mirror: ComposerMirror = ComposerMirror(), metadata: SessionMetadata? = this.metadata): ComposerModes =
        ComposerModeResolver.resolve(metadata, mirror, null) { RuntimeEnvironment.getApplication().getString(it) }

    private fun showComposer(modes: ComposerModes, onSelect: (AgentModeField, ModeOption) -> Unit = { _, _ -> }) {
        rule.setHappyContent {
            ChatComposer(
                text = "",
                onTextChange = {},
                status = null,
                primary = PrimaryAction.Idle,
                onPrimary = {},
                middle = { ComposerModeChips(modes, metadata, onSelect) },
            )
        }
    }

    // [permission ......... model · effort] [send]: 2 apart, 40 high in the 42 row.
    @Test
    fun chipsFillTheActionRowMiddle() {
        showComposer(modes())
        val row = rule.node(ComposerTags.ACTION_ROW).bounds
        val primary = rule.node(ComposerTags.PRIMARY).bounds
        val permission = rule.node(ComposerPickerTags.PERMISSION).bounds
        assertDp("permission at the row start", row.left, permission.left)
        assertDp("permission 40 high", 40, permission.height)
        assertDp("centred in the 42 row", row.top + 1.dp, permission.top)
        rule.onNodeWithText("Auto", useUnmergedTree = true).assertExists()

        val effort = rule.node(ComposerPickerTags.EFFORT).bounds
        // The middle ends 10 before send: the 8 margin plus the row's 2 gap.
        assertBox("effort", effort, primary.left - 10.dp - 64.dp, row.top + 1.dp, 64.dp, 40.dp)
        rule.onNodeWithText("High", useUnmergedTree = true).assertExists()
        val separator = rule.node(ComposerPickerTags.SEPARATOR).bounds
        assertDp("separator 2 before effort", effort.left - 2.dp, separator.right)
        val model = rule.node(ComposerPickerTags.MODEL).bounds
        assertDp("model 2 before the separator", separator.left - 2.dp, model.right)
        assertDp("model 40 high", 40, model.height)
        rule.onNodeWithText("GPT Shared", useUnmergedTree = true).assertExists()
    }

    @Test
    fun aLockedModelChipCannotOpen() {
        showComposer(modes().copy(canChangeModel = false, canChangePermission = false, canChangeEffort = false))
        rule.node(ComposerPickerTags.PERMISSION).assertDoesNotExist()
        rule.node(ComposerPickerTags.EFFORT).assertDoesNotExist()
        rule.node(ComposerPickerTags.MODEL).assertIsNotEnabled()
        // With nothing else in the row the model still sits against send.
        val primary = rule.node(ComposerTags.PRIMARY).bounds
        assertDp("model against send", primary.left - 10.dp, rule.node(ComposerPickerTags.MODEL).bounds.right)
    }

    @Test
    fun theModelSheetGroupsByProviderAndPicks() {
        val picks = mutableListOf<Pair<AgentModeField, String>>()
        showComposer(modes()) { field, option -> picks += field to option.key }
        rule.node(ComposerPickerTags.MODEL).performClick()
        rule.waitForIdle()
        rule.node(PickerSheetTags.PANEL).assertExists()
        rule.onNodeWithText("MODEL", useUnmergedTree = true).assertExists()
        rule.node(PickerSheetTags.section("codex")).assertExists()
        rule.node(PickerSheetTags.section("claude")).assertExists()
        // The provider's 16 icon, 8 before its name, 24 in.
        assertDp("heading after the icon", 24 + 16 + 8, rule.onNodeWithText("OpenAI Codex", useUnmergedTree = true).bounds.left)
        val first = rule.node(PickerSheetTags.option("codex:shared-model")).bounds
        val second = rule.node(PickerSheetTags.option("claude:shared-model")).bounds
        assertDp("option at least 56 high", 56, first.height)
        // A rule and the second provider's heading lie between them.
        assertEquals(true, second.top > first.bottom)
        rule.node(PickerSheetTags.option("claude:shared-model")).performClick()
        rule.waitForIdle()
        assertEquals(listOf(AgentModeField.MODEL_MODE to "claude:shared-model"), picks)
        rule.node(PickerSheetTags.PANEL).assertDoesNotExist()
    }

    @Test
    fun thePermissionSheetListsAnUnknownPickDisabled() {
        val modes = modes(ComposerMirror(permissionMode = "plan_only"))
        showComposer(modes)
        // The unknown pick leads the list and names the chip.
        rule.onNodeWithText("plan_only", useUnmergedTree = true).assertExists()
        rule.node(ComposerPickerTags.PERMISSION).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("PERMISSION MODE", useUnmergedTree = true).assertExists()
        rule.node(PickerSheetTags.option("plan_only")).assertIsNotEnabled()
        rule.onNodeWithText("Uses the workspace sandbox.", useUnmergedTree = true).assertExists()
        // The kind's 14 glyph 6 before the label, after the 20 radio and its 16 gap.
        assertDp("label after the kind glyph", 24 + 20 + 16 + 14 + 6, rule.onNodeWithText("Read only", useUnmergedTree = true).bounds.left)
    }

    @Test
    fun aSandboxedSessionSaysSoOnYolo() {
        val sandboxed = requireNotNull(
            SessionMetadata.parse("""{"path":"/repo","host":"h","flavor":"codex","sandbox":{"enabled":true}}"""),
        )
        val modes = modes(metadata = sandboxed)
        rule.setHappyContent {
            ChatComposer("", {}, null, PrimaryAction.Idle, {}, middle = { ComposerModeChips(modes, sandboxed, { _, _ -> }) })
        }
        rule.node(ComposerPickerTags.PERMISSION).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("CODEX PERMISSION MODE", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Yolo (sandboxed)", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Read", useUnmergedTree = true).assertExists()
    }
}
