package com.slopus.happy.fixture

import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.text.TextRange
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.conversation.ComposerFocus
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.conversation.ConversationModeTags
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Synthetic draft only. Checks Android's shown IME and actively served editor, not a fake controller. */
@RunWith(AndroidJUnit4::class)
class ComposerKeyboardDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val draft = "keyboard menu check"
    private fun node(tag: String) = rule.onNodeWithTag(tag, useUnmergedTree = true)
    private fun screenBounds(tag: String) = node(tag).fetchSemanticsNode().let { Rect(it.positionOnScreen, it.size.toSize()) }

    private fun kept(step: String) {
        rule.waitForIdle()
        node(ConversationComposerTags.INPUT).assertIsFocused()
        val semantics = node(ConversationComposerTags.INPUT).fetchSemanticsNode().config
        assertEquals("$step draft", draft, semantics[SemanticsProperties.EditableText].text)
        assertEquals("$step caret", TextRange(8), semantics[SemanticsProperties.TextSelectionRange])
        rule.runOnUiThread {
            val decor = rule.activity.window.decorView
            assertTrue("$step IME visible", ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true)
            val editor = rule.activity.currentFocus
            assertTrue("$step served editor", editor != null && rule.activity.getSystemService(InputMethodManager::class.java).isActive(editor))
        }
        val field = screenBounds(ConversationComposerTags.INPUT)
        val menu = listOf(ConversationModeTags.PICKER, ConversationComposerTags.MENU).flatMap {
            rule.onAllNodesWithTag(it, useUnmergedTree = true).fetchSemanticsNodes()
        }.firstOrNull()?.let { Rect(it.positionOnScreen, it.size.toSize()) }
        if (menu != null) assertTrue("$step panel overlaps composer", menu.bottom > field.top)
        android.util.Log.i("ComposerKeyboard", "$step: IME visible, editor served, draft/caret kept; field=$field panel=$menu")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val evidence = File(context.filesDir, "device-evidence/composer-keyboard").apply { mkdirs() }
        File(evidence, "checks.txt").appendText("$step: IME visible, editor served, draft/caret kept; field=$field panel=$menu\n")
        device.takeScreenshot(File(evidence, step.replace(' ', '-') + ".png"))
    }

    @Test fun menus_keep_the_real_keyboard_and_back_dismisses_the_panel_first() {
        val mode = Mode("claude", "model1", "high", null, "auto")
        var current by mutableStateOf(mode)
        // A long list forces actual scrolling above the IME, even on tall phones.
        val models = (1..20).map { ModelChoice("claude", "Claude", "claude", "model$it", "Model $it", listOf("low", "high"), "high", emptyList()) }
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        rule.setContent {
            HappyTheme(if (InstrumentationRegistry.getArguments().getString("dark") == "true") ThemePreference.Dark else ThemePreference.Light) {
                ConversationScreen(
                    ConversationState(created = false, loaded = true, mode = current, catalog = ModeCatalog(models, mode), draft = draft, draftArrivals = 1, composerFocus = ComposerFocus(1, 8)),
                    null, ConversationScreenActions(onModeChange = { current = it }),
                )
            }
        }
        rule.waitUntil(10_000) { ViewCompat.getRootWindowInsets(rule.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
        kept("before")
        node(ConversationModeTags.MODEL).performClick()
        kept("model open")
        node(ConversationModeTags.OPTIONS).performScrollToNode(hasText("Model 20"))
        rule.onNodeWithText("Model 20").performClick()
        kept("model selected")
        assertEquals("model20", current.modelId)
        node(ConversationModeTags.MODEL).performClick()
        kept("model reopen")
        device.waitForIdle()
        device.pressBack()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(ConversationModeTags.PICKER, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        kept("model Back")
        node(ConversationModeTags.MODEL).performClick()
        kept("model outside open")
        device.waitForIdle()
        val input = screenBounds(ConversationComposerTags.INPUT)
        device.click(2, input.center.y.toInt())
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(ConversationModeTags.PICKER, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        kept("model outside")
        node(ConversationComposerTags.MORE).performClick()
        kept("attachment open")
        node(ConversationComposerTags.ATTACH).assertExists()
        node(ConversationComposerTags.PASTE).assertExists()
        node(ConversationModeTags.PERMISSION).performClick()
        kept("permission open")
        rule.onNodeWithText("Full access").performScrollTo().performClick()
        kept("permission selected")
        assertEquals("full_access", current.permissionMode)
        node(ConversationComposerTags.MORE).performClick()
        kept("attachment reopen")
        device.waitForIdle()
        device.pressBack()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(ConversationComposerTags.MENU, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        kept("attachment Back")
        node(ConversationComposerTags.MORE).performClick()
        kept("attachment outside open")
        device.waitForIdle()
        device.click(2, input.center.y.toInt())
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(ConversationComposerTags.MENU, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        kept("attachment outside")
    }
}