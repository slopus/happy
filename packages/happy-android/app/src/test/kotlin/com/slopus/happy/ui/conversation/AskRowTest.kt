package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.Question
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageTags
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

/**
 * A question in the transcript (desktop 1b626346, iOS 7f6355041): waiting
 * at the end with its rule, ticked and sent from there or from the
 * composer, then frozen in its turn as what was answered.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AskRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Pick storage", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)

    private val question = Question(
        "q1", "pending", null,
        listOf(
            Question.Prompt("db", "Database", "Which database should billing use?", false, listOf(Question.Option("PostgreSQL", "Matches the stack."), Question.Option("SQLite", null)), null),
            Question.Prompt("extras", "Extras", "What else should it set up?", true, listOf(Question.Option("Nightly backups", null), Question.Option("Metrics", null)), null),
        ),
        null, false,
    )

    private val asked = ConversationRowBuilder.build(
        Message("m1", "agent", 1, listOf(Block.Text("Billing needs somewhere to keep invoices."))), "a1", null, false,
    )

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun waiting(phase: AskPhase = AskPhase.Pending) =
        (asked + ConversationRow.Ask(ConversationRowBuilder.askKey("q1"), question, phase)).asReversed()

    @Test fun `waiting, it ends the transcript with its rules and Submit waits for every prompt`() {
        val answers = ArrayList<Map<String, List<String>>>()
        val sent = ArrayList<String>()
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = waiting(), agent = agent, question = question, activity = Activity.AwaitingAnswer),
                ConversationScreenActions(onAnswer = { _, a -> answers += a }, onSend = { w, _ -> sent += w; true }),
            )
        }
        rule.waitForIdle()
        // In the transcript, not over the composer.
        rule.node(ConversationQuestionTags.CARD).assertDoesNotExist()
        rule.onNodeWithText("Choose one").assertExists()
        rule.onNodeWithText("Choose any").assertExists()
        rule.onNodeWithText("DATABASE").assertExists()
        // The options' words line up with the transcript's, their wash 12 out from them.
        val words = rule.node(MessageTags.AGENT).bounds
        val option = rule.onAllNodesWithTag(AskTags.OPTION)[0].bounds
        assertDp("the option's wash 12 out from the column", words.left - 12.dp, option.left)
        assertTrue("at least 32 high", option.bottom - option.top >= 32.dp)
        rule.node(AskTags.SUBMIT).performClick()
        assertTrue("nothing goes until every prompt has a tick", answers.isEmpty())
        rule.onNodeWithText("PostgreSQL").performClick()
        rule.onNodeWithText("Metrics").performClick()
        rule.onNodeWithText("Nightly backups").performClick()
        rule.onAllNodesWithTag(AskTags.OPTION)[0].assertIsSelected()
        shot("ask-waiting")
        rule.node(AskTags.SUBMIT).performClick()
        rule.waitForIdle()
        assertEquals(listOf(mapOf("db" to listOf("PostgreSQL"), "extras" to listOf("Metrics", "Nightly backups"))), answers)
        assertTrue(sent.isEmpty())
    }

    @Test fun `words typed while it waits answer what isn't ticked, and are no message`() {
        val drafts = ArrayList<String>()
        val answers = ArrayList<Map<String, List<String>>>()
        val sent = ArrayList<String>()
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = waiting(), agent = agent, question = question, activity = Activity.AwaitingAnswer),
                ConversationScreenActions(onAnswer = { _, a -> answers += a }, onSend = { w, _ -> sent += w; true }, onDraftChange = { drafts += it }),
            )
        }
        rule.waitForIdle()
        rule.onNodeWithText("SQLite").performClick()
        rule.node(ConversationComposerTags.INPUT).performTextInput("Nothing else for now")
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf(mapOf("db" to listOf("SQLite"), "extras" to listOf("Nothing else for now"))), answers)
        assertTrue("the words went as the answer", sent.isEmpty())
        assertEquals("the draft goes with them", "", drafts.last())
    }

    @Test fun `while the answer goes the options quiet, and a refusal says why`() {
        var phase by mutableStateOf<AskPhase>(AskPhase.Submitting)
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = waiting(phase), agent = agent, question = question, activity = Activity.AwaitingAnswer),
                ConversationScreenActions(),
            )
        }
        rule.waitForIdle()
        rule.node(AskTags.NOTE).assertDoesNotExist()
        phase = AskPhase.Failed(Problem.Said("The computer is offline."))
        rule.waitForIdle()
        rule.onNodeWithText("Answer not sent: The computer is offline.").assertExists()
        rule.node(AskTags.SUBMIT).assertExists()
    }

    private fun answered(dark: Boolean) {
        val answered = question.copy(status = "answered", answers = mapOf("db" to listOf("PostgreSQL"), "extras" to emptyList()))
        val rows = (asked + ConversationRow.Ask(ConversationRowBuilder.askKey("q1"), answered, AskPhase.Answered) +
            ConversationRowBuilder.build(Message("m2", "agent", 2, listOf(Block.Text("Setting up PostgreSQL."))), "a1", null, false)).asReversed()
        rule.setHappyContent(dark) { ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent), ConversationScreenActions()) }
        rule.waitForIdle()
        rule.onNodeWithText("Answered").assertExists()
        // An unanswered prompt says so, under its rule and as its answer.
        assertEquals(2, rule.onAllNodesWithText("No answer").fetchSemanticsNodes().size)
        assertEquals(2, rule.onAllNodesWithTag(AskTags.ANSWER).fetchSemanticsNodes().size)
        rule.onNodeWithText("Matches the stack.").assertExists()
        rule.node(AskTags.SUBMIT).assertDoesNotExist()
        assertEquals(0, rule.onAllNodesWithTag(AskTags.OPTION).fetchSemanticsNodes().size)
        // Between the words before it and the answer after it.
        val ask = rule.node(AskTags.ROW).bounds
        val agents = rule.onAllNodesWithTag(MessageTags.AGENT, useUnmergedTree = true).fetchSemanticsNodes().map { it.boundsInRoot }
        val px = density()
        assertTrue(agents.any { it.bottom <= ask.top.value * px + 1 } && agents.any { it.top >= ask.bottom.value * px - 1 })
        shot(if (dark) "ask-answered-dark" else "ask-answered")
    }

    @Test fun `answered, it stays in its turn as what was answered`() = answered(dark = false)

    @Test fun `answered, dark`() = answered(dark = true)

    private fun density() = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().resources.displayMetrics.density
}
