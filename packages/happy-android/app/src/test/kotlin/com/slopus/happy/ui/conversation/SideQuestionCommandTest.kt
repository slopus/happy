package com.slopus.happy.ui.conversation

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.SlashCommand
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.TOLERANCE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.autocomplete.AutocompleteTags
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * `/btw` in a Happy Agent chat's composer ([ConversationScreen]): wherever
 * the computer serves side questions, a `/btw <question>` asks the side
 * panel and is never a message, whatever the model, and a bare `/btw` only
 * shows "Usage: /btw <your question>" over the composer until it is edited.
 * The "/" list offers `/btw` first, which a pick leaves as `/btw `, where the
 * model it is answered with answers side questions: the agent's own mode,
 * not the composer's pick. Where the computer serves none, `/btw` is what
 * it was.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SideQuestionCommandTest {
    @get:Rule val rule = createComposeRule()

    private val sent = ArrayList<String>()
    private val asked = ArrayList<String>()
    private val drafts = ArrayList<String>()
    private val ran = ArrayList<String>()

    private val compact = SlashCommand("compact", false, "Summarize older messages to free context space.", SlashCommand.COMPACTION)

    private fun show(state: ConversationState = SideQuestionFixtures.conversation(commands = listOf(compact)), served: Boolean = true) {
        rule.setHappyContent {
            ProvideWindowLayout {
                ConversationScreen(
                    state,
                    ConversationScreenActions(
                        onDraftChange = { drafts += it },
                        onSend = { words, _ -> sent += words; true },
                        onCommand = { name, _ -> ran += name; true },
                        sideQuestions = SideQuestionActions(served = { served }, onAsk = { asked += it }),
                    ),
                )
            }
        }
        rule.waitForIdle()
    }

    private fun send(words: String) {
        rule.node(ConversationComposerTags.INPUT).performTextInput(words)
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
    }

    private fun composerText() = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.EditableText].text

    private fun listRows() = rule.onAllNodesWithTag(AutocompleteTags.ROW, useUnmergedTree = true)

    @Test fun `btw with a question asks the side panel and is never a message`() {
        show()
        send("/btw which file handles the retries?")
        assertEquals(listOf("which file handles the retries?"), asked)
        assertTrue(sent.isEmpty())
        assertTrue(ran.isEmpty())
        assertEquals("the words that asked go", "", drafts.last())
        assertEquals("", composerText())
        assertTrue(rule.onAllNodesWithTag(SideQuestionTags.USAGE, useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
    }

    @Test fun `a bare btw only says how to ask, over the composer, until the composer is edited`() {
        show()
        send("/btw")
        assertTrue(asked.isEmpty())
        assertTrue(sent.isEmpty())
        val usage = rule.node(SideQuestionTags.USAGE)
        usage.assertExists()
        rule.onNode(hasText("Usage: /btw <your question>"), useUnmergedTree = true).assertExists()
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        val line = usage.bounds
        assertTrue("over the composer: $line, $pill", line.bottom <= pill.top + TOLERANCE)
        assertDp("across the composer's column", pill.left - 12.dp, line.left)
        assertTrue("no panel opens", rule.onAllNodesWithTag(SideQuestionTags.PANEL, useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        rule.node(ConversationComposerTags.INPUT).performTextInput("w")
        rule.waitForIdle()
        assertTrue(rule.onAllNodesWithTag(SideQuestionTags.USAGE, useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
    }

    @Test fun `where the computer doesn't serve side questions, btw goes as it did`() {
        show(served = false)
        send("/btw which file?")
        assertEquals(listOf("/btw which file?"), sent)
        assertTrue(asked.isEmpty())
    }

    @Test fun `in a chat whose model answers none, btw is still never a message`() {
        show(SideQuestionFixtures.conversation(mode = SideQuestionFixtures.codex, commands = listOf(compact)))
        send("/btw which file?")
        // The computer says the model answers none, in the panel.
        assertEquals(listOf("which file?"), asked)
        assertTrue(sent.isEmpty())
    }

    @Test fun `the list goes by the agent's own model, not the one the composer picked`() {
        // Picked Codex but sent nothing yet: the agent still runs Claude, which answers.
        show(SideQuestionFixtures.conversation(mode = SideQuestionFixtures.codex, agentMode = SideQuestionFixtures.claude, commands = listOf(compact)))
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 2 }
        rule.onNode(hasText("/btw"), useUnmergedTree = true).assertExists()
    }

    @Test fun `picking a model that answers doesn't offer btw while the agent runs one that doesn't`() {
        show(SideQuestionFixtures.conversation(mode = SideQuestionFixtures.claude, agentMode = SideQuestionFixtures.codex, commands = listOf(compact)))
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        rule.onNode(hasText("/btw"), useUnmergedTree = true).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).performTextReplacement("")
        send("/btw which file?")
        assertEquals("still taken, never sent", listOf("which file?"), asked)
        assertTrue(sent.isEmpty())
    }

    @Test fun `before its first message the composer's pick decides the list`() {
        show(SideQuestionFixtures.conversation(mode = SideQuestionFixtures.claude, agentMode = null, commands = listOf(compact)))
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 2 }
        rule.onNode(hasText("/btw"), useUnmergedTree = true).assertExists()
    }

    @Test fun `a new chat has nothing to ask about, and its btw is its first message`() {
        show(SideQuestionFixtures.conversation(created = false))
        send("/btw which file?")
        assertEquals(listOf("/btw which file?"), sent)
        assertTrue(asked.isEmpty())
    }

    @Test fun `the list offers btw first where it is offered, and a pick waits for its question`() {
        show()
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 2 }
        val btw = rule.onNode(hasText("/btw"), useUnmergedTree = true).bounds
        val compactRow = rule.onNode(hasText("/compact"), useUnmergedTree = true).bounds
        assertTrue("btw first", btw.top < compactRow.top)
        rule.onNode(hasText("Side question"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("Ask about this chat without adding to it"), useUnmergedTree = true).assertExists()
        listRows()[0].performClick()
        rule.waitForIdle()
        assertEquals("/btw ", drafts.last())
        assertTrue("nothing runs", ran.isEmpty())
        rule.node(ConversationComposerTags.INPUT).performTextInput("which file?")
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("which file?"), asked)
        assertTrue(sent.isEmpty())
    }

    @Test fun `where btw isn't offered the list doesn't have it`() {
        show(served = false)
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        rule.onNode(hasText("/compact"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("/btw"), useUnmergedTree = true).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).performTextInput("b")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().isEmpty() }
    }
}
