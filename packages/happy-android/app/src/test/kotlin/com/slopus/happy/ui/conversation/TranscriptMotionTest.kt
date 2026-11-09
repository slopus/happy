package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.Message
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
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Telegram's list motion on the transcript: a row arriving at the newest
 * end fades and grows in while the rows above move up for it, over 250 ms
 * on cubic-bezier(0.199, 0.011, 0.279, 0.910); a message just sent flies
 * from the composer into its bubble.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TranscriptMotionTest {
    @get:Rule val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Motion", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val history = (1..12).flatMap { i ->
        ConversationRowBuilder.build(Message("m$i", if (i % 2 == 0) "agent" else "user", i.toLong(), listOf(Block.Text("Message number $i, long enough to take a line or two."))), "a1", null, false)
    }.asReversed()

    private var rows by mutableStateOf(history)

    private fun show(onSend: (String) -> Boolean = { false }) {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = rows, agent = agent),
                ConversationScreenActions(onSend = { text, _ -> onSend(text) }),
            )
        }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** How many of [image]'s pixels differ from its top-left one, the background. */
    private fun inked(image: Bitmap): Int {
        val ground = image.getPixel(0, 0)
        var n = 0
        for (y in 0 until image.height) for (x in 0 until image.width) if (image.getPixel(x, y) != ground) n++
        return n
    }

    private fun top(text: String): Dp = rule.onNodeWithText(text, substring = true).bounds.top

    @Test fun `a row arriving at the newest end fades and grows in as the rows above move up for it`() {
        assertEquals(250, TranscriptMotionSpec.MILLIS)
        assertEquals(0.9f, TranscriptMotionSpec.ENTER_SCALE)
        // cubic-bezier(0.199, 0.011, 0.279, 0.910): slow off the mark, most of the way by the middle.
        assertEquals(0.7426f, TranscriptMotionSpec.easing.transform(0.5f), 1e-3f)
        assertEquals(0.0819f, TranscriptMotionSpec.easing.transform(0.1f), 1e-3f)
        show()
        val before = top("Message number 12")
        rule.mainClock.autoAdvance = false
        rows = listOf(ConversationRow.Text("new:0", "A new answer, just in.", parseMarkdown("A new answer, just in."))) + rows
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        // Its first frames: the rows above still where they were, the new one under the list's end.
        assertEquals("the newest row hasn't moved yet", before.value, top("Message number 12").value, 1f)
        rule.mainClock.advanceTimeBy(125)
        val middle = top("Message number 12")
        assertTrue("moving up at 125 ms: $middle vs $before", middle < before - 4.dp)
        rule.mainClock.advanceTimeBy(400)
        val after = top("Message number 12")
        assertTrue("further up once settled: $after vs $middle", after < middle)
        assertTrue("the new row drawn", inked(rule.onNodeWithText("A new answer", substring = true).captureToImage().asAndroidBitmap()) > 0)
        rule.mainClock.autoAdvance = true
        shot("motion-arrived")
    }

    @Test fun `reading older history, a row arriving moves nothing`() {
        show()
        rule.node(ConversationScreenTags.LIST).performScrollToNode(hasText("Message number 2", substring = true))
        rule.waitForIdle()
        val before = top("Message number 2")
        rule.mainClock.autoAdvance = false
        rows = listOf(ConversationRow.Text("new:0", "Elsewhere", parseMarkdown("Elsewhere"))) + rows
        repeat(5) { rule.mainClock.advanceTimeByFrame() }
        assertEquals(before.value, top("Message number 2").value, 0.5f)
        rule.mainClock.autoAdvance = true
    }

    @Test fun `a message sent at the newest end flies from the composer into its bubble`() {
        assertEquals(10, TranscriptMotionSpec.FLIGHT_LINES)
        show { text ->
            rows = listOf(ConversationRow.User("s:user", "s", text, parseMarkdown(text), emptyList(), Delivery.Sending)) + rows
            true
        }
        rule.node(ConversationComposerTags.INPUT).performTextInput("Ship it")
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        var frames = 0
        while (rows.first().key != "s:user" && frames++ < 30) rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        // On its way: where it lands isn't yet what it will be, the words still near the composer.
        val start = rule.node(com.slopus.happy.ui.chat.MessageTags.USER_BUBBLE).captureToImage().asAndroidBitmap()
        shot("flight-start")
        rule.mainClock.advanceTimeBy(100)
        shot("flight-middle")
        rule.mainClock.advanceTimeBy(400)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val landed = rule.node(com.slopus.happy.ui.chat.MessageTags.USER_BUBBLE).captureToImage().asAndroidBitmap()
        // Its rounded corner is the screen; inside its top edge, the bubble's fill.
        assertTrue("landed: the bubble drawn in its place", landed.getPixel(landed.width / 2, 6) != landed.getPixel(0, 0))
        var changed = 0
        for (y in 0 until minOf(landed.height, start.height)) for (x in 0 until minOf(landed.width, start.width)) if (landed.getPixel(x, y) != start.getPixel(x, y)) changed++
        assertTrue("at its start the bubble wasn't yet in its place: $changed pixels changed", changed > landed.width * landed.height / 10)
        assertTrue("the bubble rests above the composer", rule.onNodeWithText("Ship it").bounds.bottom <= rule.node(ConversationComposerTags.PILL).bounds.top)
        shot("flight-landed")
    }

    @Test fun `a long message doesn't fly, it is just there`() {
        val long = (1..14).joinToString("\n") { "line $it" }
        show { text ->
            rows = listOf(ConversationRow.User("s:user", "s", text, parseMarkdown(text), emptyList(), Delivery.Sending)) + rows
            true
        }
        rule.node(ConversationComposerTags.INPUT).performTextInput(long)
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        // It enters as any arriving row: its bubble drawn well before 250 ms, not held for a flight.
        rule.mainClock.advanceTimeBy(400)
        assertTrue(inked(rule.node(com.slopus.happy.ui.chat.MessageTags.USER_BUBBLE).captureToImage().asAndroidBitmap()) > 0)
        rule.mainClock.autoAdvance = true
    }
}
