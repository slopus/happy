package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The bar's progressive edge: ground over the status bar, glass at its foot, and a backdrop taking the ground's alphas. */
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
}
