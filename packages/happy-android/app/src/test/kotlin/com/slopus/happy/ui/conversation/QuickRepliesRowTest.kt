package com.slopus.happy.ui.conversation

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.ui.QuickReply
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Suggested replies in the transcript ([QuickRepliesRow], [SuggestedLine]), drawn from the wire as the daemon sends it. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class QuickRepliesRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Onboarding", "idle", null, null, 1, 2, 0, 0)

    private fun rows(json: String) = ConversationRowBuilder.build(Message.parse(Json.parseToJsonElement(json))!!, "a1", null, streaming = false)

    /** An agent message asking in words, with a suggest_replies call of [options], marked as the conversation would. */
    private fun suggested(vararg options: String = LONG, chosen: Int? = null, live: Boolean = true) = rows(
        """{"id":"m2","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"What next?"},
        {"type":"tool_call","id":"c1","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":[${options.joinToString(",") { "\"$it\"" }}]}}]}""",
    ).map { if (it is ConversationRow.Replies) it.copy(chosen = chosen, live = live) else it }

    private val sentReply = rows(
        """{"id":"p1","role":"user","status":"accepted","createdAt":3,"metadata":{},"content":[{"type":"text","text":"Run the tests"}],"quickReply":{"messageId":"m2","toolCallId":"c1","index":1}}""",
    )

    private var shown by mutableStateOf<List<ConversationRow>>(emptyList())
    private val sent = ArrayList<Pair<ConversationRow.Replies, Int>>()

    private fun screen(rows: List<ConversationRow>, canSend: Boolean = true, archived: Boolean = false) {
        shown = rows
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = shown.asReversed(), agent = if (archived) agent.copy(archivedAt = 5) else agent),
                ConversationScreenActions(onQuickReply = { replies, index -> sent += replies to index }),
                roleCanSend = canSend,
            )
        }
        rule.waitForIdle()
    }

    private fun options() = rule.onAllNodesWithTag(QuickReplyTags.OPTION, useUnmergedTree = true).let { all -> (0 until all.fetchSemanticsNodes().size).map { all[it] } }

    @Test fun `a stack is left-aligned at one width, capped at a person's widest bubble, and a tap sends the option`() {
        screen(suggested() + sentReply.map { (it as ConversationRow.User).copy(suggested = false) })
        val root = rule.onRoot().bounds
        val bounds = options().map { it.bounds }
        for (option in bounds) {
            // The long option is wider than the column: every one stops at a person's widest bubble.
            assertDp("capped: the column less 16 a side", root.right - root.left - 32.dp, option.right - option.left)
            assertDp("at the agent's words' edge, 16 in", root.left + 16.dp, option.left)
        }
        assertDp("6 apart", 6.dp, bounds[1].top - bounds[0].bottom)
        assertDp("6 apart", 6.dp, bounds[2].top - bounds[1].bottom)
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        assertDp("a one-line bubble's height", bubble.bottom - bubble.top, bounds[0].bottom - bounds[0].top)
        assertTrue("the long one wraps, taller", bounds[2].bottom - bounds[2].top > bounds[0].bottom - bounds[0].top)
        rule.node(QuickReplyTags.SUGGESTED).assertDoesNotExist()
        options()[1].performClick()
        assertEquals(listOf(1), sent.map { it.second })
        assertEquals(QuickReply("m2", "c1", 1), sent.single().first.reply(1))
    }

    @Test fun `short options take the widest one's width`() {
        screen(suggested("Yes", "Not right now"))
        val root = rule.onRoot().bounds
        val bounds = options().map { it.bounds }
        assertEquals("one width", 1, bounds.map { it.right - it.left }.distinct().size)
        assertTrue("no wider than its options", bounds[0].right - bounds[0].left < root.right - root.left - 32.dp)
        for (option in bounds) assertDp("left-aligned, 16 in", root.left + 16.dp, option.left)
    }

    @Test fun `the option sent takes the bubble's fill and a tick, and nothing moves`() {
        screen(suggested())
        val before = options().map { it.bounds }
        rule.node(QuickReplyTags.TICK).assertDoesNotExist()
        shown = suggested(chosen = 1, live = false) + sentReply
        rule.waitForIdle()
        // The message sent comes in under them, so the list moves up as one; within it, nothing moves.
        val after = options().map { it.bounds }
        val shift = after[0].top - before[0].top
        assertEquals("not a pixel moves", before, after.map { DpRect(it.left, it.top - shift, it.right, it.bottom - shift) })
        options()[1].assertIsSelected()
        options()[0].assertIsNotSelected()
        val tick = rule.node(QuickReplyTags.TICK).bounds
        assertDp("12 in from the option's right", before[1].right - 12.dp, tick.right)
        assertDp("16 wide", 16.dp, tick.right - tick.left)
        // An answered stack takes no more taps.
        options()[0].assertIsNotEnabled()
        options()[0].performClick()
        assertTrue(sent.isEmpty())
    }

    @Test fun `a bubble sent from a reply says so under it, against the right edge`() {
        screen(suggested(chosen = 1, live = false) + sentReply)
        val root = rule.onRoot().bounds
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        val line = rule.node(QuickReplyTags.SUGGESTED).bounds
        assertTrue("under the bubble", line.top >= bubble.bottom)
        assertDp("the row's width", root.right - root.left, line.right - line.left)
        assertDp("its 16 line and 4 under", 20.dp, line.bottom - line.top)
    }

    @Test fun `each option is a button, and a role that can't write can't tap one`() {
        screen(suggested(), canSend = false)
        options()[0].assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
        options()[0].assertIsNotEnabled()
        options()[0].performClick()
        assertTrue(sent.isEmpty())
    }

    @Test fun `an archived chat's stack takes no tap`() {
        screen(suggested(), archived = true)
        options()[0].assertIsNotEnabled()
        options()[0].performClick()
        assertTrue(sent.isEmpty())
    }

    private companion object {
        val LONG = arrayOf("Fix the login redirect", "Run the tests", "Something much longer than a phone's line can hold in one go")
    }
}
