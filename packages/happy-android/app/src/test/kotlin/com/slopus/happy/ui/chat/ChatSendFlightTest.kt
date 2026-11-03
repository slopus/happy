package com.slopus.happy.ui.chat

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.MessageDelivery
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * A send in the Happy CLI chat flies from the composer into its bubble, as
 * the agent chat's does (iOS 3c24acf5c; Telegram TextMessageEnterTransition):
 * the row is drawn by the flight until it lands.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatSendFlightTest {
    @get:Rule
    val rule = createComposeRule()

    private val session = ChatSessionInfo.from(
        SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux"}""", 1, null, 1, "", null),
    )

    private fun agent(i: Int) = ChatReduction.buildRow(ChatMessage.AgentText("a$i", i.toLong(), "Answer number $i, long enough to take a line or two."), true)!!

    private var rows by mutableStateOf((1..8).map(::agent).asReversed())
    private var draft by mutableStateOf("")

    private fun show() {
        rule.setHappyContent {
            ChatScreen(
                state = ChatState(ChatSnapshot(rows, loaded = true), session, sessionLoaded = true, online = true),
                draft = draft,
                bubbleColor = "gray",
                actions = ChatScreenActions(
                    onDraftChange = { draft = it },
                    onSend = { text ->
                        val sent = ChatReduction.buildRow(ChatMessage.UserText("sent", "l", 100, text, pending = true), isClaudeFlavor = false) as ChatRow.User
                        rows = listOf(sent.copy(delivery = MessageDelivery.Sending, time = 1_700_000_000_000)) + rows
                        draft = ""
                    },
                ),
            )
        }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun bubble(): Bitmap = rule.node(MessageTags.USER_BUBBLE).captureToImage().asAndroidBitmap()

    @Test
    fun aSendAtTheNewestEndFliesIntoItsBubble() {
        show()
        rule.node(ComposerTags.INPUT).performTextInput("Ship it")
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.node(ComposerTags.PRIMARY).performClick()
        var frames = 0
        while (rows.first().key != "sent" && frames++ < 30) rule.mainClock.advanceTimeByFrame()
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        // On its way: its place doesn't yet show it as it will be.
        val start = bubble()
        shot("legacy-flight-start")
        rule.mainClock.advanceTimeBy(100)
        shot("legacy-flight-middle")
        rule.mainClock.advanceTimeBy(400)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val landed = bubble()
        shot("legacy-flight-landed")
        assertTrue("landed: the bubble drawn in its place", landed.getPixel(landed.width / 2, 6) != landed.getPixel(0, 0))
        var changed = 0
        for (y in 0 until minOf(landed.height, start.height)) for (x in 0 until minOf(landed.width, start.width)) if (landed.getPixel(x, y) != start.getPixel(x, y)) changed++
        assertTrue("at its start the bubble wasn't yet in its place: $changed pixels changed", changed > landed.width * landed.height / 10)
        assertTrue("its time and mark came with it", rule.onAllNodesWithTag(DeliveryTags.MARK, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        assertTrue("the bubble rests above the composer", rule.node(MessageTags.USER_BUBBLE).bounds.bottom <= rule.node(ComposerTags.PANEL).bounds.top)
    }

    @Test
    fun aSendWhileReadingOlderHistoryDoesNotFly() {
        show()
        rule.node(ChatListTags.LIST).performScrollToNode(hasText("Answer number 1,", substring = true))
        rule.waitForIdle()
        rule.node(ComposerTags.INPUT).performTextInput("Ship it")
        rule.waitForIdle()
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        rule.node(ChatListTags.LIST).performScrollToNode(hasText("Ship it"))
        rule.mainClock.autoAdvance = false
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        // Not held for a flight: drawn in place at once.
        val image = bubble()
        assertTrue("drawn in place", image.getPixel(image.width / 2, 6) != image.getPixel(0, 0))
        rule.mainClock.autoAdvance = true
        rule.onNodeWithText("Ship it").assertExists()
    }
}
