package com.slopus.happy.ui.genui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.AlignmentLine
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.layout.IntrinsicMeasurable
import androidx.compose.ui.layout.IntrinsicMeasureScope
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.layout.Placeable
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.genui.Align
import com.slopus.happy.genui.Element
import com.slopus.happy.genui.IconRole
import com.slopus.happy.genui.Justify
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sign

/** How far apart the children of a row too narrow for them sit, one under another (iOS's `stackGap`). */
internal val KeyRowStackGap = 2.dp

/** A row with `fixed` text and no marker rail: [LineRow] lays it out as a [KeyRow]. */
internal fun keyRow(children: List<String>, elements: Map<String, Element>): Boolean =
    children.any { (elements[it] as? Element.Text)?.fixed == true } && children.none { elements[it] is Element.Marker }

/**
 * A row holding `fixed` text (a key and its value): on one line exactly as
 * [LineRow]'s Row lays it out (the same widths, weights, arrangement and
 * baseline), unless it doesn't fit its width and giving the `fixed` text
 * its natural width would leave another child narrower than its narrowest
 * readable width (for text, its widest piece between soft breaks: spaces
 * and an identifier's `_`). Then its children go one under another, each
 * at its natural width, at the start, [KeyRowStackGap] apart, in the row's
 * place. It is decided in the one measure pass, so the height never jumps
 * (iOS GenUIBoxLayout.line, 9baa638ee).
 */
@Composable
internal fun KeyRow(box: Element.Box, children: List<String>, gap: Dp, elements: Map<String, Element>, modifier: Modifier) {
    val slots = remember(children, elements) { children.map { slot(elements[it]) } }
    val arrangement = when (box.justify) {
        Justify.Between -> if (children.size > 1) Arrangement.SpaceBetween else Arrangement.spacedBy(gap)
        Justify.Start -> Arrangement.spacedBy(gap)
        Justify.End -> Arrangement.spacedBy(gap, Alignment.End)
    }
    val policy = remember(slots, arrangement, box.align) { KeyRowPolicy(slots, arrangement, box.align) }
    Layout(
        content = {
            children.forEachIndexed { i, child ->
                var m: Modifier = Modifier
                // SpaceBetween takes the gap away; give it back between neighbours, as LineRow does.
                if (box.justify == Justify.Between && i < children.lastIndex) m = m.padding(end = gap)
                val e = elements[child]
                if (box.align == Align.Start && e is Element.Icon && e.role == IconRole.Leading) m = m.padding(top = 1.dp)
                Draw(child, m)
            }
        },
        modifier,
        policy,
    )
}

/** How a child takes its width, as [rowChild] gives it in a Row: a weight of 1 (filling or not), or its own. */
internal class KeySlot(val weighted: Boolean, val fill: Boolean, val fixedText: Boolean, val icon: Boolean)

private fun slot(e: Element?): KeySlot = when {
    e is Element.Box && e.grow -> KeySlot(weighted = true, fill = true, fixedText = false, icon = false)
    e is Element.Box -> KeySlot(weighted = true, fill = false, fixedText = false, icon = false)
    e is Element.Text && !e.fixed -> KeySlot(weighted = true, fill = false, fixedText = false, icon = false)
    else -> KeySlot(weighted = false, fill = false, fixedText = e is Element.Text, icon = e is Element.Icon)
}

/**
 * Compose's Row measure (RowColumnMeasurePolicy, all weights 1) with
 * [align]'s alignment, and the stacking rule before it. Intrinsics are the
 * Row's, but a height asked of a width that stacks is the stack's.
 */
internal class KeyRowPolicy(private val slots: List<KeySlot>, private val arrangement: Arrangement.Horizontal, private val align: Align) : MeasurePolicy {
    override fun MeasureScope.measure(measurables: List<Measurable>, constraints: Constraints): MeasureResult {
        if (constraints.hasBoundedWidth && stacks(measurables, constraints.maxWidth, arrangement.spacing.roundToPx())) return stack(measurables, constraints)
        return row(measurables, constraints)
    }

    /**
     * Whether the row stacks at [width]: its natural widths don't fit, and
     * with the `fixed` text at its own, the Row would give another child
     * less than its narrowest readable width (or its natural one, if less).
     */
    private fun stacks(children: List<IntrinsicMeasurable>, width: Int, spacing: Int): Boolean {
        if (slots.none { it.fixedText }) return false
        val natural = children.map { it.maxIntrinsicWidth(Constraints.Infinity) }
        if (natural.sum() + spacing * (children.size - 1) <= width) return false
        // The Row: own widths first, in order, each with what is left; the weighted share the rest equally.
        var fixedSpace = 0
        var spaceAfterLast = 0
        val given = IntArray(children.size)
        for (i in children.indices) if (!slots[i].weighted) {
            val remaining = width - fixedSpace
            given[i] = min(natural[i], remaining.coerceAtLeast(0))
            spaceAfterLast = min(spacing, (remaining - given[i]).coerceAtLeast(0))
            fixedSpace += given[i] + spaceAfterLast
        }
        val weighted = slots.count { it.weighted }
        if (weighted > 0) {
            val share = ((width - fixedSpace - spacing * (weighted - 1)).coerceAtLeast(0) / weighted.toFloat()).roundToInt()
            for (i in children.indices) if (slots[i].weighted) given[i] = min(share, natural[i])
        }
        return children.indices.any { i ->
            !slots[i].fixedText && given[i] < min(children[i].minIntrinsicWidth(Constraints.Infinity), natural[i]) - 0.5f
        }
    }

    private fun MeasureScope.stack(measurables: List<Measurable>, constraints: Constraints): MeasureResult {
        val gap = KeyRowStackGap.roundToPx()
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val placeables = measurables.map { it.measure(loose) }
        val width = max(constraints.minWidth, placeables.maxOf { it.width }).coerceAtMost(constraints.maxWidth)
        val height = (placeables.sumOf { it.height } + gap * (placeables.size - 1)).coerceIn(constraints.minHeight, constraints.maxHeight)
        return layout(width, height) {
            var y = 0
            placeables.forEach {
                it.placeRelative(0, y)
                y += it.height + gap
            }
        }
    }

    private fun MeasureScope.row(measurables: List<Measurable>, constraints: Constraints): MeasureResult {
        val spacing = arrangement.spacing.roundToPx()
        val mainMax = constraints.maxWidth
        val bounded = mainMax != Constraints.Infinity
        val placeables = arrayOfNulls<Placeable>(measurables.size)
        var fixedSpace = 0
        var crossSpace = 0
        var spaceAfterLast = 0
        var weighted = 0
        for (i in measurables.indices) {
            if (slots[i].weighted) {
                weighted++
                continue
            }
            val remaining = if (bounded) mainMax - fixedSpace else Constraints.Infinity
            val p = measurables[i].measure(Constraints(0, if (bounded) remaining.coerceAtLeast(0) else Constraints.Infinity, 0, constraints.maxHeight))
            spaceAfterLast = if (bounded) min(spacing, (remaining - p.width).coerceAtLeast(0)) else spacing
            fixedSpace += p.width + spaceAfterLast
            crossSpace = max(crossSpace, p.height)
            placeables[i] = p
        }
        var weightedSpace = 0
        if (weighted == 0) {
            fixedSpace -= spaceAfterLast
        } else {
            val target = if (bounded) mainMax else constraints.minWidth
            val spacingTotal = spacing * (weighted - 1)
            val toTarget = (target - fixedSpace - spacingTotal).coerceAtLeast(0)
            val unit = toTarget / weighted.toFloat()
            var remainder = toTarget - unit.roundToInt() * weighted
            for (i in measurables.indices) if (slots[i].weighted) {
                val step = remainder.sign
                remainder -= step
                val size = max(0, unit.roundToInt() + step)
                val p = measurables[i].measure(Constraints(if (slots[i].fill) size else 0, size, 0, constraints.maxHeight))
                weightedSpace += p.width
                crossSpace = max(crossSpace, p.height)
                placeables[i] = p
            }
            weightedSpace = (weightedSpace + spacingTotal).coerceIn(0, if (bounded) (mainMax - fixedSpace).coerceAtLeast(0) else Int.MAX_VALUE)
        }
        val placed = placeables.map { it!! }
        // Baseline: each child's first baseline (an icon's bottom) on one line, as alignByBaseline puts them.
        var before = 0
        var after = 0
        if (align == Align.Baseline) {
            placed.forEachIndexed { i, p ->
                val line = line(i, p)
                before = max(before, if (line != AlignmentLine.Unspecified) line else 0)
                after = max(after, p.height - if (line != AlignmentLine.Unspecified) line else p.height)
            }
        }
        val width = max((fixedSpace + weightedSpace).coerceAtLeast(0), constraints.minWidth)
        val height = max(crossSpace, max(constraints.minHeight, before + after))
        val xs = IntArray(placed.size)
        with(arrangement) { arrange(width, IntArray(placed.size) { placed[it].width }, layoutDirection, xs) }
        return layout(width, height) {
            placed.forEachIndexed { i, p ->
                val y = when (align) {
                    Align.Baseline -> line(i, p).let { if (it != AlignmentLine.Unspecified) before - it else 0 }
                    Align.Center -> Alignment.CenterVertically.align(p.height, height)
                    Align.End -> Alignment.Bottom.align(p.height, height)
                    else -> Alignment.Top.align(p.height, height)
                }
                p.place(xs[i], y)
            }
        }
    }

    private fun line(i: Int, p: Placeable): Int = if (slots[i].icon) p.measuredHeight else p[FirstBaseline]

    // Intrinsics: the Row's (all weights 1).

    override fun IntrinsicMeasureScope.minIntrinsicWidth(measurables: List<IntrinsicMeasurable>, height: Int): Int =
        mainSize(measurables, arrangement.spacing.roundToPx()) { it.minIntrinsicWidth(height) }

    override fun IntrinsicMeasureScope.maxIntrinsicWidth(measurables: List<IntrinsicMeasurable>, height: Int): Int =
        mainSize(measurables, arrangement.spacing.roundToPx()) { it.maxIntrinsicWidth(height) }

    override fun IntrinsicMeasureScope.minIntrinsicHeight(measurables: List<IntrinsicMeasurable>, width: Int): Int =
        crossSize(measurables, width) { m, w -> m.minIntrinsicHeight(w) }

    override fun IntrinsicMeasureScope.maxIntrinsicHeight(measurables: List<IntrinsicMeasurable>, width: Int): Int =
        crossSize(measurables, width) { m, w -> m.maxIntrinsicHeight(w) }

    private fun mainSize(children: List<IntrinsicMeasurable>, spacing: Int, size: (IntrinsicMeasurable) -> Int): Int {
        var fixedSpace = 0
        var unit = 0
        var weighted = 0
        children.forEachIndexed { i, child ->
            val s = size(child)
            if (slots[i].weighted) {
                weighted++
                unit = max(unit, s)
            } else {
                fixedSpace += s
            }
        }
        return unit * weighted + fixedSpace + (children.size - 1) * spacing
    }

    private fun IntrinsicMeasureScope.crossSize(children: List<IntrinsicMeasurable>, width: Int, size: (IntrinsicMeasurable, Int) -> Int): Int {
        if (children.isEmpty()) return 0
        val spacing = arrangement.spacing.roundToPx()
        if (width != Constraints.Infinity && stacks(children, width, spacing)) {
            return children.sumOf { size(it, min(width, it.maxIntrinsicWidth(Constraints.Infinity))) } + KeyRowStackGap.roundToPx() * (children.size - 1)
        }
        var fixedSpace = min((children.size - 1) * spacing, width)
        var cross = 0
        var weighted = 0
        children.forEachIndexed { i, child ->
            if (slots[i].weighted) {
                weighted++
            } else {
                val remaining = if (width == Constraints.Infinity) Constraints.Infinity else width - fixedSpace
                val main = min(child.maxIntrinsicWidth(Constraints.Infinity), remaining)
                fixedSpace += main
                cross = max(cross, size(child, main))
            }
        }
        val unit = when {
            weighted == 0 -> 0
            width == Constraints.Infinity -> Constraints.Infinity
            else -> (max(width - fixedSpace, 0) / weighted.toFloat()).roundToInt()
        }
        children.forEachIndexed { i, child -> if (slots[i].weighted) cross = max(cross, size(child, unit)) }
        return cross
    }
}
