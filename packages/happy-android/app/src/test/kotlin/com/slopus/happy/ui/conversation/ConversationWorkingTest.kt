package com.slopus.happy.ui.conversation

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.PulseSpec
import com.slopus.happy.ui.components.RecomposeProbe
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The bar while the agent works and nothing streams: its title and status
 * shimmer and its dot pulses, every frame, by drawing alone.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationWorkingTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "running_tools", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val builder = ConversationRowBuilder { 1_000_000L }

    private val working = ConversationState(
        created = true, loaded = true, agent = agent, working = true, activity = Activity.Working,
        rows = listOf(
            Message("m1", "user", 1, listOf(Block.Text("The login page loops back to itself after sign-in."))),
            Message("m2", "agent", 2, listOf(Block.Text("Looking at the callback first."))),
        ).flatMap { builder.rows(it, "a1", null, false) }.asReversed(),
    )

    @After fun off() {
        RecomposeProbe.counts = null
    }

    @Test fun `a working bar shimmers and pulses without writing state or composing`() {
        // Frames by hand from the start: waiting for idle would have the test's policy cancel the infinite clock.
        rule.mainClock.autoAdvance = false
        rule.setHappyContent { ConversationScreen(working, null, ConversationScreenActions()) }
        // Past the transcript's crossfade in, and the glass's first recording.
        rule.mainClock.advanceTimeBy(1_000)
        // Robolectric draws only to capture: the first draw records the glass's source once.
        rule.node(ConversationScreenTags.BAR).captureToImage()
        val counts = HashMap<String, Int>()
        RecomposeProbe.counts = counts
        // Every state object any frame writes: the old shimmer wrote its phase and the dot its Animatable's value, each frame.
        val written = HashSet<Any>()
        val observer = Snapshot.registerApplyObserver { changed, _ -> written.addAll(changed) }
        val frames = (0 until 30).map {
            rule.mainClock.advanceTimeBy(48)
            rule.node(ConversationScreenTags.BAR).captureToImage()
        }
        observer.dispose()
        assertEquals("no state written while the bar works: $written", emptySet<Any>(), written)
        assertEquals("nothing composed", emptyMap<String, Int>(), counts)
        // And it does move: the bar's pixels change from frame to frame.
        val distinct = frames.map { it.toPixelMap().buffer.contentHashCode() }.toSet()
        assertTrue("the bar is drawn moving: ${distinct.size} distinct frames", distinct.size > 10)
    }

    @Test fun `the pulse runs from full down to 30 percent and back over two seconds`() {
        assertEquals(1f, PulseSpec.alpha(0), 1e-6f)
        assertEquals(0.3f, PulseSpec.alpha(1_000), 1e-6f)
        assertEquals(1f, PulseSpec.alpha(2_000), 1e-6f)
        // Eased, and the way back mirrors the way down.
        assertEquals(1f - 0.7f * FastOutSlowInEasing.transform(0.25f), PulseSpec.alpha(250), 1e-6f)
        assertTrue(PulseSpec.alpha(250) > 1f - 0.7f * 0.25f)
        assertEquals(PulseSpec.alpha(400), PulseSpec.alpha(1_600), 1e-6f)
    }
}
