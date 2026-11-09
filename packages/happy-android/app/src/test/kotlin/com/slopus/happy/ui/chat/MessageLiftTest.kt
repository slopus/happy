package com.slopus.happy.ui.chat

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.click
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.MessageDelivery
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.Problem
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Holding a message lifts it over the dimmed chat with Copy and Select
 * (iOS 8c2a92172; Telegram's extracted context menu): a person's bubble as
 * itself, an answer on a card, in both chats.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MessageLiftTest {
    @get:Rule
    val rule = createComposeRule()

    private val session = ChatSessionInfo.from(
        SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux"}""", 1, null, 1, "", null),
    )

    private fun user(text: String) =
        (ChatReduction.buildRow(ChatMessage.UserText("u", "l", 0, text), isClaudeFlavor = false) as ChatRow.User)
            .copy(delivery = MessageDelivery.Accepted, time = 1_700_000_000_000)

    private fun showRelay(rows: List<ChatRow>) {
        rule.setHappyContent {
            ChatScreen(
                state = ChatState(ChatSnapshot(rows, loaded = true), session, sessionLoaded = true, online = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
            )
        }
        rule.waitForIdle()
    }

    private val agent = AgentInfo("a1", "w1", null, "Lift", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)

    private val clipboard get() = RuntimeEnvironment.getApplication().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private fun shot(name: String) {
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** How many pixels are near black: the words. */
    private fun inked(bitmap: Bitmap): Int {
        var n = 0
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val c = bitmap.getPixel(x, y)
            if (android.graphics.Color.red(c) + android.graphics.Color.green(c) + android.graphics.Color.blue(c) < 200) n++
        }
        return n
    }

    private fun lifted() = rule.onAllNodesWithTag(MessageLiftTags.MESSAGE, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun holdingABubbleLiftsItWithItsMenuSevenUnderItsTrailingEdge() {
        showRelay(listOf(user("Hello there")))
        val bubble = rule.node(MessageTags.USER_BODY).bounds
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        shot("lift-bubble")
        val message = rule.node(MessageLiftTags.MESSAGE).bounds
        val menu = rule.node(MessageLiftTags.MENU).bounds
        // The composer stays clear: a bubble resting on it rises just enough for its menu to keep 10 above.
        assertEquals("as it rested, across", bubble.left to bubble.right, message.left to message.right)
        assertDp("as tall as it rested", bubble.bottom - bubble.top, message.bottom - message.top)
        assertDp("its menu 10 above the composer", 10, rule.node(ChatScreenTags.DOCK).bounds.top - menu.bottom)
        assertTrue("the lifted bubble draws its words", inked(rule.node(MessageLiftTags.MESSAGE).captureToImage().asAndroidBitmap()) > 50)
        assertDp("the menu 7 under it", 7, menu.top - message.bottom)
        assertDp("leaning 7 in from its trailing edge", 7, message.right - menu.right)
        rule.node(MessageLiftTags.COPY).assertExists()
        rule.node(MessageLiftTags.SELECT).assertExists()
        // Copy takes the words and puts the message back.
        rule.node(MessageLiftTags.COPY).performClick()
        rule.waitForIdle()
        assertEquals("Hello there", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertTrue("back in its row", !lifted())
    }

    @Test
    fun aChatPaneOffTheWindowsEdgeLiftsInPlace() {
        // A tablet's chat sits beside the list: the lift is drawn in the pane, the source measured in the window.
        rule.setHappyContent {
            Box(Modifier.padding(start = 120.dp, top = 40.dp)) {
                ChatScreen(
                    state = ChatState(ChatSnapshot(listOf(user("Hello there")), loaded = true), session, sessionLoaded = true, online = true),
                    draft = "",
                    bubbleColor = "gray",
                    actions = ChatScreenActions(),
                )
            }
        }
        rule.waitForIdle()
        val bubble = rule.node(MessageTags.USER_BODY).bounds
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        val message = rule.node(MessageLiftTags.MESSAGE).bounds
        assertEquals("over where it rested, across", bubble.left to bubble.right, message.left to message.right)
        assertDp("its menu 10 above the pane's composer", 10, rule.node(ChatScreenTags.DOCK).bounds.top - rule.node(MessageLiftTags.MENU).bounds.bottom)
    }

    @Test
    fun aTapOutsidePutsItBack() {
        showRelay(listOf(user("Hello there")))
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.node(MessageLiftTags.SCRIM).performTouchInput { click(androidx.compose.ui.geometry.Offset(20f, 200f)) }
        rule.mainClock.advanceTimeBy(100)
        assertTrue("on its way back over 0.2 s", lifted())
        rule.mainClock.advanceTimeBy(300)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertTrue(!lifted())
    }

    @Test
    fun selectLaysTheWordsOutAgainAllSelected() {
        showRelay(listOf(user("Hello there")))
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        rule.node(MessageLiftTags.SELECT).performClick()
        rule.waitForIdle()
        shot("lift-select")
        rule.node(MessageLiftTags.MENU).assertDoesNotExist()
        // The row's words, and the lift's own laid out to select.
        assertEquals(2, rule.onAllNodesWithText("Hello there", useUnmergedTree = true).fetchSemanticsNodes().size)
        val words = rule.onAllNodesWithText("Hello there", useUnmergedTree = true)
        val message = rule.node(MessageLiftTags.MESSAGE).bounds
        val laid = (0..1).map { words[it].bounds }
        assertTrue("laid out on the lifted bubble's words: $laid vs $message", laid.any { it.top >= message.top - 0.5.dp && it.bottom <= message.bottom + 0.5.dp })
    }

    @Test
    fun anAnswerLiftsOnACard() {
        val answer = ChatReduction.buildRow(ChatMessage.AgentText("a", 2, "The redirect loops because the cookie is never written."), true)!!
        showRelay(listOf(answer, user("Why does it loop?")))
        val row = rule.node(MessageTags.AGENT).bounds
        rule.node(MessageTags.AGENT).performTouchInput { longClick() }
        rule.waitForIdle()
        shot("lift-answer")
        val message = rule.node(MessageLiftTags.MESSAGE).bounds
        val menu = rule.node(MessageLiftTags.MENU).bounds
        assertDp("a full-width answer's menu keeps 12 from the screen's side", 12, menu.left)
        assertTrue("lifted around the answer's words", message.bottom - message.top >= row.bottom - row.top)
        assertTrue("the card draws the answer's words", inked(rule.node(MessageLiftTags.MESSAGE).captureToImage().asAndroidBitmap()) > 50)
        rule.node(MessageLiftTags.COPY).performClick()
        rule.waitForIdle()
        assertEquals("The redirect loops because the cookie is never written.", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }

    @Test
    fun selectKeepsAMessageThatMovedUpForItsMenuWhereItIs() {
        // A refused send's menu is four rows long: Copy, Select, Retry, Discard.
        val failed = ConversationRow.User("x:user", "x", "Ship it", parseMarkdown("Ship it"), emptyList(), Delivery.Failed(Problem.Said("Unknown model.")))
        rule.setHappyContent { ConversationScreen(ConversationState(created = true, loaded = true, rows = listOf(failed), agent = agent), ConversationScreenActions()) }
        rule.waitForIdle()
        val row = rule.node(MessageTags.USER_BODY).bounds
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        val lifted = rule.node(MessageLiftTags.MESSAGE).bounds
        assertTrue("moved up to make room for its menu: $lifted vs $row", lifted.top < row.top - 10.dp)
        rule.node(MessageLiftTags.SELECT).performClick()
        rule.waitForIdle()
        assertEquals(lifted, rule.node(MessageLiftTags.MESSAGE).bounds)
    }

    @Test
    fun aRefusedSendsMenuKeepsRetryAndDiscard() {
        val retries = ArrayList<String>()
        val failed = ConversationRow.User("x:user", "x", "Ship it", parseMarkdown("Ship it"), emptyList(), Delivery.Failed(Problem.Said("Unknown model.")))
        rule.setHappyContent {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = listOf(failed), agent = agent), ConversationScreenActions(onRetrySend = { retries += it }))
        }
        rule.waitForIdle()
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        rule.node(MessageTags.USER_DISCARD).assertExists()
        rule.node(MessageTags.USER_RETRY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("x"), retries)
        assertTrue(!lifted())
    }

    @Test
    fun anAgentChatsAnswerLiftsToo() {
        val rows = listOf(ConversationRow.Text("m:0", "Looking at the callback first.", parseMarkdown("Looking at the callback first.")))
        rule.setHappyContent { ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent), ConversationScreenActions()) }
        rule.waitForIdle()
        rule.onAllNodesWithTag(MessageTags.AGENT, useUnmergedTree = true)[0].performTouchInput { longClick() }
        rule.waitForIdle()
        shot("lift-agent-answer")
        rule.node(MessageLiftTags.MENU).assertExists()
        rule.node(MessageLiftTags.COPY).performClick()
        rule.waitForIdle()
        assertEquals("Looking at the callback first.", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }

    /** [bitmap]'s mean red, green and blue over [x] by [y] at its centre, 0 to 255. */
    private fun tone(bitmap: Bitmap, x: Int, y: Int): Int {
        var sum = 0L
        val n = 9
        for (dy in -1..1) for (dx in -1..1) {
            val c = bitmap.getPixel(x + dx, y + dy)
            sum += android.graphics.Color.red(c) + android.graphics.Color.green(c) + android.graphics.Color.blue(c)
        }
        return (sum / (3 * n)).toInt()
    }

    /** How far two colours are apart, in the channel that moved most. */
    private fun apart(a: Int, b: Int): Int = maxOf(
        kotlin.math.abs(android.graphics.Color.red(a) - android.graphics.Color.red(b)),
        kotlin.math.abs(android.graphics.Color.green(a) - android.graphics.Color.green(b)),
        kotlin.math.abs(android.graphics.Color.blue(a) - android.graphics.Color.blue(b)),
    )

    private fun liftAnAnswerOverTheComposer(dark: Boolean): Triple<Bitmap, Bitmap, androidx.compose.ui.unit.DpRect> {
        val rows = listOf(ConversationRow.Text("m:0", "Looking at the callback first.", parseMarkdown("Looking at the callback first.")))
        rule.setHappyContent(dark = dark) { ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent), ConversationScreenActions()) }
        rule.waitForIdle()
        val before = rule.onRoot().captureToImage().asAndroidBitmap()
        rule.onAllNodesWithTag(MessageTags.AGENT, useUnmergedTree = true)[0].performTouchInput { longClick() }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        return Triple(before, rule.onRoot().captureToImage().asAndroidBitmap(), rule.node(com.slopus.happy.ui.conversation.ConversationComposerTags.COMPOSER).bounds)
    }

    @Test
    fun theComposerStaysSharpAndTheLightVeilIsWhite() {
        val (before, after, composer) = liftAnAnswerOverTheComposer(dark = false)
        shot("lift-veil-light")
        val density = RuntimeEnvironment.getApplication().resources.displayMetrics.density
        // The composer's pill draws as it did, unveiled and unblurred.
        val top = (composer.top.value * density).toInt() + 4
        val bottom = (composer.bottom.value * density).toInt() - 4
        var moved = 0
        val rows = sortedSetOf<Int>()
        for (y in top until bottom step 3) for (x in 0 until before.width step 3) if (apart(before.getPixel(x, y), after.getPixel(x, y)) > 16) { moved++; rows += y }
        assertEquals("the composer is neither veiled nor dimmed (top $top, rows $rows)", 0, moved)
        // Above it the chat reads white and frosted, not grey.
        assertTrue("white veil: ${tone(after, 40, top - 120)}", tone(after, 40, top - 120) > 240)
        // The lifted card and its menu keep above the composer.
        assertTrue(rule.node(MessageLiftTags.MESSAGE).bounds.bottom <= composer.top)
        assertTrue(rule.node(MessageLiftTags.MENU).bounds.bottom <= composer.top)
    }

    @Test
    fun theDarkVeilIsDarkAndLeavesTheComposerToo() {
        val (before, after, composer) = liftAnAnswerOverTheComposer(dark = true)
        shot("lift-veil-dark")
        val density = RuntimeEnvironment.getApplication().resources.displayMetrics.density
        val top = (composer.top.value * density).toInt() + 4
        val bottom = (composer.bottom.value * density).toInt() - 4
        var moved = 0
        val rows = sortedSetOf<Int>()
        for (y in top until bottom step 3) for (x in 0 until before.width step 3) if (apart(before.getPixel(x, y), after.getPixel(x, y)) > 16) { moved++; rows += y }
        assertEquals("the composer is neither veiled nor dimmed (top $top, rows $rows)", 0, moved)
        assertTrue("dark veil: ${tone(after, 40, top - 120)}", tone(after, 40, top - 120) < 40)
    }
}
