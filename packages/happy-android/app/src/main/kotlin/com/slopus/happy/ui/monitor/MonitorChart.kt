package com.slopus.happy.ui.monitor

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.slopus.happy.monitor.MonitorLevel
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.floor

/** Values are shares from 0 to 1, oldest first; missing readings break a line. */
@Immutable
internal data class MonitorChartLine(val values: List<Double?>, val color: Color, val fills: Boolean = true)

internal data class ChartPoint(val x: Float, val y: Float)

/**
 * iOS CardDrawing.drawChart (eda4d179e): clamp readings, preserve their
 * positions and draw only runs with at least two points. A missing reading
 * is a gap, never a zero or a line connecting two different measurements.
 */
internal fun chartRuns(values: List<Double?>): List<List<ChartPoint>> {
    if (values.size < 2) return emptyList()
    val runs = ArrayList<List<ChartPoint>>()
    var run = ArrayList<ChartPoint>()
    fun flush() { if (run.size > 1) runs += run; run = ArrayList() }
    values.forEachIndexed { index, value ->
        if (value == null || !value.isFinite()) flush()
        else run += ChartPoint(index.toFloat() / (values.size - 1), (1 - value.coerceIn(0.0, 1.0)).toFloat())
    }
    flush()
    return runs
}

private data class ChartPath(val line: Path, val area: Path?, val color: Color)

/**
 * Paths are built on Default and published once per data/size change. The
 * canvas only draws them: three one-pixel guides, 1.5 dp rounded strokes,
 * and a .14 light/.22 dark fill. A sparkline uses the same drawing at 44×16.
 * Telegram LinearChartView (3de37c8:44-100) supplies the retained-path and
 * half-stroke inset approach; iOS CardDrawing supplies the scale and gaps.
 */
@Composable
internal fun MonitorChart(lines: List<MonitorChartLine>, description: String, modifier: Modifier = Modifier) {
    var size by remember { mutableStateOf(IntSize.Zero) }
    val strokeWidth = with(LocalDensity.current) { 1.5.dp.toPx() }
    val dark = HappyTheme.colors.dark
    val paths by produceState(emptyList<ChartPath>(), lines, size, strokeWidth) {
        val width = size.width.toFloat()
        val height = size.height.toFloat()
        value = withContext(Dispatchers.Default) {
            if (width <= 0 || height <= 0) emptyList()
            else lines.flatMap { line -> chartRuns(line.values).map { run ->
                val points = run.map { Offset(it.x * width, strokeWidth / 2 + it.y * (height - strokeWidth).coerceAtLeast(0f)) }
                val path = Path().apply {
                    moveTo(points.first().x, points.first().y)
                    points.drop(1).forEach { lineTo(it.x, it.y) }
                }
                val area = if (!line.fills) null else Path().apply {
                    moveTo(points.first().x, height)
                    points.forEach { lineTo(it.x, it.y) }
                    lineTo(points.last().x, height)
                    close()
                }
                ChartPath(path, area, line.color)
            } }
        }
    }
    val stroke = remember(strokeWidth) { Stroke(strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round) }
    val grid = if (dark) Color(0xff2a2a2d) else Color(0xffececf0)
    Canvas(modifier.onSizeChanged { size = it }.semantics { contentDescription = description }) {
        repeat(3) { guide ->
            drawRect(grid, Offset(0f, floor((this.size.height - 1f) * guide * .5f)), Size(this.size.width, 1f))
        }
        for (path in paths) {
            path.area?.let { drawPath(it, path.color.copy(alpha = if (dark) .22f else .14f)) }
            drawPath(path.line, path.color, style = stroke)
        }
    }
}

internal fun MonitorLevel.ink(dark: Boolean): Color = when (this) {
    MonitorLevel.Calm -> RowTile.Blue.ink(dark)
    MonitorLevel.Warm -> RowTile.Orange.ink(dark)
    MonitorLevel.Hot -> RowTile.Red.ink(dark)
    MonitorLevel.Unavailable -> if (dark) Color(0xff8e8e93) else Color(0xff6c6c70)
}