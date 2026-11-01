package com.slopus.happy.ui.connection

import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import kotlin.math.ceil
import kotlin.math.roundToInt

/** Native outline metrics, not a sample string's line box or raster coverage. */
internal class AgentRowTypography(titleFace: Typeface, countFace: Typeface, titleSize: Float) {
    val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = titleFace; textSize = titleSize }
    val xHeight = -ink(titlePaint, "x").top
    val countPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = countFace; textSize = titleSize }
    init {
        // A flat lining digit matches the flat lowercase x-height. Round digits keep overshoot.
        countPaint.textSize *= xHeight / ink(countPaint, "1").height()
    }
    fun baseline(height: Int): Int = (height / 2f + xHeight / 2).roundToInt()

    companion object {
        fun ink(paint: Paint, text: String): RectF {
            val path = Path()
            paint.getTextPath(text, 0, text.length, 0f, 0f, path)
            return RectF().also { path.computeBounds(it, true) }
        }
    }
}

@Composable
internal fun rememberAgentRowTypography(): AgentRowTypography {
    val resolver = LocalFontFamilyResolver.current
    val titleFace = resolver.resolve(FontFamily.Default, FontWeight.Normal).value as Typeface
    val countFace = resolver.resolve(FontFamily.Monospace, FontWeight.Medium).value as Typeface
    val size = with(LocalDensity.current) { 17.sp.toPx() }
    return remember(titleFace, countFace, size) { AgentRowTypography(titleFace, countFace, size) }
}

/** Keep the existing line box, placing its measured baseline on the row's x-height baseline. */
@Composable
internal fun Modifier.agentTitleBaseline(): Modifier {
    val metrics = rememberAgentRowTypography()
    return layout { measurable, constraints ->
        val child = measurable.measure(constraints)
        layout(child.width, child.height) {
            child.placeRelative(0, metrics.baseline(child.height) - child[FirstBaseline])
        }
    }
}

/** The last glyph's path, not its advance cell, ends at the row's symmetric trailing edge. */
@Composable
internal fun AgentCountInk(parts: List<String>, color: Color, modifier: Modifier = Modifier) {
    val metrics = rememberAgentRowTypography()
    val density = LocalDensity.current
    val gap = with(density) { 6.dp.toPx() }
    val bounds = remember(parts, metrics) { parts.map { AgentRowTypography.ink(metrics.countPaint, it) } }
    val width = ceil(bounds.sumOf { it.width().toDouble() } + gap * (parts.size - 1)).toFloat()
    Canvas(modifier.width(with(density) { width.toDp() }).height(AgentHomeSpec.TITLE_LINE.sp.let { with(density) { it.toDp() } })) {
        val paint = metrics.countPaint
        paint.color = color.toArgb()
        var right = size.width
        val baseline = metrics.baseline(size.height.roundToInt()).toFloat()
        for (index in parts.indices.reversed()) {
            drawContext.canvas.nativeCanvas.drawText(parts[index], right - bounds[index].right, baseline, paint)
            right -= bounds[index].width() + gap
        }
    }
}