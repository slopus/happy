package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PixelMap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.happyTextStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Desktop's sidebar title: a title that runs out of room fades over its last 12 instead of ending in "…". */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TitleFadeTest {
    @get:Rule
    val rule = createComposeRule()

    private val long = "Port the sidebar's title fade to every row on Android"

    private fun show(text: String, fade: Boolean, layoutDirection: LayoutDirection = LayoutDirection.Ltr) = rule.setHappyContent {
        CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) { Title(text, fade, "title") }
    }

    @Composable
    private fun Title(text: String, fade: Boolean, tag: String) {
        Box(Modifier.width(160.dp).background(Color.White)) {
            ShimmerText(
                text,
                style = happyTextStyle(fontSize = 17, lineHeight = 22),
                baseColor = Color.Black,
                highlightColor = Color.Black,
                shimmering = false,
                fade = fade,
                modifier = Modifier.testTag(tag),
            )
        }
    }

    private fun layout(tag: String = "title"): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        rule.node(tag).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!.invoke(results)
        return results.single()
    }

    /** How dark the darkest pixel between columns [from] and [to] is: 0 white, 1 black. */
    private fun PixelMap.ink(from: Int, to: Int): Float =
        (from until to).maxOf { x -> (0 until height).maxOf { y -> 1f - this[x, y].red } }

    /** xxhdpi: three pixels a dp. */
    private fun px(dp: Int) = dp * 3

    @Test
    fun aLongTitleIsCutNotEllipsized() {
        show(long, fade = true)
        val layout = layout()
        assertTrue(layout.hasVisualOverflow)
        assertFalse(layout.isLineEllipsized(0))
    }

    @Test
    fun aLongTitlesLast12FadeToNothing() {
        show(long, fade = true)
        val pixels = rule.node("title").captureToImage().toPixelMap()
        assertEquals("the title takes the whole box", px(160), pixels.width)
        assertTrue("letters stand before the fade", pixels.ink(pixels.width - px(36), pixels.width - px(TitleFade.length.value.toInt())) > 0.8f)
        assertTrue("its very end is gone", pixels.ink(pixels.width - 2, pixels.width) < 0.1f)
    }

    @Test
    fun rightToLeftFadesOnTheLeft() {
        show(long, fade = true, LayoutDirection.Rtl)
        val pixels = rule.node("title").captureToImage().toPixelMap()
        assertTrue("letters stand after the fade", pixels.ink(px(12), px(36)) > 0.8f)
        assertTrue("its very end is gone", pixels.ink(0, 2) < 0.1f)
    }

    @Test
    fun aTitleThatFitsIsUntouched() {
        rule.setHappyContent {
            Column {
                Title("Fits", fade = false, "plain")
                Title("Fits", fade = true, "faded")
            }
        }
        val plain = rule.node("plain").captureToImage().toPixelMap()
        val faded = rule.node("faded").captureToImage().toPixelMap()
        assertFalse(layout("faded").hasVisualOverflow)
        assertEquals(plain.width, faded.width)
        for (x in 0 until plain.width) for (y in 0 until plain.height) assertEquals("pixel $x,$y", plain[x, y], faded[x, y])
    }
}
