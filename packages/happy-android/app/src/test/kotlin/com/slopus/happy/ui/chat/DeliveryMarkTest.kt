package com.slopus.happy.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.unit.DpRect
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.MessageDelivery
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import androidx.compose.ui.unit.dp

/**
 * An own bubble's time and mark (iOS 3c24acf5c, 65f9eb1a0): on the last
 * line when it fits, else a line of its own; the bubble never moves as the
 * mark goes from the clock to the checks or the refusal.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DeliveryMarkTest {
    @get:Rule
    val rule = createComposeRule()

    private val gray = userMessageBubblePalette("gray", dark = false)

    private fun row(text: String, delivery: MessageDelivery, pending: Boolean = false) =
        (ChatReduction.buildRow(ChatMessage.UserText("u", "l", 0, text, pending = pending), isClaudeFlavor = false) as ChatRow.User)
            .copy(delivery = delivery, time = 1_700_000_000_000)

    @Test
    fun shortMessageCarriesItsTimeOnItsLine() {
        rule.setHappyContent { UserMessage(row("Hello", MessageDelivery.Accepted), gray, MessageCallbacks()) }
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        val text = rule.node(MarkdownTags.TEXT).bounds
        val status = rule.node(DeliveryTags.STATUS).bounds
        assertDp("one line bubble, no taller", 4 + 8 + 25 + 10 + 4, bubble.bottom - bubble.top)
        assertDp("the box ends at the content's end", 12, bubble.right - status.right)
        assertTrue("after the words", status.left >= text.left)
        assertDp("on the last line, its foot a dp under the line's", 1, status.bottom - text.bottom)
    }

    @Test
    fun aFullLastLinePutsTheTimeOnItsOwnLine() {
        var words by mutableStateOf(1)
        rule.setHappyContent { UserMessage(row("word ".repeat(words).trim(), MessageDelivery.Accepted), gray, MessageCallbacks()) }
        // Grow the message until its last line leaves the box no room.
        var own = false
        while (!own && words < 120) {
            words++
            rule.waitForIdle()
            own = rule.node(DeliveryTags.STATUS).bounds.top >= rule.node(MarkdownTags.TEXT).bounds.bottom - 0.5.dp
        }
        assertTrue("some length puts the time on its own line", own)
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        val text = rule.node(MarkdownTags.TEXT).bounds
        val status = rule.node(DeliveryTags.STATUS).bounds
        assertDp("under the words' last line, in their margin", 0, status.top - text.bottom)
        assertDp("the bubble grows by what the margin can't hold", 14 - 10, bubble.bottom - 4.dp - (text.bottom + 10.dp))
        assertDp("still at the end", 12, bubble.right - status.right)
        assertTrue("bubble no wider than the column", bubble.right <= (PHONE_WIDTH - 16).dp + 0.5.dp)
    }

    @Test
    fun theBubbleNeverMovesAsTheMarkSettles() {
        var delivery by mutableStateOf(MessageDelivery.Sending)
        rule.setHappyContent { UserMessage(row("Ship it", delivery), gray, MessageCallbacks()) }
        val frames = ArrayList<Pair<DpRect, DpRect>>()
        for (next in listOf(MessageDelivery.Sending, MessageDelivery.Received, MessageDelivery.Accepted, MessageDelivery.Failed, MessageDelivery.Sending)) {
            delivery = next
            rule.waitForIdle()
            frames += rule.node(MessageTags.USER_BUBBLE).bounds to rule.node(DeliveryTags.TIME).bounds
        }
        for (frame in frames) assertEquals(frames.first(), frame)
    }

    @Test
    fun ownMarksReplaceTheSendingLineAndTheDimming() {
        rule.setHappyContent {
            UserMessage(row("on its way", MessageDelivery.Sending, pending = true).let {
                it.copy(message = it.message.copy(createdAt = System.currentTimeMillis() - 60_000))
            }, gray, MessageCallbacks())
        }
        rule.onAllNodesWithText("Sending…").assertCountEquals(0)
        rule.node(DeliveryTags.MARK).assertExists()
    }
}
