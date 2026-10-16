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
        rule.node(ComposerPickerTags.SHEET).assertExists()
        rule.onNodeWithText("MODEL", useUnmergedTree = true).assertExists()
        rule.node(ComposerPickerTags.section("codex")).assertExists()
        rule.node(ComposerPickerTags.section("claude")).assertExists()
        val first = rule.node(ComposerPickerTags.option("codex:shared-model")).bounds
        val second = rule.node(ComposerPickerTags.option("claude:shared-model")).bounds
        assertDp("option at least 56 high", 56, first.height)
        // A rule and the second provider's heading lie between them.
        assertEquals(true, second.top > first.bottom)
        rule.node(ComposerPickerTags.option("claude:shared-model")).performClick()
        rule.waitForIdle()
        assertEquals(listOf(AgentModeField.MODEL_MODE to "claude:shared-model"), picks)
        rule.node(ComposerPickerTags.SHEET).assertDoesNotExist()
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
        rule.node(ComposerPickerTags.option("plan_only")).assertIsNotEnabled()
        rule.onNodeWithText("Uses the workspace sandbox.", useUnmergedTree = true).assertExists()
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

    // The panel: header 24 in, a 48 close 4 from the end, rows 24 in with the 20 radio.
    @Test
    fun panelGeometry() {
        rule.setHappyContent {
            Box(Modifier.fillMaxSize()) {
                PickerSheetPanel(title = "EFFORT", onClose = {}) {
                    PickerSheetOption("Low", "Fast", selected = true, onClick = {}, tag = ComposerPickerTags.option("low"))
                    PickerSheetOption("High", null, selected = false, onClick = {}, tag = ComposerPickerTags.option("high"))
                }
            }
        }
        val sheet = rule.node(ComposerPickerTags.SHEET).bounds
        assertDp("full phone width", PHONE_WIDTH, sheet.width)
        val title = rule.node(ComposerPickerTags.SHEET_TITLE).bounds
        assertDp("title 24 in", 24, title.left)
        val close = rule.node(ComposerPickerTags.SHEET_CLOSE).bounds
        // Centred in the 52 below the 4 top padding.
        assertBox("close", close, PHONE_WIDTH.dp - 4.dp - 48.dp, 4.dp + 2.dp, 48.dp, 48.dp)
        val low = rule.node(ComposerPickerTags.option("low")).bounds
        assertDp("first row under the 56 header", 56, low.top)
        val high = rule.node(ComposerPickerTags.option("high")).bounds
        assertDp("rows at least 56 high", 56, high.height)
        assertDp("rows stack", low.bottom, high.top)
        assertDp("8 below the last row", high.bottom + 8.dp, sheet.bottom)
    }
}
