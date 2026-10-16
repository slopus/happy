package com.slopus.happy.diff

/**
 * happy-app engine/intraline.ts: word-level emphasis inside changed lines.
 * When a line only had one identifier renamed, point at the identifier
 * rather than repaint the whole line; and only for lines that are actually
 * related, or the emphasis is noise.
 */
object Intraline {
    /** Lines longer than this skip word diffing. */
    private const val MAX_LINE_FOR_WORD_DIFF = 1500

    /** Below this similarity two lines are unrelated; whole-line colour reads better. */
    private const val MIN_SIMILARITY = 0.34

    /** A changed block bigger than this is almost never a 1:1 edit. */
    private const val MAX_BLOCK_FOR_PAIRING = 60

    /** A `[start, end)` range of UTF-16 units. */
    data class Range(val start: Int, val end: Int)

    /** Shared prefix and suffix over the longer length: one edit in an otherwise equal line scores high. */
    fun similarity(a: String, b: String): Double {
        if (a == b) return 1.0
        val max = maxOf(a.length, b.length)
        if (max == 0) return 1.0
        val min = minOf(a.length, b.length)
        var prefix = 0
        while (prefix < min && a[prefix] == b[prefix]) prefix++
        var suffix = 0
        while (suffix < min - prefix && a[a.length - 1 - suffix] == b[b.length - 1 - suffix]) suffix++
        return (prefix + suffix).toDouble() / max
    }

    /** Word-level diff of one line pair, as ranges on each side. */
    fun wordRanges(oldLine: String, newLine: String): Pair<List<Range>, List<Range>> {
        if (oldLine.length > MAX_LINE_FOR_WORD_DIFF || newLine.length > MAX_LINE_FOR_WORD_DIFF) {
            return listOf(Range(0, oldLine.length)) to listOf(Range(0, newLine.length))
        }
        val del = ArrayList<Range>()
        val ins = ArrayList<Range>()
        var oldPos = 0
        var newPos = 0
        for (part in MyersDiff.diffWordsWithSpace(oldLine, newLine)) {
            val length = part.value.length
            when {
                part.added -> {
                    push(ins, newPos, newPos + length)
                    newPos += length
                }
                part.removed -> {
                    push(del, oldPos, oldPos + length)
                    oldPos += length
                }
                else -> {
                    oldPos += length
                    newPos += length
                }
            }
        }
        return del to ins
    }

    /** Appends a range, joining it to the previous one when they touch. */
    private fun push(ranges: MutableList<Range>, start: Int, end: Int) {
        if (end <= start) return
        val last = ranges.lastOrNull()
        if (last != null && last.end == start) ranges[ranges.lastIndex] = Range(last.start, end) else ranges.add(Range(start, end))
    }

    /**
     * computeEmphasis: pairs each `-` run with the `+` run right after it,
     * i-th with i-th, and records ranges for both sides, keyed by index into
     * [lines]. A [deadline] (epoch ms) stops early, keeping what is done.
     */
    fun computeEmphasis(lines: List<RawLine>, deadline: Long? = null): Map<Int, List<Range>> {
        val map = HashMap<Int, List<Range>>()
        var i = 0
        while (i < lines.size) {
            if (lines[i].type != DiffLineType.Del) {
                i++
                continue
            }
            var delEnd = i
            while (delEnd < lines.size && lines[delEnd].type == DiffLineType.Del) delEnd++
            var addEnd = delEnd
            while (addEnd < lines.size && lines[addEnd].type == DiffLineType.Add) addEnd++
            val delCount = delEnd - i
            val addCount = addEnd - delEnd
            if (addCount == 0) {
                i = if (addEnd != 0) addEnd else i + 1
                continue
            }
            if (delCount <= MAX_BLOCK_FOR_PAIRING && addCount <= MAX_BLOCK_FOR_PAIRING) {
                for (p in 0 until minOf(delCount, addCount)) {
                    if (deadline != null && System.currentTimeMillis() >= deadline) return map
                    val delIndex = i + p
                    val addIndex = delEnd + p
                    val oldLine = lines[delIndex].text
                    val newLine = lines[addIndex].text
                    if (oldLine == newLine) continue
                    if (similarity(oldLine, newLine) < MIN_SIMILARITY) continue
                    val (del, ins) = wordRanges(oldLine, newLine)
                    // If practically everything changed, emphasis adds nothing.
                    if (coverage(del, oldLine.length) > 0.9 && coverage(ins, newLine.length) > 0.9) continue
                    if (del.isNotEmpty()) map[delIndex] = del
                    if (ins.isNotEmpty()) map[addIndex] = ins
                }
            }
            i = addEnd
        }
        return map
    }

    private fun coverage(ranges: List<Range>, length: Int): Double {
        if (length == 0) return 1.0
        return ranges.sumOf { it.end - it.start }.toDouble() / length
    }
}
