package com.slopus.happy.ui.genui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.slopus.happy.genui.Density
import com.slopus.happy.genui.Element
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme

/** Where a grid's row hairlines fell in its last layout, for drawing behind it. */
private class RowLines {
    var ys: List<Int> = emptyList()
}

/**
 * Cells in row-major order, columns sized together. An `auto` column is as
 * wide as its widest cell, a `fill` column takes what is left; when the auto
 * columns are too wide they shrink in proportion and their cells wrap.
 * A table is 12 between columns and 10 around each row's hairline; pairs are
 * 16 and 6. A header row has a hairline under it.
 */
@Composable
internal fun GridView(e: Element.Grid, modifier: Modifier) {
    val colors = HappyTheme.colors
    val elements = LocalGenUi.current?.document?.elements ?: return
    val lines = remember { RowLines() }
    val stroke = hairline()
    val table = e.density == Density.Table
    val columnGap = if (table) 12.dp else 16.dp
    val rowGap = if (table) 10.dp else 6.dp
    val n = e.columns.size
    Layout(
        // Alignment comes from the column alone: text spans its column and aligns as the column does.
        content = {
            e.children.forEachIndexed { i, child ->
                CompositionLocalProvider(LocalCellEnd provides e.columns[i % n].end) {
                    Draw(child, if (elements[child] is Element.Text) Modifier.fillMaxWidth() else Modifier)
                }
            }
        },
        modifier = modifier.fillMaxWidth().drawBehind {
            lines.ys.forEach { y -> drawLine(colors.divider, Offset(0f, y.toFloat()), Offset(size.width, y.toFloat()), stroke.toPx()) }
        },
    ) { measurables, constraints ->
        val width = constraints.maxWidth
        val colGap = columnGap.roundToPx()
        val rowPad = rowGap.roundToPx()
        val rows = measurables.chunked(n)
        val free = width - colGap * (n - 1)
        val asked = IntArray(n) { c ->
            if (e.columns[c].fill) 0 else rows.maxOfOrNull { r -> r.getOrNull(c)?.maxIntrinsicWidth(Constraints.Infinity) ?: 0 } ?: 0
        }
        val fills = e.columns.count { it.fill }
        val autoTotal = asked.sum()
        // A fill column keeps at least a quarter of its share; past that the auto columns shrink together.
        val minFill = if (fills > 0) free / (4 * fills) else 0
        val room = free - minFill * fills
        val squeeze = if (autoTotal > room) room.toFloat() / autoTotal else 1f
        val autos = IntArray(n) { c -> (asked[c] * squeeze).toInt() }
        val rest = if (fills > 0) (free - autos.sum()) / fills else 0
        val widths = IntArray(n) { c -> if (e.columns[c].fill) rest else autos[c] }
        val placed = rows.map { r -> r.mapIndexed { c, m -> m.measure(Constraints(maxWidth = widths[c].coerceAtLeast(0))) } }
        val heights = placed.map { r -> r.maxOfOrNull { it.height } ?: 0 }
        val ys = ArrayList<Int>()
        val tops = IntArray(rows.size)
        var y = 0
        heights.forEachIndexed { i, h ->
            if (i > 0) {
                val divided = e.divide || (e.header && i == 1)
                if (divided) {
                    y += rowPad
                    ys += y
                    y += rowPad
                } else {
                    y += rowPad
                }
            }
            tops[i] = y
            y += h
        }
        lines.ys = ys
        layout(width, y) {
            placed.forEachIndexed { i, r ->
                var x = 0
                r.forEachIndexed { c, p ->
                    val dx = if (e.columns[c].end) widths[c] - p.width else 0
                    p.place(x + dx, tops[i])
                    x += widths[c] + colGap
                }
            }
        }
    }
}
