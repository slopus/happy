package com.slopus.happy.diff

/**
 * happy-app engine/splitRows.ts: unified rows paired into side-by-side
 * rows. Pairing is positional (i-th removal opposite i-th addition), as
 * the word diff pairs them; uneven runs pad with null, an empty cell.
 */
sealed interface SplitRow {
    val key: String

    /** Hunk separators and messages span both columns. */
    data class Full(override val key: String, val row: DiffRow) : SplitRow

    /** [left] is the old side, null for a pure addition; [right] the new side. */
    data class Pair(override val key: String, val left: DiffRow.Line?, val right: DiffRow.Line?) : SplitRow
}

/** buildSplitRows. */
fun buildSplitRows(rows: List<DiffRow>): List<SplitRow> {
    val out = ArrayList<SplitRow>()
    fun lineOf(index: Int, type: DiffLineType) = (rows.getOrNull(index) as? DiffRow.Line)?.takeIf { it.type == type }
    var i = 0
    while (i < rows.size) {
        val row = rows[i]
        if (row !is DiffRow.Line) {
            out.add(SplitRow.Full(row.key, row))
            i++
            continue
        }
        if (row.type == DiffLineType.Ctx) {
            // Context exists on both sides, so the same row renders twice.
            out.add(SplitRow.Pair(row.key, row, row))
            i++
            continue
        }
        var delEnd = i
        while (lineOf(delEnd, DiffLineType.Del) != null) delEnd++
        var addEnd = delEnd
        while (lineOf(addEnd, DiffLineType.Add) != null) addEnd++
        val dels = (i until delEnd).map { rows[it] as DiffRow.Line }
        val adds = (delEnd until addEnd).map { rows[it] as DiffRow.Line }
        for (p in 0 until maxOf(dels.size, adds.size)) {
            val left = dels.getOrNull(p)
            val right = adds.getOrNull(p)
            out.add(SplitRow.Pair("${left?.key ?: "_"}|${right?.key ?: "_"}", left, right))
        }
        // Advances: a del or add row is consumed by one of the two runs.
        i = addEnd
    }
    return out
}
