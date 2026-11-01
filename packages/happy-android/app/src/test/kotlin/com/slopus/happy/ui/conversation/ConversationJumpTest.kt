package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.asAndroidBitmap
import java.io.File
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The agent chat's way back to the newest message (iOS's ChatJumpButton):
 * when it shows, where it sits, that it scrolls back, and that its arrow
 * shimmers exactly while the agent works.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationJumpTest {
    @get:Rule val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Long chat", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val rows = (1..40).flatMap { i ->
        ConversationRowBuilder.build(Message("m$i", if (i % 2 == 0) "agent" else "user", i.toLong(), listOf(Block.Text("Message number $i, long enough to take a line or two of the transcript."))), "a1", null, false)
    }.asReversed()

    private var activity by mutableStateOf<Activity?>(null)

    private fun show() {
        rule.setHappyContent { ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent, activity = activity), null, ConversationScreenActions()) }
    }

    private fun jumps() = rule.onAllNodesWithTag(ConversationJumpTags.JUMP, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun readOlder() {
        rule.node(ConversationScreenTags.LIST).performTouchInput { swipeDown(startY = top + 200f, endY = bottom - 200f) }
        rule.waitForIdle()
    }

    private val working = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "working")
    private val still = SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)

    @Test fun theArrowShimmersWhileTheWorkingLineSpinsAndNotOnAQuestion() {
        assertFalse("Idle", jumpShimmers(null))
        assertFalse("A question waits on the person", jumpShimmers(Activity.AwaitingAnswer))
        for (phase in Activity.entries - Activity.AwaitingAnswer) assertTrue("$phase", jumpShimmers(phase))
    }

    @Test fun itShowsPast100dpFromTheNewestAsTelegramsDoes() {
        assertFalse(showsJump(300f, 900f, 300f))
        assertTrue(showsJump(301f, 900f, 300f))
        assertFalse("No list, no jump", showsJump(500f, 0f, 300f))
        assertEquals(100.dp, ConversationJumpSpec.threshold)
        assertEquals(280, ConversationJumpSpec.MOTION_MS)
        assertEquals(0.7f, ConversationJumpSpec.HIDDEN_SCALE)
        assertEquals(80.dp, ConversationJumpSpec.slide)
        assertEquals("decelerating", 0.75f, ConversationJumpSpec.decelerate.transform(0.5f), 1e-6f)
    }

    @Test fun itRisesGrowsAndFadesIn280ms() {
        show()
        rule.waitForIdle()
        val dockTop = rule.node(ConversationScreenTags.FADE).bounds.top
        rule.mainClock.autoAdvance = false
        rule.node(ConversationScreenTags.LIST).performTouchInput { swipeDown(startY = top + 200f, endY = bottom - 200f) }
        var frames = 0
        while (jumps() == 0 && frames++ < 120) rule.mainClock.advanceTimeByFrame()
        // Its first frame: on its way up from under the dock.
        rule.mainClock.advanceTimeByFrame()
        val early = rule.node(ConversationJumpTags.JUMP).bounds
        assertTrue("below its place as it starts: ${early.bottom} vs ${dockTop - 20.dp}", early.bottom > dockTop - 20.dp + 10.dp)
        rule.mainClock.advanceTimeBy(ConversationJumpSpec.MOTION_MS.toLong() + 32)
        assertDp("in its place after 280 ms", dockTop - 20.dp, rule.node(ConversationJumpTags.JUMP).bounds.bottom)
        rule.mainClock.autoAdvance = true
    }

    @Test fun atTheNewestThereIsNone() {
        show()
        rule.waitForIdle()
        assertEquals(0, jumps())
    }

    @Test fun readingOlderShowsItCentred12AboveTheListsEndAndATapGoesBack() {
        show()
        readOlder()
        assertEquals(1, jumps())
        val jump = rule.node(ConversationJumpTags.JUMP).bounds
        assertDp("32 wide", 32.dp, jump.width)
        assertDp("32 high", 32.dp, jump.height)
        // 411 has no whole-pixel centre for 32: within a pixel of it.
        assertEquals("centred", PHONE_WIDTH / 2f, ((jump.left + jump.right) / 2).value, 1 / 3f)
        val dockTop = rule.node(ConversationScreenTags.FADE).bounds.top
        assertDp("12 above the list's end, 8 over the dock", dockTop - 20.dp, jump.bottom)
        rule.node(ConversationJumpTags.JUMP).assert(hasContentDescription("Jump to latest")).assert(still)
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "jump.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }

        rule.node(ConversationJumpTags.JUMP).performClick()
        rule.waitForIdle()
        assertEquals("Back at the newest, it goes", 0, jumps())
    }

    @Test fun itShimmersWhileTheAgentWorks() {
        show()
        readOlder()
        rule.node(ConversationJumpTags.JUMP).assert(still)
        activity = Activity.RunningTools
        rule.waitForIdle()
        rule.node(ConversationJumpTags.JUMP).assert(working)
        activity = Activity.AwaitingAnswer
        rule.waitForIdle()
        rule.node(ConversationJumpTags.JUMP).assert(still)
        activity = Activity.Delegating
        rule.waitForIdle()
        rule.node(ConversationJumpTags.JUMP).assert(working)
        activity = null
        rule.waitForIdle()
        rule.node(ConversationJumpTags.JUMP).assert(still)
    }
}
