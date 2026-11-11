package com.slopus.happy.ui.start

import android.graphics.RuntimeShader
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/**
 * The AGSL port compiles and draws the cloud in chrome: its box is the size
 * it is given, clear around the cloud and through the H, and inside it
 * greys from near black to near white with only faint colour fringes.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LiquidMetalTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun theShaderCompiles() {
        RuntimeShader(LIQUID_METAL_AGSL)
    }

    @Test
    fun theFieldIsTheBakedSquare() {
        val field = LiquidMetalField.load(ApplicationProvider.getApplicationContext<android.content.Context>().resources)
        assertNotNull(field)
    }

    @Test
    fun drawsTheCloudInChromeAndNothingAroundIt() {
        // Made off the main thread, as StartWarmup makes them before Start: ready for the first frame.
        LiquidMetalProgram.get()
        LiquidMetalField.load(ApplicationProvider.getApplicationContext<android.content.Context>().resources)
        // Over magenta, which chrome never is: what shows magenta was left clear.
        rule.setHappyContent {
            Box(Modifier.background(Color.Magenta)) { LiquidMetalMark(Modifier.size(96.dp)) }
        }
        rule.node(LiquidMetalTags.SHADER).assertWidthIsEqualTo(96.dp).assertHeightIsEqualTo(96.dp)
        val pixels = rule.node(LiquidMetalTags.SHADER).captureToImage().toPixelMap()
        val side = pixels.width
        fun clear(x: Int, y: Int) = pixels[x, y].let { it.red > 0.95f && it.green < 0.05f && it.blue > 0.95f }
        // The square's corners and the H's left post are clear; the cloud's
        // body left of the H is drawn.
        assertTrue(clear(2, 2))
        assertTrue(clear(side - 3, side - 3))
        assertTrue(clear((side * 0.419).toInt(), (side * 0.5).toInt()))
        assertFalse(clear((side * 0.15).toInt(), (side * 0.65).toInt()))
        var drawn = 0
        var tinted = 0
        for (x in 0 until side step 3) {
            for (y in 0 until side step 3) {
                val c = pixels[x, y]
                if (c.green < 0.05f) continue
                drawn++
                if (maxOf(abs(c.red - c.green), abs(c.green - c.blue), abs(c.red - c.blue)) > 0.25f) tinted++
            }
        }
        assertTrue("the cloud is drawn ($drawn)", drawn > 150)
        assertTrue("chrome, not colour: $tinted of $drawn tinted", tinted * 10 < drawn)
    }
}
