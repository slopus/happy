package com.slopus.happy.fixture

import android.view.WindowManager
import android.view.inspector.WindowInspector
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextRange
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.ui.attachments.AttachmentStripTags
import com.slopus.happy.ui.attachments.ComposerAttachmentTags
import com.slopus.happy.ui.attachments.LocalComposerImages
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerPickerTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.components.PickerSheetTags
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Synthetic relay session: Android IME visibility and the actively served editor are both checked. */
@RunWith(AndroidJUnit4::class)
class RelayComposerKeyboardDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val initialDraft = "relay keyboard menu check"
    private fun node(tag: String) = rule.onNodeWithTag(tag, useUnmergedTree = true)

    private fun kept(step: String) {
        rule.waitForIdle()
        node(ComposerTags.INPUT).assertIsFocused()
        val semantics = node(ComposerTags.INPUT).fetchSemanticsNode().config
        assertEquals("$step draft", initialDraft, semantics[SemanticsProperties.EditableText].text)
        assertEquals("$step caret", TextRange(8), semantics[SemanticsProperties.TextSelectionRange])
        rule.runOnUiThread {
            assertTrue("$step IME visible", ViewCompat.getRootWindowInsets(rule.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true)
            val editor = rule.activity.currentFocus
            assertTrue("$step served editor", editor != null && rule.activity.getSystemService(InputMethodManager::class.java).isActive(editor))
        }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val evidence = File(context.filesDir, "device-evidence/relay-keyboard").apply { mkdirs() }
        File(evidence, "checks.txt").appendText("$step: IME visible, editor served, draft and caret kept\n")
        device.takeScreenshot(File(evidence, step.replace(' ', '-') + ".png"))
    }

    private fun dismissWithBack(menu: String) {
        // Compose semantics can exist before WindowManager focuses the new popup.
        // Send the native key only once it has a real window to receive it.
        rule.waitUntil(5_000) {
            WindowInspector.getGlobalWindowViews().any { it.javaClass.simpleName == "PopupLayout" && it.hasWindowFocus() }
        }
        device.waitForIdle()
        device.pressBack()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(menu, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun relay_menus_keep_keyboard_draft_and_caret() {
        val session = ChatSessionInfo.from(SessionRecord("synthetic-relay", 0, 0, 1, true, 0, """{"path":"/repo","host":"fixture","flavor":"claude"}""", 1, null, 1, "", null))
        val read = ModeOption("read-only", "Read only")
        val full = ModeOption("bypassPermissions", "Full access")
        val first = ModeOption("model1", "Model one")
        val second = ModeOption("model2", "Model two")
        val low = ModeOption("low", "Low")
        val high = ModeOption("high", "High")
        var modes by mutableStateOf(ComposerModes(listOf(read, full), read, listOf(first, second), first, listOf(low, high), low, true, true, true))
        var draft by mutableStateOf(initialDraft)
        val picks = mutableListOf<Pair<AgentModeField, String>>()
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        rule.setContent {
            HappyTheme {
                CompositionLocalProvider(LocalComposerImages provides rememberComposerImages(true)) {
                    ChatScreen(ChatState(ChatSnapshot(loaded = true), session, sessionLoaded = true, online = true), draft, "gray",
                        ChatScreenActions(onDraftChange = { draft = it }, onModeChange = { field, option ->
                            picks += field to option.key
                            modes = when (field) {
                                AgentModeField.PERMISSION_MODE -> modes.copy(permissionMode = option)
                                AgentModeField.MODEL_MODE -> modes.copy(modelMode = option)
                                AgentModeField.EFFORT_LEVEL -> modes.copy(effortLevel = option)
                            }
                        }), modes = modes)
                }
            }
        }
        node(ComposerTags.INPUT).performClick().performTextInputSelection(TextRange(8))
        rule.waitUntil(10_000) { ViewCompat.getRootWindowInsets(rule.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
        kept("before")
        node(ChatScreenTags.MORE).performClick()
        kept("permission open")
        node(PickerSheetTags.option(full.key)).performScrollTo().performClick()
        kept("permission selected")
        node(ChatScreenTags.MORE).performClick()
        dismissWithBack(ChatScreenTags.MENU)
        kept("permission Back")
        node(ComposerPickerTags.MODEL).performClick()
        kept("model open")
        node(PickerSheetTags.option(second.key)).performClick()
        kept("model selected")
        node(ComposerPickerTags.EFFORT).performClick()
        kept("effort open")
        node(PickerSheetTags.option(high.key)).performClick()
        kept("effort selected")
        node(ComposerPickerTags.MODEL).performClick()
        dismissWithBack(PickerSheetTags.PANEL)
        kept("model Back")
        node(AttachmentStripTags.ADD).performClick()
        node(ComposerAttachmentTags.PASTE).assertExists()
        node(ComposerAttachmentTags.LIBRARY).assertExists()
        kept("attachment open")
        dismissWithBack(ComposerAttachmentTags.MENU)
        kept("attachment Back")
        node(AttachmentStripTags.ADD).performClick()
        val field = node(ComposerTags.INPUT).fetchSemanticsNode()
        device.click(2, (field.positionOnScreen.y + field.size.height / 2).toInt())
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(ComposerAttachmentTags.MENU, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        kept("attachment outside")
        assertEquals(listOf(AgentModeField.PERMISSION_MODE to full.key, AgentModeField.MODEL_MODE to second.key, AgentModeField.EFFORT_LEVEL to high.key), picks)
    }
}