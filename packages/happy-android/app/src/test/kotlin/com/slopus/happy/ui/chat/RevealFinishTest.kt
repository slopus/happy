package com.slopus.happy.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.Message
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A reply that stops streaming mid-reveal, because the run ended or the
 * agent went on to a tool call, lets the rest out in 0.3 s (iOS 70c8f6de7),
 * not at the pace it was streaming.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RevealFinishTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun aToolCallAfterTheWordsStopsThemStreaming() {
        val builder = ConversationRowBuilder { 0L }
        val words = Message("m", "agent", 1, listOf(Block.Text("Looking at the callback first.")))
        assertNotNull("the newest block streams", (builder.rows(words, "a1", null, true).single() as ConversationRow.Text).live)
        val then = words.copy(content = words.content + Block.ToolCall("t1", "Bash", "running", null))
        val text = builder.rows(then, "a1", null, true).filterIsInstance<ConversationRow.Text>().single()
        assertNull("followed by a tool call, no more words come to it", text.live)
    }

    /** Inked pixels in the bottom fifth of the answer's words, above its copy button: its last line, out or not yet. */
    private fun lastLineInk(): Int {
        val box = rule.node(MessageTags.AGENT).bounds
        val words = rule.node(MessageTags.AGENT_COPY).bounds.top - box.top
        val image = rule.node(MessageTags.AGENT).captureToImage().asAndroidBitmap()
        val bottom = (image.height * (words / (box.bottom - box.top))).toInt()
        val ground = image.getPixel(0, 0)
        var n = 0
        for (y in bottom * 4 / 5 until bottom) for (x in 0 until image.width) if (image.getPixel(x, y) != ground) n++
        return n
    }

    @Test
    fun wordsThatStopStreamingAreAllOutIn300Millis() {
        assertEquals(0.3f, TextRevealSpec.FINISH_SECONDS)
        var streaming by mutableStateOf(true)
        var text by mutableStateOf("Starting with the callback, which writes the session cookie.")
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            val row = ChatReduction.buildRow(ChatMessage.AgentText("a", 1, text), true) as ChatRow.AgentText
            AgentMessage(row, MessageCallbacks(), reveal = rememberTextReveal("a", streaming) { true })
        }
        repeat(20) { rule.mainClock.advanceTimeByFrame() }
        // Several lines at once, short of a burst: at its streaming pace about a second's worth.
        text += " " + "More words that run on and on across the line. ".repeat(6).trim()
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        streaming = false
        rule.mainClock.advanceTimeByFrame()
        assertEquals("the last line not out when it stopped", 0, lastLineInk())
        rule.mainClock.advanceTimeBy(150)
        assertEquals("not yet halfway", 0, lastLineInk())
        rule.mainClock.advanceTimeBy(200)
        assertTrue("all out 0.35 s after it stopped", lastLineInk() > 0)
        rule.mainClock.autoAdvance = true
    }
}
