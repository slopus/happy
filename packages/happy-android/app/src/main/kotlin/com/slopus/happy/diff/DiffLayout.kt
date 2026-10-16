package com.slopus.happy.diff

import kotlin.math.ceil

/**
 * happy-app components/diff/layout.ts: which rows show and how wide the
 * gutter is, decided before drawing anything.
 */
object DiffLayout {
    /** How far past the collapse limit we go to finish a change block. */
    private const val MAX_SNAP = 200

    data class VisibleRows(val rows: List<DiffRow>, /** What the collapse holds back, for "show more". */ val hiddenCount: Int)

    private fun isChangeLine(row: DiffRow?) = row is DiffRow.Line && row.type != DiffLineType.Ctx

    /** selectVisibleRows: never cuts through a run of removals and the additions that replaced them. */
    fun selectVisibleRows(rows: List<DiffRow>, showHunkHeaders: Boolean, expanded: Boolean, collapseAfter: Int): VisibleRows {
        val visible = if (showHunkHeaders) rows else rows.filter { it !is DiffRow.Hunk }
        if (expanded || visible.size <= collapseAfter) return VisibleRows(visible, 0)
        var end = collapseAfter
        if (isChangeLine(visible.getOrNull(end - 1)) && isChangeLine(visible.getOrNull(end))) {
            val limit = minOf(visible.size, end + MAX_SNAP)
            while (end < limit && isChangeLine(visible[end])) end++
        }
        return VisibleRows(visible.subList(0, end).toList(), visible.size - end)
    }

    /** gutterWidthFor: the marker column always, line numbers sized by the widest one. */
    fun gutterWidth(charWidth: Float, maxLineNo: Int, showLineNumbers: Boolean): Float {
        val markerColumns = 2
        val digits = if (showLineNumbers) maxOf(2, maxOf(1, maxLineNo).toString().length) else 0
        return ceil((digits + markerColumns) * charWidth) + if (showLineNumbers) 12 else 4
    }
}
