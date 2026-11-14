package com.slopus.happy.ui.components

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

/**
 * Desktop's sidebar title: a row's title that runs out of room is cut, not
 * ellipsized, and its last [length] fade to nothing at its box's end, which
 * is the row's edge or just before what trails the title (counts, a dot).
 * A title that fits stays wholly opaque.
 */
object TitleFade {
    /** How far before the end the fade starts, desktop's 12. */
    val length = 12.dp
}

/**
 * Fades the end of what this draws over [TitleFade.length] while [overflowing]
 * says so; read at draw time, so a title that starts or stops overflowing
 * only redraws. The fade sits on the line's end side (the left in
 * right-to-left). Put it before any modifier that paints into the glyphs
 * (the shimmer), so the band fades with them.
 */
fun Modifier.titleFade(overflowing: () -> Boolean): Modifier = this
    .graphicsLayer { compositingStrategy = if (overflowing()) CompositingStrategy.Offscreen else CompositingStrategy.Auto }
    .drawWithContent {
        drawContent()
        if (!overflowing()) return@drawWithContent
        val fade = TitleFade.length.toPx().coerceAtMost(size.width)
        val rtl = layoutDirection == LayoutDirection.Rtl
        drawRect(
            brush = if (rtl) {
                Brush.horizontalGradient(0f to Color.Transparent, 1f to Color.Black, startX = 0f, endX = fade)
            } else {
                Brush.horizontalGradient(0f to Color.Black, 1f to Color.Transparent, startX = size.width - fade, endX = size.width)
            },
            blendMode = BlendMode.DstIn,
        )
    }
