package com.slopus.happy.ui.conversation

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.components.RecomposeProbe
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * An answer streaming into [ConversationScreen] as Conversation streams it:
 * the rows built once, then each delta given to the streaming block's
 * [com.slopus.happy.conversation.LiveText] alone ([ConversationRowBuilder.grow]).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
class ConversationStreamingTest {
    @get:Rule
    val rule = androidx.compose.ui.test.junit4.createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "running_tools", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private var now = 1_000_000L
    private val builder = ConversationRowBuilder { now }

    private val history: List<ConversationRow> = listOf(
        Message("m1", "user", 1, listOf(Block.Text("The login page loops back to itself after sign-in. Can you find out why?"))),
        Message("m2", "agent", 2, listOf(Block.Text("Looking at the callback first.\n\n- one\n- two"))),
        Message("m3", "user", 3, listOf(Block.Text("Go on"))),
    ).flatMap { builder.rows(it, "a1", null, false) }.asReversed()

    private var words = StringBuilder("Starting with the callback, which writes the session cookie.")
    private var message = Message("live", "agent", 10, listOf(Block.Text(words.toString())))

    private fun streaming(): ConversationState = ConversationState(
        created = true, loaded = true, agent = agent, working = true, activity = Activity.RunningTools,
        rows = builder.rows(message, "a1", null, true).asReversed() + history,
    )

    /** One delta, as Conversation applies it. */
    private fun delta(more: String) {
        words.append(more)
        message = message.copy(content = listOf(Block.Text(words.toString())))
        assertTrue("the streaming block takes the delta", builder.grow(message, 0))
    }

    @After fun off() {
        RecomposeProbe.counts = null
    }

    @Test fun `a delta recomposes its own row's text and nothing else`() {
        val state = streaming()
        rule.setHappyContent { ConversationScreen(state, null, ConversationScreenActions()) }
        rule.waitForIdle()
        val counts = HashMap<String, Int>()
        RecomposeProbe.counts = counts
        rule.mainClock.autoAdvance = false
        repeat(20) {
            delta(" More words${if (it % 5 == 4) "\n\nA new paragraph" else ""}.")
            rule.mainClock.advanceTimeByFrame()
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val text = ConversationScreenTags.probeText("live:0")
        assertTrue("the streaming text composed with the deltas: $counts", (counts[text] ?: 0) in 1..20)
        val others = counts.filterKeys { it != text }
        assertEquals("nothing else recomposed: the bar, the dock, the composer, the transcript, the other rows", emptyMap<String, Int>(), others)
        assertTrue(rule.onAllNodesWithText("A new paragraph", substring = true).fetchSemanticsNodes().isNotEmpty())
    }

    @Test fun `deltas between two frames compose once`() {
        val state = streaming()
        rule.setHappyContent { ConversationScreen(state, null, ConversationScreenActions()) }
        rule.waitForIdle()
        val counts = HashMap<String, Int>()
        RecomposeProbe.counts = counts
        rule.mainClock.autoAdvance = false
        repeat(6) { delta(" word$it") }
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        assertEquals(1, counts[ConversationScreenTags.probeText("live:0")])
    }

    @Test fun `the end of the stream shows every word at once and the copy button`() {
        var state by mutableStateOf(streaming())
        rule.setHappyContent { ConversationScreen(state, null, ConversationScreenActions()) }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        delta(" The last words.")
        // The run ends in the same frame: the rows are built again without a live block.
        state = state.copy(working = false, activity = null, rows = builder.rows(message, "a1", null, false).asReversed() + history)
        rule.mainClock.advanceTimeByFrame()
        rule.onNodeWithText("The last words.", substring = true).assertExists()
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val answer = rule.onAllNodesWithTag(MessageTags.AGENT, useUnmergedTree = true).fetchSemanticsNodes()
        assertTrue(answer.isNotEmpty())
        assertEquals(2, rule.onAllNodesWithTag(MessageTags.AGENT_COPY, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    /** The answer boxes on screen, top to bottom; their tags sit inside the reveal's clip, so each is its whole height. */
    private fun answers(): List<androidx.compose.ui.unit.DpRect> {
        val nodes = rule.onAllNodesWithTag(MessageTags.AGENT, useUnmergedTree = true)
        return (0 until nodes.fetchSemanticsNodes().size).map { nodes[it].bounds }.sortedBy { it.top }
    }

    /** The streaming row as drawn: the newest, lowest. */
    private fun answer(): androidx.compose.ui.unit.DpRect {
        val nodes = rule.onAllNodesWithTag(ConversationRowTags.ROW, useUnmergedTree = true)
        return (0 until nodes.fetchSemanticsNodes().size).map { nodes[it].bounds }.maxBy { it.top }
    }

    @Test fun `a fresh answer grows from nothing, smoothly, and settles at its whole height`() {
        var state by mutableStateOf(ConversationState(created = true, loaded = true, agent = agent, working = true, activity = Activity.Working, rows = history))
        rule.setHappyContent { ConversationScreen(state, null, ConversationScreenActions()) }
        rule.waitForIdle()
        // The answer before it rests on the list's newest end; the streaming row's drawn height lifts it.
        val rest = answers().last().bottom
        rule.mainClock.autoAdvance = false
        state = streaming()
        rule.mainClock.advanceTimeByFrame()
        val heights = ArrayList<Float>()
        repeat(90) {
            if (it % 6 == 0) delta(" and then some more words that run on to the next line")
            rule.mainClock.advanceTimeByFrame()
            heights += (rest - answers().first().bottom).value
        }
        assertTrue("it starts from nothing: $heights", heights.first() < 4f)
        assertTrue("it never shrinks: $heights", heights.zipWithNext().all { (a, b) -> b >= a - 0.5f })
        assertTrue("it grows smoothly, never a line at once: $heights", heights.zipWithNext().all { (a, b) -> b - a < 12f })
        assertTrue("it grew: $heights", heights.last() > 100f)
        state = state.copy(working = false, activity = null, rows = builder.rows(message, "a1", null, false).asReversed() + history)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val settled = rest - answers().first().bottom
        // Once done it is exactly the answer it would have been without streaming.
        state = ConversationState(created = true, loaded = true, agent = agent, rows = ConversationRowBuilder.build(message, "a1", null, false).asReversed() + history)
        rule.waitForIdle()
        assertEquals((rest - answers().first().bottom).value, settled.value, 0.5f)
    }

    @Test fun `at the newest end the list follows the answer, scrolled into it, the words read stay put`() {
        // Met mid-answer: what is there shows at once.
        repeat(12) { words.append(" A line of earlier words that the answer already had.") }
        message = message.copy(content = listOf(Block.Text(words.toString())))
        val state = streaming()
        now += 10_000
        rule.setHappyContent { ConversationScreen(state, null, ConversationScreenActions()) }
        rule.waitForIdle()
        val foot = answer().bottom
        repeat(4) {
            delta("\n\nAnother paragraph arrives with a few more words in it, and then a few more.")
            rule.waitForIdle()
            assertEquals("pinned to the newest end", foot.value, answer().bottom.value, 1f)
        }
        // Into the answer, away from its foot.
        rule.node(ConversationScreenTags.LIST).performTouchInput { swipe(Offset(centerX, centerY), Offset(centerX, centerY + 300f), 400) }
        rule.waitForIdle()
        val read = rule.onNodeWithText("Starting with the callback", substring = true).bounds.top
        repeat(4) {
            delta("\n\nStill more words, under the reader's eyes.")
            rule.waitForIdle()
            assertEquals("the words read don't move", read.value, rule.onNodeWithText("Starting with the callback", substring = true).bounds.top.value, 1f)
        }
        assertTrue(answer().bottom > foot + 1.dp)
    }
}
