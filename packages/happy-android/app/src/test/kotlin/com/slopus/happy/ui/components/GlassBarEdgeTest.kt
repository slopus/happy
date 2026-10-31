package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
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

/**
 * The bar's progressive edges: ground over the status bar, glass at its foot,
 * then the glass feathering out below it with no line; a backdrop taking the
 * ground's alphas; and the room a list keeps so it rests below the feather.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassBarEdgeTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `nearly opaque over the status bar, the foot's tint at the bar's foot, smooth between`() {
        val edge = 30f
        val height = 100f
        val foot = GlassSpec.BAR_ALPHA_DARK
        assertEquals(GlassSpec.BAR_EDGE_ALPHA, GlassSpec.barAlpha(0f, edge, height, foot), 0f)
        assertEquals(GlassSpec.BAR_EDGE_ALPHA, GlassSpec.barAlpha(edge, edge, height, foot), 0f)
        assertEquals(foot, GlassSpec.barAlpha(height, edge, height, foot), 1e-6f)
        assertTrue(GlassSpec.BAR_EDGE_ALPHA >= 0.95f)
        // Falls all the way down, flat where it starts and ends, so neither end reads as a line.
        val samples = (0..70).map { GlassSpec.barAlpha(edge + it, edge, height, foot) }
        samples.zipWithNext { a, b -> assertTrue("never rises: $a then $b", b <= a) }
        val steps = samples.zipWithNext { a, b -> a - b }
        assertTrue("flat at the status bar's foot", steps.first() < steps[35] / 10)
        assertTrue("flat at the bar's foot", steps.last() < steps[35] / 10)
    }

    @Test fun `with no room under the status bar the bar is its edge`() {
        assertEquals(GlassSpec.BAR_EDGE_ALPHA, GlassSpec.barAlpha(50f, 100f, 100f, GlassSpec.BAR_ALPHA), 0f)
    }

    /** A red backdrop over white: how red each row is is the ground's alpha there. */
    @Test fun `a backdrop takes the ground's alphas`() {
        rule.setHappyContent(false) {
            CompositionLocalProvider(LocalGlassBlur provides true) {
                GlassBarLayout(
                    bar = { Box(Modifier.fillMaxWidth().height(100.dp)) },
                    ground = Color.White,
                    backdrop = { drawRect(Color.Red) },
                ) { Box(Modifier.fillMaxSize()) }
            }
        }
        rule.waitForIdle()
        val bar = rule.node(GlassBarTags.BAR).captureToImage().asAndroidBitmap()
        // Red over white: green = 255 (1 - alpha).
        fun alpha(y: Int) = 1f - android.graphics.Color.green(bar.getPixel(bar.width / 2, y)) / 255f
        // Robolectric has no status bar, so the ramp starts at the bar's top.
        assertEquals(GlassSpec.BAR_EDGE_ALPHA, alpha(0), 0.02f)
        assertEquals(GlassSpec.BAR_ALPHA, alpha(bar.height - 1), 0.02f)
        val middle = alpha(bar.height / 2)
        assertTrue("between at the middle: $middle", middle < GlassSpec.BAR_EDGE_ALPHA - 0.02f && middle > GlassSpec.BAR_ALPHA + 0.02f)
    }

    @Test fun `without a backdrop the bar over its own ground is the ground`() {
        rule.setHappyContent(true) {
            CompositionLocalProvider(LocalGlassBlur provides true) {
                GlassBarLayout(
                    bar = { Box(Modifier.fillMaxWidth().height(100.dp)) },
                    ground = Color(0xFF18171C),
                ) { Box(Modifier.fillMaxSize()) }
            }
        }
        rule.waitForIdle()
        val bar = rule.node(GlassBarTags.BAR).captureToImage().asAndroidBitmap()
        for (y in listOf(0, bar.height / 2, bar.height - 1)) {
            val pixel = bar.getPixel(bar.width / 2, y)
            assertEquals("row $y red", 0x18.toFloat(), android.graphics.Color.red(pixel).toFloat(), 1f)
            assertEquals("row $y green", 0x17.toFloat(), android.graphics.Color.green(pixel).toFloat(), 1f)
            assertEquals("row $y blue", 0x1C.toFloat(), android.graphics.Color.blue(pixel).toFloat(), 1f)
        }
    }

    @Test fun `the feather fades the glass out on a smoothstep, flat at both ends`() {
        assertEquals(1f, GlassSpec.featherAlpha(0f), 0f)
        assertEquals(0.5f, GlassSpec.featherAlpha(0.5f), 1e-6f)
        assertEquals(0f, GlassSpec.featherAlpha(1f), 0f)
        // Past either end it holds.
        assertEquals(1f, GlassSpec.featherAlpha(-1f), 0f)
        assertEquals(0f, GlassSpec.featherAlpha(2f), 0f)
        val samples = (0..100).map { GlassSpec.featherAlpha(it / 100f) }
        samples.zipWithNext { a, b -> assertTrue("never rises: $a then $b", b <= a) }
        val steps = samples.zipWithNext { a, b -> a - b }
        assertTrue("flat at the bar's foot", steps.first() < steps[50] / 10)
        assertTrue("flat where it ends", steps.last() < steps[50] / 10)
        // Between iOS's chat (24 pt) and Telegram's (48 dp).
        assertTrue(GlassSpec.feather.value in 24f..48f)
    }

    /**
     * A red backdrop over white, read on the window (the feather is drawn past
     * the bar's own box): the glass's alpha at each row, down the bar and on
     * through its feather. It falls all the way, never rises, and moves by no
     * more than a smoothstep's step anywhere: no hairline, no hard foot.
     */
    @Test fun `the glass feathers out below the bar, with no line anywhere`() {
        var top = 0.dp
        rule.setHappyContent(false) {
            CompositionLocalProvider(LocalGlassBlur provides true) {
                GlassBarLayout(
                    bar = { Box(Modifier.fillMaxWidth().height(100.dp)) },
                    ground = Color.White,
                    backdrop = { drawRect(Color.Red) },
                ) { Box(Modifier.fillMaxSize().background(Color.White)); top = it }
            }
        }
        rule.waitForIdle()
        val bar = rule.node(GlassBarTags.BAR).bounds
        assertDp("the content keeps the bar and its feather clear", bar.bottom + GlassSpec.feather, top)
        val window = rule.onRoot().captureToImage().asAndroidBitmap()
        val density = 3 // PHONE is xxhdpi
        val foot = (bar.bottom.value * density).toInt()
        val feather = (GlassSpec.feather.value * density).toInt()
        for (x in listOf(window.width / 4, window.width / 2, window.width - 2)) {
            fun alpha(y: Int) = 1f - android.graphics.Color.green(window.getPixel(x, y)) / 255f
            assertEquals("x $x: the bar's foot is glass", GlassSpec.BAR_ALPHA, alpha(foot - 1), 0.02f)
            assertEquals("x $x: half the glass halfway through the feather", GlassSpec.BAR_ALPHA / 2, alpha(foot + feather / 2), 0.03f)
            assertEquals("x $x: nothing past the feather", 0f, alpha(foot + feather), 0.01f)
            assertEquals("x $x: nothing below", 0f, alpha(foot + feather + 30), 0f)
            val column = (0 until foot + feather + 4).map(::alpha)
            column.zipWithNext().forEachIndexed { y, (a, b) ->
                assertTrue("x $x: row ${y + 1} rises: $a then $b", b <= a + 0.01f)
                assertTrue("x $x: row ${y + 1} steps by ${a - b}", a - b < 0.03f)
            }
        }
    }

    /** Not feathered, the glass stops at the bar's foot; the room kept for the feather stays, so nothing moves. */
    @Test fun `unfeathered, the glass ends at the bar's foot and the room stays`() {
        var top = 0.dp
        rule.setHappyContent(false) {
            CompositionLocalProvider(LocalGlassBlur provides true) {
                GlassBarLayout(
                    bar = { Box(Modifier.fillMaxWidth().height(100.dp)) },
                    ground = Color.White,
                    backdrop = { drawRect(Color.Red) },
                    feathered = false,
                ) { Box(Modifier.fillMaxSize().background(Color.White)); top = it }
            }
        }
        rule.waitForIdle()
        val bar = rule.node(GlassBarTags.BAR).bounds
        assertDp("the same room", bar.bottom + GlassSpec.feather, top)
        val window = rule.onRoot().captureToImage().asAndroidBitmap()
        val foot = (bar.bottom.value * 3).toInt()
        assertEquals(android.graphics.Color.WHITE, window.getPixel(window.width / 2, foot + 1))
    }

    /**
     * A GlassBarScreen feathers only once a list claims the bar's room: then
     * the list starts the feather's length further down; content held below
     * the bar stays at its foot, with no feather over it.
     */
    @Test fun `a glass screen feathers only over a list that runs under it`() {
        var claims by mutableStateOf(false)
        var start: Dp = 0.dp
        rule.setHappyContent(false) {
            CompositionLocalProvider(LocalGlassBlur provides true) {
                GlassBarScreen(bar = { Box(Modifier.fillMaxWidth().height(100.dp)) }, ground = Color.White) {
                    val inset = if (claims) barInsetTop() else 0.dp
                    start = inset
                    Box(Modifier.fillMaxSize().background(Color.Red))
                }
            }
        }
        rule.waitForIdle()
        val bar = rule.node(GlassBarTags.BAR).bounds
        val foot = (bar.bottom.value * 3).toInt()
        fun red(y: Int) = rule.onRoot().captureToImage().asAndroidBitmap().getPixel(540, y)
        // Held below the bar: the red starts at its foot, untouched.
        assertEquals(android.graphics.Color.RED, red(foot + 1))
        claims = true
        rule.waitForIdle()
        assertDp("the list keeps the bar and the feather clear", bar.bottom + GlassSpec.feather, start)
        // Under it now: the feather lies over the red, half of the glass halfway through.
        val half = red(foot + (GlassSpec.feather.value * 3).toInt() / 2)
        assertTrue("the feather is over the list: ${Integer.toHexString(half)}", android.graphics.Color.green(half) in 60..200)
    }
}
