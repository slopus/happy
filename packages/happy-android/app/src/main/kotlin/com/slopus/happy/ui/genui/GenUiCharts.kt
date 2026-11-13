package com.slopus.happy.ui.genui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.genui.Element
import com.slopus.happy.genui.PlotKind
import com.slopus.happy.genui.TextRole
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.max
import kotlin.math.min

/**
 * A chart from what the daemon computed: line, area and bar at 16:9 under
 * their legend; a donut as a ring with the centre text and a legend of values
 * and shares under it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PlotView(e: Element.Plot, modifier: Modifier) {
    val shared = LocalGenUiColors.current
    Column(modifier.fillMaxWidth().semantics { contentDescription = e.summary }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (e.kind == PlotKind.Donut) {
            Donut(e)
            return@Column
        }
        if (e.legend.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                e.legend.forEach { LegendKey(it.label, shared.plot(it.color)) }
            }
        }
        Plot(e, Modifier.fillMaxWidth().aspectRatio(16f / 9f))
    }
}

@Composable
private fun LegendKey(name: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Text(name, style = GenUiSpec.legend, color = HappyTheme.colors.textSecondary)
    }
}

@Composable
private fun Plot(e: Element.Plot, modifier: Modifier) {
    val colors = HappyTheme.colors
    val measurer = rememberTextMeasurer()
    val axis = e.y ?: return
    val n = e.x.size.takeIf { it > 0 } ?: e.series.maxOf { it.values.size }
    val shared = LocalGenUiColors.current
    val style = GenUiSpec.axis.copy(color = shared.axisLabel)
    val grid = shared.grid
    val ring = colors.surface
    val seriesColors = e.series.map { shared.plot(it.color) }
    val span = (axis.max - axis.min).takeIf { it > 0 } ?: 1.0
    // Drawn once into a layer per size (labels measured there too), so a scrolling list only replays it.
    Spacer(
        modifier.drawWithCache {
            val layer = obtainGraphicsLayer()
            layer.record {
                if (n == 0) return@record
                val tickLabels = axis.ticks.map { measurer.measure(it.label, style) }
                val xLabels = e.x.map { measurer.measure(it, style) }
                val gutter = (tickLabels.maxOfOrNull { it.size.width } ?: 0) + 8.dp.toPx()
                val labelHeight = (xLabels.maxOfOrNull { it.size.height } ?: 0) + 6.dp.toPx()
                val top = (tickLabels.firstOrNull()?.size?.height ?: 0) / 2f
                val plot = Rect(gutter, top, size.width, size.height - labelHeight)
                fun y(value: Double) = plot.bottom - ((value - axis.min) / span).toFloat().coerceIn(-0.05f, 1.05f) * plot.height

                axis.ticks.forEachIndexed { i, tick ->
                    val ty = y(tick.value)
                    drawLine(grid, Offset(plot.left, ty), Offset(plot.right, ty), 1f)
                    val label = tickLabels[i]
                    drawText(label, topLeft = Offset(gutter - 8.dp.toPx() - label.size.width, ty - label.size.height / 2f))
                }

                val bar = e.kind == PlotKind.Bar
                val slot = plot.width / n
                val inset = if (bar) 0f else 6.dp.toPx()
                fun x(i: Int) = if (bar) plot.left + slot * (i + 0.5f) else plot.left + inset + if (n == 1) 0f else (plot.width - inset * 2) * i / (n - 1)
                xLabels.forEachIndexed { i, label ->
                    if (i >= n) return@forEachIndexed
                    val lx = (x(i) - label.size.width / 2f).coerceIn(plot.left, size.width - label.size.width)
                    drawText(label, topLeft = Offset(lx, plot.bottom + 6.dp.toPx()))
                }

                val zero = y(0.0.coerceIn(axis.min, axis.max))
                if (bar) drawBars(e, seriesColors, n, slot, ::x, ::y)
                else drawLines(e, seriesColors, n, ::x, ::y, zero, ring)
            }
            onDrawBehind { drawLayer(layer) }
        },
    )
}

private fun DrawScope.drawBars(e: Element.Plot, seriesColors: List<Color>, n: Int, slot: Float, x: (Int) -> Float, y: (Double) -> Float) {
    val stacked = e.stacked
    val k = e.series.size
    val gap = 3.dp.toPx()
    val group = min(slot * 0.68f, if (stacked) 28.dp.toPx() else 22.dp.toPx() * k + gap * (k - 1))
    val width = if (stacked) group else (group - gap * (k - 1)) / k
    val radius = CornerRadius(min(4.dp.toPx(), width / 2))
    for (i in 0 until n) {
        var base = 0.0
        val last = e.series.indexOfLast { it.values.getOrNull(i) != null }
        e.series.forEachIndexed { s, series ->
            val value = series.values.getOrNull(i) ?: return@forEachIndexed
            val left = if (stacked) x(i) - group / 2 else x(i) - group / 2 + s * (width + gap)
            val from = if (stacked) base else 0.0
            val to = from + value
            val end = !stacked || s == last
            val up = to >= from
            val top = if (end && up) radius else CornerRadius.Zero
            val bottom = if (end && !up) radius else CornerRadius.Zero
            val path = Path().apply {
                addRoundRect(
                    RoundRect(
                        left, y(maxOf(from, to)), left + width, y(minOf(from, to)),
                        topLeftCornerRadius = top, topRightCornerRadius = top, bottomLeftCornerRadius = bottom, bottomRightCornerRadius = bottom,
                    ),
                )
            }
            drawPath(path, seriesColors[s])
            if (stacked) base = to
        }
    }
}

/**
 * Lines, and for an area their fills. A `null` value breaks the line. Stacked,
 * each series fills only its band, down to the one under it; otherwise each
 * fill fades out towards the baseline, so overlapping fills don't muddy each other.
 */
private fun DrawScope.drawLines(e: Element.Plot, seriesColors: List<Color>, n: Int, x: (Int) -> Float, y: (Double) -> Float, zero: Float, ring: Color) {
    val area = e.kind == PlotKind.Area
    val stacked = e.stacked && area
    val sums = DoubleArray(n)
    // Each series as its points, a null where it has no value.
    val lines = e.series.map { series ->
        (0 until n).map { i ->
            val raw = series.values.getOrNull(i) ?: return@map null
            val v = raw + if (stacked) sums[i] else 0.0
            if (stacked) sums[i] = v
            Offset(x(i), y(v))
        }
    }
    fun runs(points: List<Offset?>): List<List<Pair<Int, Offset>>> {
        val out = ArrayList<List<Pair<Int, Offset>>>()
        var run = ArrayList<Pair<Int, Offset>>()
        points.forEachIndexed { i, p ->
            if (p == null) { if (run.isNotEmpty()) out += run; run = ArrayList() } else run += i to p
        }
        if (run.isNotEmpty()) out += run
        return out
    }
    if (area) {
        lines.forEachIndexed { s, points ->
            val color = seriesColors[s]
            val below = if (stacked && s > 0) lines[s - 1] else null
            for (run in runs(points)) {
                if (run.size < 2) continue
                val fill = Path().apply {
                    moveTo(run.first().second.x, below?.get(run.first().first)?.y ?: zero)
                    run.forEach { lineTo(it.second.x, it.second.y) }
                    if (below != null) run.asReversed().forEach { (i, p) -> lineTo(p.x, below[i]?.y ?: zero) }
                    else lineTo(run.last().second.x, zero)
                    close()
                }
                if (stacked) drawPath(fill, color.copy(alpha = 0.3f))
                else drawPath(fill, Brush.verticalGradient(listOf(color.copy(alpha = 0.22f), color.copy(alpha = 0.02f)), startY = run.minOf { it.second.y }, endY = zero))
            }
        }
    }
    lines.forEachIndexed { s, points ->
        val color = seriesColors[s]
        val segments = runs(points)
        for (run in segments) {
            if (run.size == 1) {
                drawCircle(color, 2.5.dp.toPx(), run[0].second)
                continue
            }
            val path = Path().apply {
                moveTo(run.first().second.x, run.first().second.y)
                run.drop(1).forEach { lineTo(it.second.x, it.second.y) }
            }
            drawPath(path, color, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        segments.lastOrNull()?.lastOrNull()?.second?.let { end ->
            drawCircle(ring, 5.dp.toPx(), end)
            drawCircle(color, 3.5.dp.toPx(), end)
        }
    }
}

/** A 26 thick ring with hairline gaps between slices, the centre text in it; the legend's values and shares under it. */
@Composable
private fun Donut(e: Element.Plot) {
    val colors = HappyTheme.colors
    val values = e.slices.map { max(0.0, it.value) }
    val total = values.sum()
    val shared = LocalGenUiColors.current
    val sliceColors = e.slices.map { shared.plot(it.color) }
    val gapColor = colors.surface
    val muted = shared.muted
    Box(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 4.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.widthIn(max = 196.dp).fillMaxWidth().aspectRatio(1f), contentAlignment = Alignment.Center) {
            Canvas(Modifier.matchParentSize()) {
                val thickness = 26.dp.toPx()
                val inset = thickness / 2
                val arc = Size(size.width - thickness, size.height - thickness)
                if (total <= 0) {
                    drawCircle(muted, radius = arc.width / 2, style = Stroke(thickness))
                    return@Canvas
                }
                var start = -90f
                values.forEachIndexed { i, v ->
                    val sweep = (v / total * 360).toFloat()
                    drawArc(sliceColors[i], start, sweep, false, Offset(inset, inset), arc, style = Stroke(thickness))
                    start += sweep
                }
                // Hairline gaps: a line in the ground's colour across the ring at each boundary.
                if (values.count { it > 0 } > 1) {
                    start = -90f
                    val c = Offset(size.width / 2, size.height / 2)
                    val r0 = arc.width / 2 - thickness / 2 - 1
                    val r1 = arc.width / 2 + thickness / 2 + 1
                    values.forEach { v ->
                        val angle = Math.toRadians(start.toDouble())
                        drawLine(
                            gapColor,
                            Offset(c.x + (r0 * Math.cos(angle)).toFloat(), c.y + (r0 * Math.sin(angle)).toFloat()),
                            Offset(c.x + (r1 * Math.cos(angle)).toFloat(), c.y + (r1 * Math.sin(angle)).toFloat()),
                            2.dp.toPx(),
                        )
                        start += (v / total * 360).toFloat()
                    }
                }
            }
            e.center?.let { center ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(center.value, style = roleStyle(TextRole.Value, Surface.Card).style, color = colors.text)
                    Text(center.label, style = roleStyle(TextRole.Detail, Surface.Card).style, color = colors.textSecondary)
                }
            }
        }
    }
    if (e.legend.isEmpty()) return
    val cell = roleStyle(TextRole.Cell, Surface.Card).style
    Column {
        e.legend.forEachIndexed { i, row ->
            if (i > 0) Hairline(Modifier.padding(start = 20.dp))
            Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(shared.plot(row.color)))
                Text(row.label, Modifier.weight(1f), style = cell, color = colors.text)
                row.value?.let { Text(it, style = cell.copy(fontWeight = FontWeight.Medium).tabular(), color = colors.text) }
                row.share?.let {
                    Text(it, Modifier.widthIn(min = 40.dp), style = cell.tabular(), color = colors.textSecondary, textAlign = TextAlign.End)
                }
            }
        }
    }
}

/** A trend: a 1.5 line over a soft fill, 24 high, the last reading marked, in its tone's ink. */
@Composable
internal fun SparkView(e: Element.Spark, modifier: Modifier) {
    val color = LocalGenUiColors.current.ink(e.tone)
    val values = e.values
    Spacer(
        modifier.fillMaxWidth().height(24.dp).drawWithCache {
            val line = Path()
            val fill = Path()
            val lo = values.min()
        val hi = values.max()
        val span = (hi - lo).takeIf { it > 0 } ?: 1.0
        val pad = 3.dp.toPx()
        val points = values.mapIndexed { i, v ->
            Offset((size.width - pad) * i / (values.size - 1), pad + (size.height - pad * 2) * (1 - ((v - lo) / span).toFloat()))
        }
            line.moveTo(points[0].x, points[0].y)
            points.drop(1).forEach { line.lineTo(it.x, it.y) }
            fill.addPath(line)
            fill.lineTo(points.last().x, size.height)
            fill.lineTo(points[0].x, size.height)
            fill.close()
            val stroke = Stroke(1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
            // The paths are built once per size; a scroll only draws them.
            onDrawBehind {
                drawPath(fill, color.copy(alpha = 0.1f))
                drawPath(line, color, style = stroke)
                drawCircle(color, 2.5.dp.toPx(), points.last())
            }
        },
    )
}
