package com.slopus.happy.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** AgentInput.tsx's press handling on the chat composer: Stop, a refused send, Send. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerFeelTest {
    @get:Rule
    val rule = createComposeRule()

    private val plain = """{"path":"/p","host":"h","summary":{"text":"Busy","updatedAt":1}}"""
    private val rigNoSteering =
        """{"path":"/p","host":"h","client":{"id":"rig","name":"Happy Agent","version":"1"},"rigMetadataVersion":1,"summary":{"text":"Busy","updatedAt":1}}"""

    private fun state(thinking: Boolean, metadata: String = plain) = ChatState(
        ChatSnapshot(loaded = true),
        ChatSessionInfo.from(SessionRecord("s", 0, 0, 1, true, 0, metadata, 1, null, 1, "", null)),
        sessionLoaded = true,
        online = true,
        thinking = thinking,
    )

    /** The furthest [tag] strays from [resting] over the 300 ms shake, frame by frame. */
    private fun travel(tag: String, resting: Float): Float =
        (1..30).maxOf { rule.mainClock.advanceTimeBy(16); kotlin.math.abs(rule.node(tag).bounds.left.value - resting) }

    private fun primaryIs(label: String) = rule.node(ComposerTags.PRIMARY).assert(hasContentDescription(label))

    // The spinner holds 300 ms even when the agent answers at once; then Stop
    // stays away while the agent is still busy, and comes back on its next turn.
    @Test
    fun stopSpinsThenStaysAwayUntilTheNextTurn() {
        var thinking by mutableStateOf(true)
        var aborts = 0
        rule.setHappyContent {
            ChatScreen(state(thinking), draft = "", bubbleColor = "gray", actions = ChatScreenActions(onAbort = { aborts++ }))
        }
        primaryIs("Stop").assertIsEnabled()
        rule.mainClock.autoAdvance = false
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.mainClock.advanceTimeBy(200)
        assertEquals(1, aborts)
        rule.node(ComposerTags.PRIMARY).assertIsNotEnabled()
        rule.mainClock.advanceTimeBy(200)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        primaryIs("Send").assertIsNotEnabled()
        thinking = false
        rule.waitForIdle()
        thinking = true
        rule.waitForIdle()
        primaryIs("Stop").assertIsEnabled()
    }

    // A stop that fails shakes the button, with no alert, and offers Stop again.
    @Test
    fun aFailedStopComesBack() {
        val gate = CompletableDeferred<Unit>()
        rule.setHappyContent {
            ChatScreen(
                state(thinking = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(onAbort = { gate.await(); error("offline") }),
            )
        }
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        rule.node(ComposerTags.PRIMARY).assertIsNotEnabled()
        val resting = rule.node(ComposerTags.PRIMARY).bounds.left
        rule.mainClock.autoAdvance = false
        gate.complete(Unit)
        assertEquals("the button shakes 3 either way", 3f, travel(ComposerTags.PRIMARY, resting.value), 0.1f)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        primaryIs("Stop").assertIsEnabled()
        assertEquals(resting, rule.node(ComposerTags.PRIMARY).bounds.left)
    }

    // A busy Happy Agent that can't be steered refuses the send: the card shakes and nothing is sent.
    @Test
    fun aRefusedSendShakesTheCard() {
        val sent = mutableListOf<String>()
        rule.setHappyContent {
            ChatScreen(
                state(thinking = true, metadata = rigNoSteering),
                draft = "hello",
                bubbleColor = "gray",
                actions = ChatScreenActions(onSend = { sent += it }),
            )
        }
        rule.node(ComposerTags.PRIMARY).assertIsEnabled()
        val resting = rule.node(ComposerTags.PANEL).bounds.left
        rule.mainClock.autoAdvance = false
        rule.node(ComposerTags.PRIMARY).performClick()
        assertEquals("the card shakes 3 either way", 3f, travel(ComposerTags.PANEL, resting.value), 0.1f)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(resting, rule.node(ComposerTags.PANEL).bounds.left)
        assertEquals(emptyList<String>(), sent)
    }

    // AgentInput handleKeyPress: a hardware Escape stops a busy agent; an idle one ignores it.
    @OptIn(ExperimentalTestApi::class)
    @Test
    fun escapeStops() {
        var thinking by mutableStateOf(true)
        var aborts = 0
        rule.setHappyContent {
            ChatScreen(state(thinking), draft = "", bubbleColor = "gray", actions = ChatScreenActions(onAbort = { aborts++ }))
        }
        rule.node(ComposerTags.INPUT).performClick()
        rule.node(ComposerTags.INPUT).performKeyInput { pressKey(Key.Escape) }
        rule.waitForIdle()
        assertEquals(1, aborts)
        thinking = false
        rule.waitForIdle()
        rule.node(ComposerTags.INPUT).performKeyInput { pressKey(Key.Escape) }
        rule.waitForIdle()
        assertEquals(1, aborts)
    }

    @Test
    fun sendSendsTheDraft() {
        val sent = mutableListOf<String>()
        rule.setHappyContent {
            ChatScreen(state(thinking = false), draft = "hello", bubbleColor = "gray", actions = ChatScreenActions(onSend = { sent += it }))
        }
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("hello"), sent)
    }
}
