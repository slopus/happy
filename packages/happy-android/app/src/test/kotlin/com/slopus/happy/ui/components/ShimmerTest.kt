package com.slopus.happy.ui.components

import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PixelMap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.happyTextStyle
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Desktop's ShimmerText on Android: the band moves frame to frame, on one clock, and only where it should. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ShimmerTest {
    @get:Rule
    val rule = createComposeRule()

    private val resolver get() = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver

    @After
    fun animationsBack() {
        Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    }

    /** The x of the brightest column of the middle row, or null where nothing is lit (the band is off the box). */
    private fun bandAt(pixels: PixelMap): Int? {
        val y = pixels.height / 2
        var best = -1
        var bestLight = 0.05f
        for (x in 0 until pixels.width) {
            val light = pixels[x, y].red
            if (light > bestLight) {
                bestLight = light
                best = x
            }
        }
        return best.takeIf { it >= 0 }
    }

    private fun capture(tag: String) = rule.node(tag).captureToImage().toPixelMap()

    @Test
    fun theBandSweepsLeftToRightAtDesktopsSpeed() {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            // Black under a white band: what the band paints is exactly what lights up.
            Box(Modifier.testTag("box").size(320.dp, 20.dp).shimmer(Color.White).background(Color.Black))
        }
        rule.mainClock.advanceTimeByFrame()
        // Step until the band is on the box, away from its right end.
        var first: Int? = null
        var width = 0
        repeat(40) {
            if (first != null) return@repeat
            rule.mainClock.advanceTimeBy(50)
            val pixels = capture("box")
            width = pixels.width
            // Inside, not pinned to the left edge while its centre is still before the box.
            first = bandAt(pixels)?.takeIf { it > 0 && it < pixels.width * 0.6f }
        }
        val start = checkNotNull(first) { "the band never crossed the box" }
        // Six 16 ms frames, 96 ms, are 6% of a 1.6 s sweep, whose centre travels two widths: 12% of the width.
        rule.mainClock.advanceTimeBy(96)
        val next = checkNotNull(bandAt(capture("box"))) { "the band left the box" }
        assertEquals("moved 12% of the width", width * 0.12f, (next - start).toFloat(), width * 0.03f)
    }

    @Test
    fun aShimmeringTitleChangesFromFrameToFrame() {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            ShimmerText(
                "Working on the login page",
                style = happyTextStyle(fontSize = 24, lineHeight = 30),
                baseColor = Color.Black,
                highlightColor = ShimmerSpec.sheen(Color.Black, Color.White),
                modifier = Modifier.testTag("title"),
            )
        }
        rule.mainClock.advanceTimeByFrame()
        val frames = (0 until 8).map {
            rule.mainClock.advanceTimeBy(200)
            capture("title")
        }
        // Not one frozen picture: the glyphs' colour moves with the band.
        val distinct = frames.map { pixels -> (0 until pixels.width).sumOf { x -> (0 until pixels.height).count { y -> pixels[x, y].red > 0.5f && pixels[x, y].red < 0.99f } } }.toSet()
        assertTrue("frames differ: $distinct", distinct.size > 1)
    }

    @Test
    fun aFrozenPhaseIsExact() {
        rule.setHappyContent {
            Column {
                Box(Modifier.testTag("clear").size(200.dp, 10.dp).shimmer(Color.White, phase = 0f).background(Color.Black))
                Box(Modifier.testTag("middle").size(200.dp, 10.dp).shimmer(Color.White, phase = 0.5f).background(Color.Black))
            }
        }
        // At 0 the band is clear of the line, a real frame showing the resting colour; at 0.5 it is centred.
        assertEquals(null, bandAt(capture("clear")))
        val middle = capture("middle")
        assertEquals(middle.width / 2f, bandAt(middle)!!.toFloat(), 2f)
        assertEquals(-0.5f, ShimmerSpec.bandCenter(0f))
        assertEquals(1.5f, ShimmerSpec.bandCenter(1f))
    }

    @Test
    fun everyShimmerKeepsOneClockAndLetsItGo() {
        rule.mainClock.autoAdvance = false
        var clock: ShimmerClock? = null
        var shown by mutableStateOf(3)
        var working by mutableStateOf(true)
        val style = happyTextStyle(fontSize = 15, lineHeight = 20)
        rule.setHappyContent {
            clock = LocalShimmerClock.current
            Column {
                repeat(shown) { index ->
                    ShimmerText("Row $index", style, Color.Black, Color.White, shimmering = working)
                }
                // Not shimmering, and frozen: neither keeps the clock running.
                ShimmerText("Idle", style, Color.Black, Color.White, shimmering = false)
                ShimmerText("Fixture", style, Color.Black, Color.White, phase = 0.4f)
            }
        }
        rule.mainClock.advanceTimeByFrame()
        assertEquals(3, clock!!.sweeping)
        // The clock writes no state as it ticks, so the test's own write reaches composition a frame later.
        shown = 1
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        assertEquals(1, clock!!.sweeping)
        working = false
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        assertEquals(0, clock!!.sweeping)
    }

    @Test
    fun withAnimationsOffTheTextIsPlain() {
        Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        rule.mainClock.autoAdvance = false
        var clock: ShimmerClock? = null
        rule.setHappyContent {
            clock = LocalShimmerClock.current
            ShimmerText(
                "Working on the login page",
                style = happyTextStyle(fontSize = 24, lineHeight = 30),
                baseColor = Color.Red,
                highlightColor = Color.Green,
                stillColor = Color.Black,
                modifier = Modifier.testTag("title"),
            )
        }
        rule.mainClock.advanceTimeByFrame()
        assertEquals(0, clock!!.sweeping)
        val before = capture("title")
        rule.mainClock.advanceTimeBy(400)
        val after = capture("title")
        assertEquals(before.buffer.toList(), after.buffer.toList())
        // The still colour only, black on the window's white: grey everywhere, nothing of the red base or green band.
        val coloured = (0 until before.width).any { x ->
            (0 until before.height).any { y -> before[x, y].let { kotlin.math.abs(it.red - it.green) > 0.05f || kotlin.math.abs(it.green - it.blue) > 0.05f } }
        }
        val inked = (0 until before.width).any { x -> (0 until before.height).any { y -> before[x, y].red < 0.5f } }
        assertTrue("the text is drawn", inked)
        assertTrue("painted in black alone", !coloured)
    }
}
