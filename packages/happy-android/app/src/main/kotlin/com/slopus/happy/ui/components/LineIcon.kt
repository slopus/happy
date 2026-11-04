package com.slopus.happy.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.unit.Dp

/**
 * Lucide's line icons that happy-app's fonts don't have, as happy-ios's
 * `LineIcon` (ea1a0902f) draws them: strokes on Lucide's 24 grid.
 */
enum class LineIcon {
    /** A direct connection. */
    Zap,
    Monitor,
    ;

    /** The outline on the 24 grid, made once. */
    val path: Path by lazy { outline(this) }
}

private fun outline(icon: LineIcon): Path = Path().apply {
    fun line(vararg points: Pair<Float, Float>) {
        moveTo(points[0].first, points[0].second)
        for (point in points.drop(1)) lineTo(point.first, point.second)
    }
    fun rect(x: Float, y: Float, width: Float, height: Float, radius: Float) =
        addRoundRect(RoundRect(x, y, x + width, y + height, CornerRadius(radius)))
    when (icon) {
        LineIcon.Zap -> {
            line(13f to 2f, 3f to 14f, 12f to 14f, 11f to 22f, 21f to 10f, 12f to 10f)
            close()
        }
        LineIcon.Monitor -> {
            rect(2f, 3f, 20f, 14f, 2f)
            line(8f to 21f, 16f to 21f)
            line(12f to 17f, 12f to 21f)
        }
    }
}

/**
 * [icon] stroked in [color], scaled from the 24 grid to [size]. [weight]
 * is the stroke on the grid: 1.5 at 28 matches happy-app's outline glyphs
 * beside it (iOS `LineIconView`).
 */
@Composable
fun LineIcon(icon: LineIcon, size: Dp, color: Color, modifier: Modifier = Modifier, weight: Float = 1.5f) {
    Canvas(modifier.size(size)) {
        val grid = this.size.minDimension / 24f
        scale(grid, pivot = Offset.Zero) {
            drawPath(icon.path, color, style = Stroke(width = weight, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}
