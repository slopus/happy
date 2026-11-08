package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Past the lines the card shows, the expand button over send and the words full screen (iOS efea2b139). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerEditorTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")
    private val catalog = ModeCatalog(
        listOf(ModelChoice("claude", "Current CLI", "claude", "anthropic/opus-5", "Opus 5 1M", listOf("low", "medium", "high", "max"), "high", emptyList())),
        mode,
    )
    private val rows = (1..30).map { ConversationRow.Text("t$it", "Line $it of a long answer", parseMarkdown("Line $it of a long answer")) }
    private val long = (1..12).joinToString("\n") { "Line $it of the plan" }

    private fun show(drafts: MutableList<String> = ArrayList(), dark: Boolean = false, draft: String = "") {
        rule.setHappyContent(dark) {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = mode, catalog = catalog, draft = draft),
                ConversationScreenActions(onDraftChange = { drafts += it }),
            )
        }
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
    }

    private fun screenBounds(tag: String) = rule.node(tag).fetchSemanticsNode().let { Rect(it.positionOnScreen, it.size.toSize()) }

    private fun selection(tag: String) = rule.node(tag).fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange]

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun `past eight lines the expand button stands over send, as far from the top as send from the foot`() {
        show()
        rule.node(ConversationComposerTags.INPUT).performTextInput((1..8).joinToString("\n") { "Line $it" })
        rule.waitForIdle()
        rule.node(ConversationComposerTags.EXPAND).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).performTextInput("\nLine 9")
        rule.waitForIdle()
        val expand = screenBounds(ConversationComposerTags.EXPAND)
        val send = screenBounds(ConversationComposerTags.PRIMARY)
        val pill = screenBounds(ConversationComposerTags.PILL)
        val field = screenBounds(ConversationComposerTags.INPUT)
        assertEquals(send.size, expand.size)
        assertEquals(send.center.x, expand.center.x, 1f)
        assertEquals(pill.bottom - send.bottom, expand.top - pill.top, 1f)
        assertTrue("the words clear of it: $field $expand", field.right <= expand.left + 1f)
        rule.onNodeWithContentDescription("Expand").assertExists()
        shot("composer-expand")
    }

    @Test fun `the editor opens on the caret, its edits are the draft's, and collapse hands the caret back with the keyboard`() {
        val drafts = ArrayList<String>()
        show(drafts, draft = long)
        rule.node(ConversationComposerTags.INPUT).performTextInputSelection(TextRange(5))
        rule.node(ConversationComposerTags.EXPAND).performClick()
        rule.waitForIdle()
        rule.node(ComposerEditorTags.EDITOR).assertExists()
        rule.node(ComposerEditorTags.FIELD).assertIsFocused()
        assertEquals(TextRange(5), selection(ComposerEditorTags.FIELD))
        // Top to bottom of the screen less its insets, the collapse button 8 in from the end.
        val editor = screenBounds(ComposerEditorTags.EDITOR)
        val collapse = screenBounds(ComposerEditorTags.COLLAPSE)
        assertEquals(editor.right - 8 * rule.density.density, collapse.right, 1f)
        assertEquals(editor.top + 4 * rule.density.density, collapse.top, 1f)
        shot("composer-editor")
        rule.node(ComposerEditorTags.FIELD).performTextInput("X")
        rule.waitForIdle()
        assertEquals(long.substring(0, 5) + "X" + long.substring(5), drafts.last())
        rule.node(ComposerEditorTags.COLLAPSE).performClick()
        rule.waitForIdle()
        rule.node(ComposerEditorTags.EDITOR).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).assertIsFocused()
        val field = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config
        assertEquals(drafts.last(), field[SemanticsProperties.EditableText].text)
        assertEquals(TextRange(6), field[SemanticsProperties.TextSelectionRange])
    }

    @Test fun `Back closes the editor, the chat under it out of TalkBack's way while it is up`() {
        show(dark = true, draft = long)
        rule.node(ConversationComposerTags.EXPAND).performClick()
        rule.waitForIdle()
        // What TalkBack reads (the merged tree): the editor alone.
        rule.onNodeWithTag(ConversationComposerTags.INPUT).assertDoesNotExist()
        rule.onNodeWithTag(ComposerEditorTags.FIELD).assertExists()
        shot("composer-editor-dark")
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.node(ComposerEditorTags.EDITOR).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).assertIsFocused()
    }

    @Test fun `the one-row composer offers it once the words are past its one line`() {
        var height by mutableStateOf(54.dp)
        var text by mutableStateOf("one line")
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth().height(height)) {
                ConversationComposer(
                    ConversationState(mode = mode, catalog = catalog),
                    text, onTextChange = { text = it }, onSend = { _, _ -> false }, onSent = {}, onStop = {}, onModeChange = {},
                    onExpand = {},
                )
            }
        }
        rule.waitForIdle()
        rule.node(ConversationComposerTags.EXPAND).assertDoesNotExist()
        rule.runOnIdle { text = "one line\nand another" }
        rule.waitForIdle()
        val expand = screenBounds(ConversationComposerTags.EXPAND)
        val field = screenBounds(ConversationComposerTags.INPUT)
        val pill = screenBounds(ConversationComposerTags.PILL)
        assertTrue("in the row: $expand in $pill", expand.top >= pill.top && expand.bottom <= pill.bottom)
        assertTrue("after the words: $field $expand", field.right <= expand.left + 1f)
    }
}
