package com.slopus.happy.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
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

/**
 * The glasses over one source share one merged capture ([GlassAtlas]),
 * and each shows exactly what it showed with a capture of its own: the bar
 * at the top, and the dock's band with the composer's pill over it (one
 * band round both), as a capture of that band alone, pixel for pixel, light and dark. Robolectric draws no
 * blur, so the eighth-size copy is shown as it is, blocky, which makes any
 * bleed between the bands in the merged capture show.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassMergedCaptureTest {
    @get:Rule val rule = createComposeRule()

    private enum class Glass { BAR, DOCK, PILL }

    private companion object { const val ROOT = "glass.root" }

    private var shown by mutableStateOf(Glass.entries.toSet())
    private lateinit var source: GlassSource

    /** Content that differs on every row and column, so a shifted or bled pixel shows. */
    @Composable
    private fun Content(dark: Boolean) = Canvas(Modifier.fillMaxSize()) {
        drawRect(if (dark) Color.Black else Color.White)
        for (i in 0 until 60) {
            val hue = (i * 37) % 360f
            drawLine(Color.hsv(hue, 0.9f, 0.9f), Offset(0f, i * 31f), Offset(size.width, i * 31f + 400f), strokeWidth = 7f + i % 5)
            drawCircle(Color.hsv((hue + 180) % 360, 0.8f, 0.7f), radius = 18f + i % 9, center = Offset((i * 113f) % size.width, (i * 71f) % size.height))
        }
    }

    private fun show(dark: Boolean) {
        rule.setHappyContent(dark) {
            source = rememberGlassSource()
            // No tint: the glass shows the blurred content alone.
            val clear = GlassColors(Color.Transparent, Color.Transparent, alpha = 0f)
            CompositionLocalProvider(LocalGlassBlur provides true) {
                Box(Modifier.fillMaxSize().testTag(ROOT)) {
                    Box(Modifier.fillMaxSize().glassSource(source)) { Content(dark) }
                    if (Glass.BAR in shown) Box(Modifier.fillMaxWidth().height(96.dp).glass(source, RectangleShape, clear, true).testTag("bar"))
                    if (Glass.DOCK in shown) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(120.dp).glass(source, RectangleShape, clear, true).testTag("dock"))
                    // Above the dock, clear of it, but its band overlaps the dock's.
                    if (Glass.PILL in shown) Box(
                        Modifier.align(Alignment.BottomStart).offset(y = (-150).dp).padding(start = 24.dp).size(220.dp, 52.dp)
                            .glass(source, RoundedCornerShape(26.dp), clear, true).testTag("pill"),
                    )
                }
            }
        }
        rule.waitForIdle()
    }

    /** Robolectric draws only to capture: the first draw records the source and asks for the bands, the next blurs them, the third shows them. */
    private fun drawn() = repeat(3) { rule.node(ROOT).captureToImage(); rule.waitForIdle() }

    private fun image(tag: String): Bitmap = rule.node(tag).captureToImage().asAndroidBitmap()

    private fun assertSame(what: String, expected: Bitmap, actual: Bitmap) {
        assertEquals(expected.width, actual.width)
        assertEquals(expected.height, actual.height)
        var differ = 0
        for (y in 0 until expected.height) for (x in 0 until expected.width) if (expected.getPixel(x, y) != actual.getPixel(x, y)) differ++
        assertEquals("$what: pixels that differ from the glass's capture alone", 0, differ)
    }

    private fun parity(dark: Boolean) {
        show(dark)
        drawn()
        assertEquals("two bands: the bar's, and one round the dock and the pill", 2, source.atlas.areas.size)
        val merged = Glass.entries.associateWith { image(it.name.lowercase()) }
        val colours = (0 until merged.getValue(Glass.BAR).width step 7).map { merged.getValue(Glass.BAR).getPixel(it, 40) }.toSet()
        assertTrue("the glass shows the content: ${colours.size} colours", colours.size > 8)
        // Each band alone: the bar's, and the dock's with the pill (which blur one band round both either way).
        for (band in listOf(setOf(Glass.BAR), setOf(Glass.DOCK, Glass.PILL))) {
            shown = band
            rule.waitForIdle()
            drawn()
            assertEquals(1, source.atlas.areas.size)
            for (glass in band) assertSame("$glass, ${if (dark) "dark" else "light"}", image(glass.name.lowercase()), merged.getValue(glass))
        }
    }

    @Test fun `every glass shows from the merged capture what it shows alone, light`() = parity(dark = false)

    @Test fun `every glass shows from the merged capture what it shows alone, dark`() = parity(dark = true)

    @Test fun `a glass that leaves gives up its band`() {
        show(dark = false)
        shown = setOf(Glass.BAR, Glass.DOCK)
        rule.waitForIdle()
        drawn()
        assertEquals(2, source.atlas.areas.size)
        shown = setOf(Glass.DOCK)
        rule.waitForIdle()
        drawn()
        assertEquals(1, source.atlas.areas.size)
    }
}
