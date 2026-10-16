package com.slopus.happy.ui.components

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * StatusDot.tsx: a [size] circle (6 by default) in [color]. Pulsing fades
 * between full and 30% opacity, 1 s each way; settling back takes 200 ms.
 */
@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier, pulsing: Boolean = false, size: Dp = 6.dp) {
    val alpha = remember { Animatable(1f) }
    LaunchedEffect(pulsing) {
        if (pulsing) {
            alpha.animateTo(0.3f, infiniteRepeatable(tween(1000), RepeatMode.Reverse))
        } else {
            alpha.animateTo(1f, tween(200))
        }
    }
    Box(
        modifier = modifier
            .size(size)
            .graphicsLayer { this.alpha = alpha.value }
            .background(color, CircleShape),
    )
}

/** Whether the person has turned animations off (Android's "Remove animations": duration scale 0). */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}

private const val SWEEP_DURATION = 1700
private const val SWEEP_PAUSE = 650

/**
 * ShimmerText.tsx: one line of text in [baseColor] with a band of
 * [highlightColor] sweeping across it, clipped to the glyphs. The band is
 * max(44, 40% of the text's width) wide and crosses in 1.7 s, then rests
 * 0.65 s. With animations off the text is plain [baseColor].
 */
@Composable
fun ShimmerText(
    text: String,
    style: TextStyle,
    baseColor: Color,
    highlightColor: Color,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = rememberReduceMotion()
    var width by remember { mutableIntStateOf(0) }
    val progress = remember { Animatable(0f) }
    if (!reduceMotion) {
        LaunchedEffect(Unit) {
            progress.animateTo(1f, infiniteRepeatable(tween(SWEEP_DURATION + SWEEP_PAUSE, easing = LinearEasing), RepeatMode.Restart))
        }
    }
    val sweepFraction = SWEEP_DURATION.toFloat() / (SWEEP_DURATION + SWEEP_PAUSE)
    Text(
        text = text,
        style = style,
        color = baseColor,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .semantics { contentDescription = text }
            .onSizeChanged { width = it.width }
            .then(
                if (reduceMotion) {
                    Modifier
                } else {
                    Modifier
                        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                        .drawWithContent {
                            drawContent()
                            if (width == 0) return@drawWithContent
                            val band = maxOf(44.dp.toPx(), width * 0.4f)
                            val t = (progress.value / sweepFraction).coerceAtMost(1f)
                            val x = -band + (width + band) * t
                            drawRect(
                                brush = Brush.linearGradient(
                                    0f to baseColor,
                                    0.5f to highlightColor,
                                    1f to baseColor,
                                    start = Offset(x, size.height),
                                    end = Offset(x + band, 0f),
                                ),
                                topLeft = Offset(x, 0f),
                                size = androidx.compose.ui.geometry.Size(band, size.height),
                                blendMode = BlendMode.SrcAtop,
                            )
                        }
                },
            ),
    )
}
