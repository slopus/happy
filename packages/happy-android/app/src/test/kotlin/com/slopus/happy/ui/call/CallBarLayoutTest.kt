package com.slopus.happy.ui.call

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.call.CallActivity
import com.slopus.happy.call.CallProblem
import com.slopus.happy.call.CallState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The voice call's bar over the window ([CallFrame]): it pushes what is under
 * it down by its height, never covers it, and lays its row out at its foot.
 * The test window has no status bar, so the bar is its 40 dp least.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CallBarLayoutTest {
    @get:Rule val rule = createComposeRule()

    private val state = MutableStateFlow<CallState>(CallState.Idle)
    private var ended = 0
    private var mutes = 0

    private fun show() = rule.setHappyContent {
        CallFrame(state, MutableStateFlow(0f), onMute = { mutes++ }, onEnd = { ended++ }) {
            Box(Modifier.fillMaxSize().testTag("page"))
        }
    }

    @Test
    fun withNoCallTheWindowIsTheWindow() {
        show()
        assertBox("page", rule.node("page").bounds, 0.dp, 0.dp, 411.dp, 891.dp)
        rule.node(CallBarTags.BAR).assertDoesNotExist()
    }

    @Test
    fun aCallPushesThePageDownByTheBarAndLaysItsRowAtTheFoot() {
        show()
        // The waves and the clock run while a call is live: the clock is moved by hand.
        rule.mainClock.autoAdvance = false
        state.value = CallState.Active(CallActivity.Listening, muted = false, since = android.os.SystemClock.elapsedRealtime())
        rule.mainClock.advanceTimeBy(CallBarSpec.MOTION_MS + 100L)
        val bar = rule.node(CallBarTags.BAR).bounds
        assertBox("bar", bar, 0.dp, 0.dp, 411.dp, CallBarSpec.minHeight)
        // Pushed, not covered: the page starts at the bar's foot and keeps the rest of the window.
        assertBox("page", rule.node("page").bounds, 0.dp, bar.bottom, 411.dp, 891.dp - bar.bottom)
        // Mute and end stand on the bar's foot, 44 square, at its ends.
        assertBox("mute", rule.node(CallBarTags.MUTE).bounds, 0.dp, bar.bottom - 44.dp, 44.dp, 44.dp)
        assertBox("end", rule.node(CallBarTags.END).bounds, 411.dp - 44.dp, bar.bottom - 44.dp, 44.dp, 44.dp)
        // "Happy" and the clock, centred together in the row.
        val title = rule.node(CallBarTags.TITLE).bounds
        val clock = rule.node(CallBarTags.SUBTITLE).bounds
        assertDp("title and clock touch across the gap", title.right + CallBarSpec.titleSpacing, clock.left)
        assertDp("centred", 411.dp / 2, (title.left + clock.right) / 2)
        assertDp("in the row at the foot", bar.bottom - CallBarSpec.row / 2, (title.top + title.bottom) / 2)
        rule.onNodeWithText("0:00", useUnmergedTree = true).assertExists()
        rule.node(CallBarTags.MUTE).performClick()
        rule.node(CallBarTags.END).performClick()
        assertEquals(1, mutes)
        assertEquals(1, ended)
    }

    @Test
    fun midwayThePageMovesWithTheBarsFoot() {
        show()
        rule.mainClock.autoAdvance = false
        state.value = CallState.Connecting
        rule.mainClock.advanceTimeBy(CallBarSpec.MOTION_MS / 2L)
        val bar = rule.node(CallBarTags.BAR).bounds
        val page = rule.node("page").bounds
        assertTrue("on its way: ${page.top}", page.top > 0.dp && page.top < CallBarSpec.minHeight)
        // Slid from above the screen, its whole height, its foot where the page starts.
        assertDp("bar's height", CallBarSpec.minHeight, bar.height)
        assertDp("foot on the page", page.top, bar.bottom)
    }

    @Test
    fun aCallThatCantStartSaysWhyWithOnlyAClose() {
        show()
        state.value = CallState.Ended(CallProblem.NotSetUp)
        rule.waitForIdle()
        rule.onNodeWithText("Voice isn’t set up for this connection yet", useUnmergedTree = true).assertExists()
        rule.node(CallBarTags.MUTE).assertDoesNotExist()
        rule.node(CallBarTags.SUBTITLE).assertDoesNotExist()
        assertTrue(rule.node("page").bounds.top >= CallBarSpec.minHeight)
    }

    @Test
    fun theBarGoesAndThePageComesBackUp() {
        show()
        state.value = CallState.Connecting
        rule.waitForIdle()
        rule.onNodeWithText("Connecting…", useUnmergedTree = true).assertExists()
        state.value = CallState.Idle
        rule.waitForIdle()
        assertBox("page", rule.node("page").bounds, 0.dp, 0.dp, 411.dp, 891.dp)
    }

    @Test
    fun theHeightIsTheStatusBarAndARow() {
        assertDp("no status bar", 40, CallBarSpec.height(0.dp))
        assertDp("a 24 status bar", 48, CallBarSpec.height(24.dp))
        assertDp("a punch hole's 52", 76, CallBarSpec.height(52.dp))
    }

    @Test
    fun theVoiceGlyphIsThreeRoundBars() {
        val bars = VoiceGlyphSpec.bars(24f)
        assertEquals(3, bars.size)
        assertEquals(listOf(5.55f, 10.8f, 16.05f), bars.map { Math.round(it.left * 100) / 100f })
        assertEquals(listOf(10f, 17f, 12.67f), bars.map { Math.round(it.height * 100) / 100f })
        for (bar in bars) {
            assertEquals(2.4f, bar.width, 0.001f)
            assertEquals(12f, (bar.top + bar.bottom) / 2, 0.001f)
        }
    }

    @Test
    fun theWavesReachTwentyNineBelowTheBar() {
        assertEquals(29f, CallWaves.OVERHANG)
        val waves = CallWaves(seed = 1)
        val flat = waves.crests(390f, 59f, flat = true)
        assertEquals(3, flat.size)
        assertTrue(flat.all { crest -> crest.start.y == 59f && crest.segments.all { it.to.y == 59f } })
    }
}
