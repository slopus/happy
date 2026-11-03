package com.slopus.happy.ui.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
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
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.attachments.AttachmentStripTags
import com.slopus.happy.ui.attach.AttachTags
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.ui.attachments.LocalComposerImages
import com.slopus.happy.ui.attachments.rememberComposerImages
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

    @Test fun theHeaderIsComposeAloneAndTheNameOpensTheDetails() {
        // iOS da5fda505: the More menu is gone; the permission mode is session info's first row.
        var compose = 0
        var info = 0
        show(actions = ChatScreenActions(onCompose = { compose++ }, onInfo = { info++ }))
        rule.onNode(hasTestTag(ChatScreenTags.COMPOSE) and hasAnyAncestor(hasTestTag(HeaderTags.BAR))).assertExists()
        rule.onNode(hasContentDescription("More") and hasAnyAncestor(hasTestTag(HeaderTags.BAR))).assertDoesNotExist()
        rule.node(ChatScreenTags.COMPOSE).performClick()
        assertEquals(1, compose)
        rule.node(ChatScreenTags.TITLE_BUTTON).performClick()
        assertEquals(1, info)
        rule.node(ComposerPickerTags.PERMISSION).assertDoesNotExist()
    }

    @Test fun theAddButtonOpensTheAttachmentSheetWithPicturesOnly() {
        show()
        rule.node(AttachmentStripTags.ADD).performClick()
        rule.waitForIdle()
        rule.node(AttachTags.SHEET).assertExists()
        // A relay session's CLI reads pictures alone: the gallery, and the File tab for the system picker and paste.
        rule.node(AttachTags.tab(AttachTabKind.Gallery)).assertExists()
        rule.node(AttachTags.tab(AttachTabKind.Files)).performClick()
        rule.waitForIdle()
        rule.node(AttachTags.BROWSE).assertDoesNotExist()
        rule.node(AttachTags.PASTE).assertExists()
    }
}