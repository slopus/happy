package com.slopus.happy.ui.conversation

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.view.animation.LinearInterpolator
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatPendingSlot
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenSlots
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.components.RecomposeProbe
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A frame of the keyboard's animation is a translation (KeyboardLift,
 * Telegram's AdjustPanLayoutHelper): the IME's animation is dispatched as
 * the platform does, down from the decor view, and each of its frames
 * composes nothing, measures and places nothing, runs no positioned
 * callback, and doesn't reach the Compose view's own insets; the layout
 * takes the keyboard once, at the end of a show, at the start of a hide.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE, sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class KeyboardFrameTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var compose: View
    private val keyboardPx = 900
    private val navigationPx = 63

    @After fun off() {
        RecomposeProbe.counts = null
    }

    private fun conversation(): ConversationState {
        val builder = ConversationRowBuilder { 1_000_000L }
        val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
        val rows = (1..30).map { Message("m$it", if (it % 2 == 0) "user" else "agent", it.toLong(), listOf(Block.Text("Message $it, long enough to wrap onto a second line of the transcript."))) }
            .flatMap { builder.rows(it, "a1", null, false) }.asReversed()
        return ConversationState(created = true, loaded = true, agent = agent, rows = rows)
    }

    private fun show(content: @Composable () -> Unit) {
        rule.setHappyContent {
            compose = LocalView.current
            content()
        }
        rule.waitForIdle()
        apply(0)
        rule.waitForIdle()
    }

    private fun insets(ime: Int): WindowInsets = WindowInsets.Builder()
        .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, navigationPx))
        .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, ime))
        .setVisible(WindowInsets.Type.ime(), ime > 0)
        .build()

    private val decor: View get() = compose.rootView

    private fun apply(ime: Int) = rule.runOnUiThread { decor.dispatchApplyWindowInsets(insets(ime)) }

    /** Whether the Compose view has a measure, a placement or a positioned callback waiting (Owner's, through its JVM getter). */
    private fun pendingLayout(): Boolean =
        compose.javaClass.getMethod("getHasPendingMeasureOrLayout").invoke(compose) as Boolean

    /**
     * The platform's IME animation from [from] to [to] in [frames] frames:
     * prepare, the end state's insets applied, start, progress each frame
     * (checked as it runs, before the frame), end.
     */
    private fun animate(from: Int, to: Int, frames: Int = 8, eachFrame: (Int) -> Unit) {
        val animation = WindowInsetsAnimation(WindowInsets.Type.ime(), LinearInterpolator(), 250)
        rule.runOnUiThread {
            decor.dispatchWindowInsetsAnimationPrepare(animation)
            decor.dispatchApplyWindowInsets(insets(to))
            decor.dispatchWindowInsetsAnimationStart(animation, WindowInsetsAnimation.Bounds(Insets.NONE, Insets.of(0, 0, 0, maxOf(from, to))))
        }
        // The start's own layout: the end state applied, the layout's height for the keyboard.
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        for (frame in 1..frames) {
            val fraction = frame.toFloat() / (frames + 1)
            rule.runOnUiThread {
                animation.fraction = fraction
                decor.dispatchWindowInsetsAnimationProgress(insets((from + (to - from) * fraction).toInt()), mutableListOf(animation))
            }
            eachFrame(frame)
            rule.mainClock.advanceTimeByFrame()
        }
        rule.runOnUiThread { decor.dispatchWindowInsetsAnimationEnd(animation) }
    }

    @Test fun `a frame of the keyboard in a conversation composes and lays out nothing`() {
        show { ConversationScreen(conversation(), ConversationScreenActions()) }
        val restingDock = rule.node(ConversationComposerTags.PILL).bounds
        rule.mainClock.autoAdvance = false
        val counts = HashMap<String, Int>()
        for ((from, to) in listOf(0 to keyboardPx, keyboardPx to 0)) {
            animate(from, to) { frame ->
                if (frame == 1) RecomposeProbe.counts = counts
                assertFalse("frame $frame of $from → $to asks for no measure, placement or positioned callback", pendingLayout())
            }
            RecomposeProbe.counts = null
            assertEquals("nothing composed on the keyboard's frames ($from → $to)", emptyMap<String, Int>(), counts)
            // The end's layout (a show's: the keyboard's height enters it).
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals("the composer settles where it started", restingDock, rule.node(ConversationComposerTags.PILL).bounds)
    }

    @Test fun `the conversation is laid out above the keyboard once it is up, and the keyboard's frames draw it higher`() {
        show { ConversationScreen(conversation(), ConversationScreenActions()) }
        val resting = rule.node(ConversationComposerTags.PILL).bounds
        val density = compose.resources.displayMetrics.density
        rule.mainClock.autoAdvance = false
        val drawn = ArrayList<Int>()
        animate(0, keyboardPx) {
            // Laid out where it was until the show ends: the frames only draw it higher.
            assertEquals(resting, rule.node(ConversationComposerTags.PILL).bounds)
            drawn += KeyboardMotion.of(compose).lift
        }
        assertTrue("the lift rises with the keyboard: $drawn", drawn.zipWithNext().all { (a, b) -> b > a } && drawn.first() > 0)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val up = rule.node(ConversationComposerTags.PILL).bounds
        assertEquals("above the keyboard once it is up", (keyboardPx - navigationPx) / density, (resting.top - up.top).value, 1f)
        assertEquals("nothing left to draw higher", 0, KeyboardMotion.of(compose).lift)
    }

    @Test fun `a frame of the keyboard in the legacy chat lays out nothing`() {
        val rows = (0 until 20).map { ChatReduction.buildRow(ChatMessage.AgentText("a$it", it.toLong(), "Reply $it"), true)!! }.asReversed()
        val session = ChatSessionInfo.from(
            SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux"}""", 1, null, 1, "", null),
        )
        show { ChatScreen(ChatState(ChatSnapshot(rows, loaded = true), session, sessionLoaded = true, online = true), draft = "", bubbleColor = "gray", actions = ChatScreenActions()) }
        val resting = rule.node(ComposerTags.COMPOSER).bounds
        rule.mainClock.autoAdvance = false
        for ((from, to) in listOf(0 to keyboardPx, keyboardPx to 0)) {
            animate(from, to) { frame -> assertFalse("frame $frame of $from → $to lays out nothing", pendingLayout()) }
            rule.mainClock.advanceTimeByFrame()
            if (to > 0) assertTrue("the composer is above the keyboard", rule.node(ComposerTags.COMPOSER).bounds.top < resting.top)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(resting, rule.node(ComposerTags.COMPOSER).bounds)
    }

    @Test fun `a chat being started holds its block where the keyboard leaves it, up or down`() {
        val session = ChatSessionInfo.from(
            SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux"}""", 1, null, 1, "", null),
        )
        val pending = ChatPendingSlot(session, headerShown = false) {
            Box(Modifier.fillMaxSize()) { Box(Modifier.align(Alignment.Center).size(120.dp).testTag("block")) }
        }
        show { ChatScreen(ChatState(ChatSnapshot(loaded = true), null, sessionLoaded = true, online = true), draft = "", bubbleColor = "gray", actions = ChatScreenActions(), slots = ChatScreenSlots(pending = pending)) }
        val down = rule.node(ComposerTags.COMPOSER).bounds
        rule.mainClock.autoAdvance = false
        for ((from, to) in listOf(0 to keyboardPx, keyboardPx to 0, 0 to keyboardPx)) {
            animate(from, to) { frame -> assertFalse("frame $frame of $from → $to lays out nothing", pendingLayout()) }
            rule.mainClock.advanceTimeByFrame()
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val up = rule.node("block").bounds
        assertTrue("clear of the composer over the keyboard", up.bottom <= rule.node(ComposerTags.COMPOSER).bounds.top)
        assertTrue("the composer is above the keyboard", rule.node(ComposerTags.COMPOSER).bounds.top < down.top)
        rule.mainClock.autoAdvance = false
        animate(keyboardPx, 0) { frame -> assertFalse("frame $frame of the hide lays out nothing", pendingLayout()) }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals("the keyboard going leaves the block where it was", up, rule.node("block").bounds)
        assertEquals(down, rule.node(ComposerTags.COMPOSER).bounds)
    }
}
