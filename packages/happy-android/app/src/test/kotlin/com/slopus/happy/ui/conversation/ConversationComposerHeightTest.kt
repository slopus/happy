package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ComposerFocus
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.ui.attachments.rememberImagePicker
import com.slopus.happy.ui.attachments.ImagePicker
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

/** A short viewport changes measurement, retaining the same editor and every composer action. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ConversationComposerHeightTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `a 54 dp body fits one 48 dp row and resizing keeps editor draft caret and actions`() {
        var height by mutableStateOf(160.dp)
        var text by mutableStateOf("keep this draft")
        val mode = Mode("claude", "opus", "high", null, "auto")
        val catalog = ModeCatalog(listOf(ModelChoice("claude", "Claude", "claude", "opus", "Opus", listOf("low", "high"), "high", emptyList())), mode)
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth().height(height)) {
                ConversationComposer(
                    ConversationState(mode = mode, catalog = catalog, composerFocus = ComposerFocus(1, 5)),
                    text, onTextChange = { text = it }, onSend = { _, _ -> false }, onSent = {}, onStop = {}, onModeChange = {},
                )
            }
        }
        val editor = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().id
        rule.node(ConversationComposerTags.INPUT).assertIsFocused()
        assertTrue(rule.node(ConversationComposerTags.PILL).bounds.height > 48.dp)
        rule.runOnIdle { height = 54.dp }
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        assertEquals(48f, pill.height.value, 0.5f)
        assertTrue(pill.top >= 0.dp && pill.bottom <= 54.dp)
        for (tag in listOf(ConversationComposerTags.INPUT, ConversationComposerTags.MORE, ConversationModeTags.MODEL, ConversationComposerTags.PRIMARY)) {
            val box = rule.node(tag).assertIsDisplayed().bounds
            assertTrue("$tag fits compact row: $box in $pill", box.top >= pill.top && box.bottom <= pill.bottom)
        }
        rule.node(ConversationComposerTags.INPUT).assertIsFocused()
        assertEquals(editor, rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().id)
        assertEquals(TextRange(5), rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        rule.node(ConversationComposerTags.INPUT).performTextInput((1..20).joinToString("\n") { "line $it" })
        val caret = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange]
        assertTrue(text.contains("line 20"))
        rule.runOnIdle { height = 160.dp }
        rule.node(ConversationComposerTags.INPUT).assertIsFocused()
        val field = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode()
        assertEquals(editor, field.id)
        assertEquals(text, field.config[SemanticsProperties.EditableText].text)
        assertEquals(caret, field.config[SemanticsProperties.TextSelectionRange])
        assertTrue(rule.node(ConversationComposerTags.PILL).bounds.bottom <= 160.dp)
    }

    @Test fun `compact queued images keep a visible accessible count and removal in the attachment menu`() {
        lateinit var picker: ImagePicker
        rule.setHappyContent {
            picker = rememberImagePicker()
            LaunchedEffect(Unit) {
                picker.state.images.addAll((1..2).map { AttachmentPreview("image$it", "file:///synthetic-$it.jpg", 1, 1, "image/jpeg", 1, "synthetic-$it.jpg") })
            }
            Box(Modifier.fillMaxWidth().height(54.dp)) {
                ConversationComposer(ConversationState(), "draft", {}, { _, _ -> false }, {}, {}, {}, pictures = picker)
            }
        }
        rule.node(ConversationComposerTags.COUNT).assertExists()
        rule.onNodeWithContentDescription("More, 2 attached images").assertExists()
        rule.node(ConversationComposerTags.PICTURES).assertDoesNotExist()
        rule.node(ConversationComposerTags.MORE).performClick()
        rule.node(ConversationComposerTags.PICTURES).assertIsDisplayed()
        rule.onAllNodesWithTag(ConversationComposerTags.PICTURE_REMOVE, useUnmergedTree = true).onFirst().performClick()
        rule.onNodeWithContentDescription("More, 1 attached image").assertExists()
        rule.onAllNodesWithTag(ConversationComposerTags.PICTURE_REMOVE, useUnmergedTree = true).onFirst().performClick()
        rule.node(ConversationComposerTags.COUNT).assertDoesNotExist()
        assertTrue(picker.images.isEmpty())
    }
}