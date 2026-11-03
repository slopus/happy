package com.slopus.happy.ui.conversation

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.toSize
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ComposerFocus
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Layout and editor state; real IME/Back behavior is exercised by ComposerKeyboardDeviceTest. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ComposerPopupTest {
    @get:Rule val rule = createComposeRule()
    private val mode = Mode("claude", "opus", "high", null, "auto")
    private val catalog = ModeCatalog(listOf(ModelChoice("claude", "Claude", "claude", "opus", "Opus", listOf("low", "high"), "high", emptyList())), mode)
    private fun screenBounds(tag: String) = rule.node(tag).fetchSemanticsNode().let { Rect(it.positionOnScreen, it.size.toSize()) }

    @Test fun `a floating effort selection keeps draft focus and caret in an unmoved composer`() {
        val draft = "keep this draft"
        val picks = mutableListOf<Mode>()
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = false, loaded = true, mode = mode, catalog = catalog, draft = draft, draftArrivals = 1, composerFocus = ComposerFocus(1, 5)),
                null, ConversationScreenActions(onModeChange = { picks += it }),
            )
        }
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        fun kept() {
            rule.node(ConversationComposerTags.INPUT).assertIsFocused()
            val semantics = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config
            assertEquals(draft, semantics[SemanticsProperties.EditableText].text)
            assertEquals(TextRange(5), semantics[SemanticsProperties.TextSelectionRange])
            assertEquals(pill, rule.node(ConversationComposerTags.PILL).bounds)
        }
        kept()
        rule.node(ConversationModeTags.EFFORT).performClick()
        kept()
        // Over its chip, 10 above it.
        assertEquals(screenBounds(ConversationModeTags.EFFORT).top - 10 * rule.density.density, screenBounds(ModelPickerTags.PANEL).bottom, 1f)
        rule.onNodeWithText("Low").performClick()
        kept()
        assertEquals(listOf(mode.copy(effort = "low")), picks)
        // [+] is the attachment sheet; the draft stays with the composer.
        rule.node(ConversationComposerTags.MORE).performClick()
        rule.waitForIdle()
        rule.node(com.slopus.happy.ui.attach.AttachTags.SHEET).assertExists()
        assertEquals(draft, rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
    }

    /** Search's "New task with a picture" (happy-ios 7a605f6ce): new work opens with "+"'s sheet up. */
    @Test fun `new work opened for a picture has the attachment sheet up`() {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = false, loaded = true, mode = mode, catalog = catalog),
                null, ConversationScreenActions(), opensAttach = true,
            )
        }
        rule.waitForIdle()
        rule.node(com.slopus.happy.ui.attach.AttachTags.SHEET).assertExists()
    }

    @Test fun `panels mirror with RTL and clamp to small window edges`() {
        val anchor = IntRect(12, 400, 399, 492)
        val size = IntSize(280, 180)
        val start = ConversationPopupPosition(8, false, 448)
        val end = ConversationPopupPosition(8, true, 448)
        assertEquals(IntOffset(12, 358), start.calculatePosition(anchor, IntSize(411, 800), LayoutDirection.Ltr, size))
        assertEquals(IntOffset(119, 358), end.calculatePosition(anchor, IntSize(411, 800), LayoutDirection.Ltr, size))
        assertEquals(IntOffset(119, 358), start.calculatePosition(anchor, IntSize(411, 800), LayoutDirection.Rtl, size))
        assertEquals(IntOffset(12, 358), end.calculatePosition(anchor, IntSize(411, 800), LayoutDirection.Rtl, size))
        assertEquals(IntOffset(8, 228), end.calculatePosition(IntRect(0, 80, 200, 172), IntSize(200, 300), LayoutDirection.Ltr, IntSize(184, 64)))
        assertEquals(IntOffset(8, 32), ConversationPopupPosition(8, false, 20, 24, 24).calculatePosition(anchor, IntSize(200, 300), LayoutDirection.Ltr, IntSize(184, 200)))
        assertEquals(IntOffset(119, 88), ConversationPopupPosition(8, true, 0, belowAnchor = true).calculatePosition(IntRect(12, 32, 399, 80), IntSize(411, 800), LayoutDirection.Ltr, size))
    }

    @Test @Config(qualifiers = "w411dp-h360dp-xxhdpi")
    fun `short dark window scrolls every model and effort within the window`() {
        val models = (1..20).map { ModelChoice("claude", "Claude", "claude", "model$it", "Model $it", listOf("low", "high"), "high", emptyList()) }
        val current = mode.copy(modelId = "model1")
        rule.setHappyContent(dark = true) {
            ConversationScreen(
                ConversationState(created = false, loaded = true, mode = current, catalog = ModeCatalog(models, current), draft = "draft", draftArrivals = 1),
                null, ConversationScreenActions(),
            )
        }
        rule.node(ConversationModeTags.MODEL).performClick()
        rule.waitForIdle()
        val panel = screenBounds(ModelPickerTags.PANEL)
        assertTrue("panel within screen: $panel", panel.top >= 8f)
        assertTrue("panel within window: $panel", panel.bottom <= 1080f)
        rule.onNodeWithText("Model 20").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Model 20").performClick()
        rule.waitForIdle()
        rule.node(ModelPickerTags.PANEL).assertDoesNotExist()
        rule.node(ConversationModeTags.EFFORT).performClick()
        rule.onNodeWithText("Low").assertIsDisplayed().performClick()
        rule.waitForIdle()
        rule.node(ModelPickerTags.PANEL).assertDoesNotExist()
    }
}