package com.slopus.happy.ui.start

import android.graphics.RuntimeShader
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/** The AGSL port compiles, draws, and stays in its palette: blue and violet, never green or orange. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GrainGradientTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun theShaderCompiles() {
        RuntimeShader(GRAIN_GRADIENT_AGSL)
    }

    @Test
    fun drawsInTheDarkPalette() = assertDrawsIn(StartSpec.darkPalette)

    @Test
    fun drawsInTheLightPalette() = assertDrawsIn(StartSpec.lightPalette)

    private fun assertDrawsIn(palette: GrainPalette) {
        rule.setHappyContent { GrainGradient(palette, Modifier.size(200.dp, 400.dp)) }
        val pixels = rule.node(GrainGradientTags.SHADER).captureToImage().toPixelMap()
        var lit = 0
        for (x in 0 until pixels.width step 7) {
            for (y in 0 until pixels.height step 7) {
                val c = pixels[x, y]
                // Blue leads everywhere: nothing green, yellow or orange.
                assertTrue("pixel $x,$y is $c", c.blue + 0.02f >= c.green && c.blue + 0.02f >= c.red)
                if (maxOf(abs(c.red - palette.back.red), abs(c.green - palette.back.green), abs(c.blue - palette.back.blue)) > 0.1f) lit++
            }
        }
        assertTrue("the corners show colour", lit > 0)
    }
}
