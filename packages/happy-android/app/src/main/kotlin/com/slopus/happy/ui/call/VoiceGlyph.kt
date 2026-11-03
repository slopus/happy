package com.slopus.happy.ui.call

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp

/**
 * The voice button's glyph (iOS `VoiceIconLayout`): three upright bars with
 * round ends, after happy-app's `icon-voice` (four bars, 5 apart, 5/3 wide,
 * on a 24 square), cut to three (short, tall, middling) and drawn a little
 * heavier, so it weighs as much as compose beside it; centred on the square.
 */
object VoiceGlyphSpec {
    /** On the 24-unit square, as happy-app's asset is drawn. */
    const val CANVAS = 24f
    const val PITCH = 5.25f
    const val BAR_WIDTH = 2.4f
    val heights = listOf(10f, 17f, 12.67f)

    /** Each bar, left to right, on a [size]-pixel square; its ends are round (radius half its width). */
    fun bars(size: Float): List<Rect> {
        val scale = size / CANVAS
        val width = BAR_WIDTH * scale
        val span = PITCH * (heights.size - 1) * scale
        val firstMid = size / 2 - span / 2
        return heights.mapIndexed { index, height ->
            val h = height * scale
            Rect(Offset(firstMid + index * PITCH * scale - width / 2, (size - h) / 2), Size(width, h))
        }
    }
}

@Composable
fun VoiceGlyph(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        for (bar in VoiceGlyphSpec.bars(this.size.minDimension)) {
            drawRoundRect(color, bar.topLeft, bar.size, CornerRadius(bar.width / 2))
        }
    }
}
