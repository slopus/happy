package com.slopus.happy.conversation.ui

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The one layout rule every Happy client gives the chat UI `media` component
 * (happy-agent API.md "Chat UI", `media`; the client package's
 * `sources/ui/layoutMedia.ts`), so
 * all of them agree and know its height before a byte arrives:
 *
 * - Justified rows at a target height H (160 dp on a phone), 6 apart.
 * - A row takes items while it still fits the width at H, then scales to fill
 *   the width exactly, never taller than 1.5 × H. It also takes the next item
 *   when the row filled with it comes nearer H than without it. A last row
 *   that ran out of items stays at H, on the left, or shrinks to fit.
 * - A single item is min(the width, 2 × H × its aspect) wide, on the left.
 * - Aspects are clamped to [0.4, 3] for layout only; the picture covers its box.
 * - A label is one 18 line 4 under its item; a row with any label is that
 *   line taller.
 *
 * Sizes come from the media snapshots alone: an item that states none is
 * laid out as 4:3, or 16:9 for a recording. Whole units, rounded as
 * JavaScript's `Math.round`, so the frames match the desktop's to the unit.
 */
object UiMediaLayout {
    const val ROW_HEIGHT = 160.0
    const val GAP = 6.0
    const val LABEL_GAP = 4.0
    const val LABEL_LINE = 18.0
    private const val ROW_STRETCH_MAX = 1.5
    private const val SINGLE_HEIGHT_MAX = 2.0
    private const val ASPECT_MIN = 0.4
    private const val ASPECT_MAX = 3.0

    /** What layout reads of one item: its snapshot's size, and whether it carries a label. */
    data class Input(val kind: String, val width: Double?, val height: Double?, val labelled: Boolean)

    /** A box from the flow's top left, in whole dp. */
    data class Frame(val x: Double, val y: Double, val width: Double, val height: Double)

    /** Each item's picture and its label line (null without a label), in item order, and the height they take. */
    data class Arrangement(val frames: List<Frame>, val labels: List<Frame?>, val height: Double)

    /** An item's aspect for layout: its own, clamped; a default where its snapshot states none. */
    fun aspect(item: Input): Double {
        val w = item.width
        val h = item.height
        val aspect = if (w != null && h != null && w > 0 && h > 0) w / h else if (item.kind == "video") 16.0 / 9.0 else 4.0 / 3.0
        return min(ASPECT_MAX, max(ASPECT_MIN, aspect))
    }

    /** The client package's `layoutMedia`: [items] across [width] at target row height [rowHeight]. */
    fun layout(items: List<Input>, width: Double, rowHeight: Double = ROW_HEIGHT): Arrangement {
        val available = max(1.0, floor(width))
        val aspects = items.map(::aspect)
        // Each row: its items' (index, width), and its picture height.
        val rows = ArrayList<Pair<List<Pair<Int, Double>>, Double>>()
        if (items.size == 1) {
            val aspect = aspects[0]
            val pictureWidth = round(min(available, SINGLE_HEIGHT_MAX * rowHeight * aspect))
            rows += listOf(0 to pictureWidth) to round(pictureWidth / aspect)
        } else {
            var start = 0
            while (start < items.size) {
                var sum = aspects[start]
                var end = start + 1
                while (end < items.size) {
                    val next = sum + aspects[end]
                    val gapsNext = GAP * (end - start)
                    // It fits at H; or, filled, the row with it comes nearer H than without.
                    val fits = next * rowHeight + gapsNext <= available
                    val without = (available - gapsNext + GAP) / sum
                    val nearer = abs((available - gapsNext) / next - rowHeight) < abs(without - rowHeight)
                    if (!fits && !nearer) break
                    sum = next
                    end++
                }
                val gaps = GAP * (end - start - 1)
                // Filled when another item was waiting for room; the last row keeps H.
                val filled = end < items.size
                val fit = (available - gaps) / sum
                val height = min(if (filled) ROW_STRETCH_MAX * rowHeight else rowHeight, fit)
                val stretched = filled && height == fit
                // A filled row's edges are rounded from running totals, so its widths add up to the width exactly.
                val placed = ArrayList<Pair<Int, Double>>()
                var edge = 0.0
                for (index in start until end) {
                    val after = edge + aspects[index] * height
                    val right = if (stretched && index == end - 1) available - gaps else round(after)
                    placed += index to right - round(edge)
                    edge = after
                }
                rows += placed to round(height)
                start = end
            }
        }
        val frames = ArrayList<Frame>()
        val labels = ArrayList<Frame?>()
        var y = 0.0
        rows.forEachIndexed { rowIndex, (placed, height) ->
            if (rowIndex > 0) y += GAP
            var x = 0.0
            var labelled = false
            placed.forEachIndexed { position, (index, itemWidth) ->
                if (position > 0) x += GAP
                frames += Frame(x, y, itemWidth, height)
                val label = items[index].labelled
                labelled = labelled || label
                labels += if (label) Frame(x, y + height + LABEL_GAP, itemWidth, LABEL_LINE) else null
                x += itemWidth
            }
            y += height + if (labelled) LABEL_GAP + LABEL_LINE else 0.0
        }
        return Arrangement(frames, labels, y)
    }

    /** JavaScript's `Math.round`: half toward positive infinity. */
    private fun round(value: Double): Double = floor(value + 0.5)
}
