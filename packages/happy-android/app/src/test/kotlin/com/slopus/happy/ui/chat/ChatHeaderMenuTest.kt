package com.slopus.happy.ui.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.attachments.AttachmentStripTags
import com.slopus.happy.ui.attachments.ComposerAttachmentTags
import com.slopus.happy.ui.attachments.LocalComposerImages
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.components.PickerSheetTags
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatHeaderMenuTest {
    @get:Rule val rule = createComposeRule()
    private val session = ChatSessionInfo.from(SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/repo","host":"h"}""", 1, null, 1, "", null))
    private val enabled = ModeOption("rig-custom-key", "Custom permission")
    private val retired = ModeOption("unknown-current", "Unknown current", disabled = true)
    private val modes = ComposerModes(availableModes = listOf(enabled, retired), permissionMode = retired, canChangePermission = true)
    private val text = "keep this relay draft"

    private fun show(modes: ComposerModes = this.modes, actions: ChatScreenActions = ChatScreenActions()) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalComposerImages provides rememberComposerImages(true)) {
                ChatScreen(ChatState(ChatSnapshot(loaded = true), session, sessionLoaded = true, online = true), text, "gray", actions, modes = modes)
            }
        }
    }

    @Test fun headerKeepsRawRigChoicesAndEditorSelection() {
        val picks = mutableListOf<Pair<AgentModeField, ModeOption>>()
        show(actions = ChatScreenActions(onModeChange = { field, option -> picks += field to option }))
        rule.node(ComposerTags.INPUT).performClick().performTextInputSelection(TextRange(5))
        rule.node(ChatScreenTags.MORE).performClick()
        rule.node(ComposerTags.INPUT).assertIsFocused()
        rule.node(PickerSheetTags.option(retired.key)).assertIsNotEnabled()
        rule.node(PickerSheetTags.option(enabled.key)).performClick()
        rule.node(ChatScreenTags.MENU).assertDoesNotExist()
        rule.node(ComposerTags.INPUT).assertIsFocused()
        val semantics = rule.node(ComposerTags.INPUT).fetchSemanticsNode().config
        assertEquals(text, semantics[SemanticsProperties.EditableText].text)
        assertEquals(TextRange(5), semantics[SemanticsProperties.TextSelectionRange])
        assertEquals(listOf(AgentModeField.PERMISSION_MODE to enabled), picks)
        rule.node(ComposerPickerTags.PERMISSION).assertDoesNotExist()
    }

    @Test fun headerActionsPreserveDetailsAndRespectLockedPermissionCapability() {
        var compose = 0
        var info = 0
        show(modes.copy(canChangePermission = false), ChatScreenActions(onCompose = { compose++ }, onInfo = { info++ }))
        rule.node(ChatScreenTags.COMPOSE).performClick()
        assertEquals(1, compose)
        rule.node(ChatScreenTags.MORE).performClick()
        rule.node(PickerSheetTags.option(enabled.key)).assertDoesNotExist()
        rule.node(ChatScreenTags.INFO).performClick()
        assertEquals(1, info)
        rule.node(ChatScreenTags.MENU).assertDoesNotExist()
    }

    @Test fun initialAttachmentChooserHasTwoActionsAndPreservesEditor() {
        show()
        rule.node(ComposerTags.INPUT).performClick().performTextInputSelection(TextRange(5))
        rule.node(AttachmentStripTags.ADD).performClick()
        val panel = rule.node(ComposerAttachmentTags.MENU).bounds
        assertDp("attachment panel width", 280, panel.width)
        assertTrue("paste touch target", rule.node(ComposerAttachmentTags.PASTE).bounds.height >= 48.dp)
        assertTrue("photo touch target", rule.node(ComposerAttachmentTags.LIBRARY).bounds.height >= 48.dp)
        rule.node(ComposerTags.INPUT).assertIsFocused()
        assertEquals(TextRange(5), rule.node(ComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
    }
}