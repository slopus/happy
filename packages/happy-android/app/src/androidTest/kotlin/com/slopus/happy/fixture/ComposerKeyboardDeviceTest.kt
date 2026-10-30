package com.slopus.happy.fixture

import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
import com.slopus.happy.ui.conversation.ConversationScreenTags
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
        var imeTop = 0
        rule.waitForIdle()
        node(ConversationComposerTags.INPUT).assertIsFocused()
        val semantics = node(ConversationComposerTags.INPUT).fetchSemanticsNode().config
        assertEquals("$step draft", draft, semantics[SemanticsProperties.EditableText].text)
        assertEquals("$step caret", TextRange(8), semantics[SemanticsProperties.TextSelectionRange])
        rule.runOnUiThread {
            val decor = rule.activity.window.decorView
            assertTrue("$step IME visible", ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true)
            imeTop = device.displayHeight - (ViewCompat.getRootWindowInsets(decor)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0)
            val editor = rule.activity.currentFocus
            assertTrue("$step served editor", editor != null && rule.activity.getSystemService(InputMethodManager::class.java).isActive(editor))
        }
        val field = screenBounds(ConversationComposerTags.INPUT)
        val card = screenBounds(ConversationComposerTags.PILL)
        val bar = screenBounds(ConversationScreenTags.BAR)
        assertTrue("$step composer below header: $card / $bar", card.top >= bar.bottom - 1)
        assertTrue("$step composer above IME: $card / $imeTop", card.bottom <= imeTop + 1)
        val minimumTouch = 48 * rule.activity.resources.displayMetrics.density
        if (imeTop - bar.bottom >= minimumTouch) assertTrue("$step 48dp touch surface", card.height >= minimumTouch)
        assertTrue("$step field within composer: $field / $card", field.top >= card.top && field.bottom <= card.bottom)
        val menu = listOf(ConversationModeTags.PICKER, ConversationComposerTags.MENU, ConversationScreenTags.MENU).flatMap {
            rule.onAllNodesWithTag(it, useUnmergedTree = true).fetchSemanticsNodes()
        }.firstOrNull()?.let { Rect(it.positionOnScreen, it.size.toSize()) }
        if (menu != null) assertTrue("$step panel within window", menu.left >= 0 && menu.top >= 0 && menu.right <= device.displayWidth && menu.bottom <= device.displayHeight)
        val title = screenBounds(ConversationScreenTags.TITLE)
        val compose = screenBounds(ConversationScreenTags.COMPOSE)
        val more = screenBounds(ConversationScreenTags.MORE)
        val rtl = InstrumentationRegistry.getArguments().getString("rtl") == "true"
        assertTrue("$step header action order", if (rtl) more.right <= compose.left else compose.right <= more.left)
        assertTrue("$step title clear of actions", if (rtl) title.left >= compose.right else title.right <= compose.left)
        val metadata = "$step: IME visible, editor served, draft/caret kept; field=$field card=$card header=$bar imeTop=$imeTop panel=$menu title=$title compose=$compose more=$more"
        android.util.Log.i("ComposerKeyboard", metadata)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val evidence = File(context.filesDir, "device-evidence/composer-keyboard").apply { mkdirs() }
        File(evidence, "checks.txt").appendText("$metadata\n")
        device.takeScreenshot(File(evidence, step.replace(' ', '-') + ".png"))
    }

    private fun closed(tag: String) {
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    private fun back(step: String, panel: String) {
        kept("$step ready")
        device.waitForIdle()
        device.pressBack()
        closed(panel)
        kept("$step dismissed")
    }

    private fun outside(step: String, panel: String) {
        kept("$step ready")
        device.waitForIdle()
        val y = screenBounds(ConversationComposerTags.INPUT).center.y.toInt()
        val bounds = screenBounds(panel)
        assertTrue("outside x2 is outside panel $bounds", 2 < bounds.left)
        val metadata = "$step: outside click=(2,$y), panel=$bounds, panel screen origin=${bounds.topLeft}"
        android.util.Log.i("ComposerKeyboard", metadata)
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "device-evidence/composer-keyboard/checks.txt").appendText("$metadata\n")
        device.click(2, y)
        closed(panel)
        kept("$step dismissed")
    }

    @Test fun menus_keep_the_real_keyboard_and_back_dismisses_the_panel_first() {
        val mode = Mode("claude", "model1", "high", null, "auto")
        var current by mutableStateOf(mode)
        val created = InstrumentationRegistry.getArguments().getString("created") == "true"
        val rtl = InstrumentationRegistry.getArguments().getString("rtl") == "true"
        var composed = 0
        var details = 0
        // A long list forces actual scrolling, even on tall phones.
        val models = (1..20).map { ModelChoice("claude", "Claude", "claude", "model$it", "Model $it", listOf("low", "high"), "high", emptyList()) }
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        rule.setContent {
            HappyTheme(if (InstrumentationRegistry.getArguments().getString("dark") == "true") ThemePreference.Dark else ThemePreference.Light) {
                CompositionLocalProvider(LocalLayoutDirection provides if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr) {
                    ConversationScreen(
                        ConversationState(created = created, loaded = true, knownTitle = if (created) "A long chat title that must leave room for both header actions" else null, mode = current, catalog = ModeCatalog(models, mode), draft = draft, draftArrivals = 1, composerFocus = ComposerFocus(1, 8)),
                        null, ConversationScreenActions(onModeChange = { current = it }, onCompose = { composed++ }, onDetails = { details++ }),
                    )
                }
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
        back("model Back", ConversationModeTags.PICKER)
        node(ConversationModeTags.MODEL).performClick()
        outside("model outside", ConversationModeTags.PICKER)
        node(ConversationComposerTags.MORE).performClick()
        kept("attachment open")
        node(ConversationComposerTags.ATTACH).assertExists()
        node(ConversationComposerTags.PASTE).assertExists()
        node(ConversationModeTags.PERMISSION).assertDoesNotExist()
        back("attachment Back", ConversationComposerTags.MENU)
        node(ConversationComposerTags.MORE).performClick()
        outside("attachment outside", ConversationComposerTags.MENU)
        val permissions = listOf("read_only" to "Read only", "workspace_write" to "Workspace write", "auto" to "Auto", "full_access" to "Full access")
        for ((key, name) in permissions) {
            node(ConversationScreenTags.MORE).performClick()
            kept("header $key open")
            if (created) node(ConversationScreenTags.DETAILS).assertExists() else node(ConversationScreenTags.DETAILS).assertDoesNotExist()
            node(ConversationModeTags.PERMISSION).performClick()
            kept("permission $key open")
            val selected = permissions.first { it.first == current.permissionMode }.second
            node(ConversationModeTags.OPTIONS).performScrollToNode(hasText(selected))
            rule.onNodeWithText(selected).assertIsSelected()
            node(ConversationModeTags.OPTIONS).performScrollToNode(hasText(name))
            rule.onNodeWithText(name).performClick()
            kept("permission $key selected")
            assertEquals(key, current.permissionMode)
        }
        node(ConversationScreenTags.MORE).performClick()
        back("header Back", ConversationScreenTags.MENU)
        node(ConversationScreenTags.MORE).performClick()
        outside("header outside", ConversationScreenTags.MENU)
        node(ConversationScreenTags.MORE).performClick()
        node(ConversationModeTags.PERMISSION).performClick()
        back("permission Back", ConversationModeTags.PICKER)
        node(ConversationScreenTags.MORE).performClick()
        node(ConversationModeTags.PERMISSION).performClick()
        outside("permission outside", ConversationModeTags.PICKER)
        node(ConversationScreenTags.COMPOSE).performClick()
        assertEquals(1, composed)
        if (created) {
            node(ConversationScreenTags.MORE).performClick()
            node(ConversationScreenTags.DETAILS).performClick()
            assertEquals(1, details)
        }
    }
}