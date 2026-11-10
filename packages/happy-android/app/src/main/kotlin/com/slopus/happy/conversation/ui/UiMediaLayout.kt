package com.slopus.happy.conversation.ui

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The one layout every Happy client draws a chat UI `media` component with
 * (@slopus/happy-agent-client `sources/ui/layoutMedia.ts`, ported line for
 * line), so all of them agree and a component's height is known before a
 * byte arrives:
 *
 * - Justified rows at a target height ([ROW_HEIGHT] on a phone), [GAP] apart.
 * - A row takes the next item while it still fits the width at the target
 *   height, or when the row filled with it comes nearer that height than
 *   without it. A row another item was waiting for room after is scaled to
 *   fill the width exactly, never past [MAX_ROW_SCALE] times the target; the
 *   last row stays at the target, on the left, shrinking only to fit.
 * - A single item is min(the width, [SINGLE_HEIGHT_SCALE] × the target × its
 *   aspect) wide, on the left.
 * - Aspects are clamped to [[MIN_ASPECT], [MAX_ASPECT]] for layout only; the
 *   picture covers its box.
 * - A label is one [LABEL_LINE] line [LABEL_GAP] under its item; a row with
 *   any label is that much taller.
 *
 * Sizes come from the presentation's items alone: one that states none is
 * laid out as 16:9 when it is a recording and 4:3 otherwise. Whole dp,
 * rounded as JavaScript's `Math.round`, so the frames are the desktop's to
 * the unit.
 */
object UiMediaLayout {
    const val ROW_HEIGHT = 160.0
    const val GAP = 6.0
    const val LABEL_GAP = 4.0
    const val LABEL_LINE = 18.0
    const val MAX_ROW_SCALE = 1.5
    const val SINGLE_HEIGHT_SCALE = 2.0
    const val MIN_ASPECT = 0.4
    const val MAX_ASPECT = 3.0

    /** What layout reads of one item: its kind, its measured size, and whether it carries a label. */
    data class Input(val kind: String, val width: Double?, val height: Double?, val labelled: Boolean)

    /** A box from the flow's top left, in whole dp. */
    data class Frame(val x: Double, val y: Double, val width: Double, val height: Double)

    /** Each item's picture and its label line (null without a label), in item order, and the height they take. */
    data class Arrangement(val frames: List<Frame>, val labels: List<Frame?>, val height: Double)

    /** An item's aspect for layout: its own, clamped; a default where it states no size. */
    fun aspect(item: Input): Double {
        val w = item.width
        val h = item.height
        val measured = if (w != null && h != null && w > 0 && h > 0) w / h else if (item.kind == "video") 16.0 / 9.0 else 4.0 / 3.0
        return min(MAX_ASPECT, max(MIN_ASPECT, measured))
    }

    /** [items] across [width], from the top left, in rows of target height [ROW_HEIGHT]. */
    fun layout(items: List<Input>, width: Double): Arrangement {
        val available = max(1.0, floor(width))
        val aspects = items.map(::aspect)
        val rows = ArrayList<Row>()
        if (items.size == 1) {
            val aspect = aspects[0]
            val pictureWidth = round(min(available, SINGLE_HEIGHT_SCALE * ROW_HEIGHT * aspect))
            rows += Row(listOf(Placed(0, pictureWidth)), round(pictureWidth / aspect))
        } else {
            var start = 0
            while (start < items.size) {
                var sum = aspects[start]
                var end = start + 1
                while (end < items.size) {
                    val next = sum + aspects[end]
                    val gapsNext = GAP * (end - start)
                    val fits = next * ROW_HEIGHT + gapsNext <= available
                    val without = (available - gapsNext + GAP) / sum
                    val nearer = abs((available - gapsNext) / next - ROW_HEIGHT) < abs(without - ROW_HEIGHT)
                    if (!fits && !nearer) break
                    sum = next
                    end++
                }
                val gaps = GAP * (end - start - 1)
                val filled = end < items.size
                val fit = (available - gaps) / sum
                val height = min(if (filled) MAX_ROW_SCALE * ROW_HEIGHT else ROW_HEIGHT, fit)
                val stretched = filled && height == fit
                // Edges are rounded from running totals, so a filled row's widths add up exactly.
                val placed = ArrayList<Placed>()
                var edge = 0.0
                for (index in start until end) {
                    val after = edge + aspects[index] * height
                    val right = if (stretched && index == end - 1) available - gaps else round(after)
                    placed += Placed(index, right - round(edge))
                    edge = after
                }
                rows += Row(placed, round(height))
                start = end
            }
        }
        val frames = ArrayList<Frame>()
        val labels = ArrayList<Frame?>()
        var y = 0.0
        rows.forEachIndexed { rowIndex, row ->
            if (rowIndex > 0) y += GAP
            var x = 0.0
            var labelled = false
            row.placed.forEachIndexed { position, item ->
                if (position > 0) x += GAP
                frames += Frame(x, y, item.width, row.height)
                val label = items[item.index].labelled
                labelled = labelled || label
                labels += if (label) Frame(x, y + row.height + LABEL_GAP, item.width, LABEL_LINE) else null
                x += item.width
            }
            y += row.height + if (labelled) LABEL_GAP + LABEL_LINE else 0.0
        }
        return Arrangement(frames, labels, y)
    }

    private class Placed(val index: Int, val width: Double)

    private class Row(val placed: List<Placed>, val height: Double)

    /** JavaScript's `Math.round`: half toward positive infinity. */
    private fun round(value: Double): Double = floor(value + 0.5)
}
