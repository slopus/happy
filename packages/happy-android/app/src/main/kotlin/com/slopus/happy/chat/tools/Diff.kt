package com.slopus.happy.chat.tools

import androidx.compose.runtime.Immutable

// components/diff/engine: unified patches and before/after pairs turned into
// rows ready to draw. Syntax colouring and word-level emphasis are not ported;
// rows are plain text.

enum class DiffLineType { Add, Del, Ctx }

enum class FileChangeKind { Modified, Added, Deleted, Renamed, Binary }

@Immutable
sealed interface DiffRow {
    val key: String

    /** One line; numbers are 1-based, [oldNo] null for additions, [newNo] for deletions. */
    data class Line(
        override val key: String,
        val type: DiffLineType,
        val oldNo: Int?,
        val newNo: Int?,
        val text: String,
    ) : DiffRow

    /** `@@ -1,7 +1,9 @@`; [hidden] unchanged lines above it, when known. */
    data class Hunk(override val key: String, val text: String, val section: String, val hidden: Int?) : DiffRow

    data class Message(override val key: String, val binary: Boolean) : DiffRow
}

@Immutable
data class DiffFile(
    val path: String,
    val oldPath: String?,
    val kind: FileChangeKind,
    val additions: Int,
    val deletions: Int,
    val rows: List<DiffRow>,
    /** Longest line in characters, for the scrolling width. */
    val maxColumns: Int,
    /** Widest line number, for the gutter. */
    val maxLineNo: Int,
)

/** parsePatch.ts `RawLine` / `RawHunk` / `RawFile`. */
data class RawLine(val type: DiffLineType, val text: String, val oldNo: Int? = null, val newNo: Int? = null)

data class RawHunk(val oldStart: Int, val oldLines: Int, val newStart: Int, val newLines: Int, val section: String, val lines: List<RawLine>)

data class RawFile(val path: String, val oldPath: String?, val kind: FileChangeKind, val hunks: List<RawHunk>)

private val HUNK_HEADER = Regex("""^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$""")
private val GIT_HEADER = Regex("""^diff --git (.+) (.+)$""")

/** `cleanPath`: git's `a/` / `b/` prefixes, quoting and `diff -u` timestamps stripped. */
private fun cleanPath(raw: String): String {
    var p = raw.trim()
    if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) {
        p = p.substring(1, p.length - 1).replace("\\\"", "\"").replace("\\\\", "\\")
    }
    val tab = p.indexOf('\t')
    if (tab != -1) p = p.substring(0, tab)
    if (p.startsWith("a/") || p.startsWith("b/")) p = p.substring(2)
    return p
}

private class MutableFile(var path: String, var oldPath: String?, var kind: FileChangeKind) {
    val hunks = ArrayList<MutableHunk>()
}

private class MutableHunk(val oldStart: Int, val oldLines: Int, val newStart: Int, val newLines: Int, val section: String) {
    val lines = ArrayList<RawLine>()
}

/** parsePatch.ts `parsePatch`: tolerant; a malformed header renders what it can. */
fun parsePatch(patch: String): List<RawFile> {
    val lines = patch.split('\n').toMutableList()
    if (lines.size > 1 && lines.last().isEmpty()) lines.removeAt(lines.lastIndex)
    val files = ArrayList<RawFile>()
    var file: MutableFile? = null
    var hunk: MutableHunk? = null
    var oldNo = 0
    var newNo = 0
    var sawOldHeader = false

    fun pushFile() {
        file?.let { f -> files += RawFile(f.path, f.oldPath, f.kind, f.hunks.map { RawHunk(it.oldStart, it.oldLines, it.newStart, it.newLines, it.section, it.lines) }) }
        file = null
        hunk = null
    }

    fun ensureFile(path: String): MutableFile = file ?: MutableFile(path, null, FileChangeKind.Modified).also { file = it }

    for (line in lines) {
        if (line.startsWith("diff --git ") || line.startsWith("diff -")) {
            pushFile()
            sawOldHeader = false
            GIT_HEADER.find(line)?.let { m ->
                file = MutableFile(cleanPath(m.groupValues[2]), cleanPath(m.groupValues[1]), FileChangeKind.Modified)
            }
            continue
        }
        when {
            line.startsWith("new file mode") -> { file?.kind = FileChangeKind.Added; continue }
            line.startsWith("deleted file mode") -> { file?.kind = FileChangeKind.Deleted; continue }
            line.startsWith("rename from ") -> {
                file?.let { it.oldPath = cleanPath(line.removePrefix("rename from ")); it.kind = FileChangeKind.Renamed }
                continue
            }
            line.startsWith("rename to ") -> {
                val p = cleanPath(line.removePrefix("rename to "))
                val f = file
                if (f != null) { f.path = p; f.kind = FileChangeKind.Renamed } else file = MutableFile(p, null, FileChangeKind.Renamed)
                continue
            }
            line.startsWith("Binary files") || line.startsWith("GIT binary patch") -> { file?.kind = FileChangeKind.Binary; continue }
            line.startsWith("index ") || line.startsWith("similarity index") || line.startsWith("old mode") || line.startsWith("new mode") -> continue
        }
        if (line.startsWith("--- ")) {
            val p = line.substring(4)
            sawOldHeader = true
            val f = file
            when {
                p.trim() == "/dev/null" -> if (f != null) f.kind = FileChangeKind.Added else file = MutableFile("", null, FileChangeKind.Added)
                f != null -> f.oldPath = cleanPath(p)
                else -> file = MutableFile(cleanPath(p), cleanPath(p), FileChangeKind.Modified)
            }
            continue
        }
        if (line.startsWith("+++ ")) {
            val p = line.substring(4)
            if (p.trim() == "/dev/null") {
                val f = ensureFile(file?.oldPath ?: "")
                f.kind = FileChangeKind.Deleted
                if (f.path.isEmpty() && f.oldPath != null) f.path = f.oldPath!!
            } else {
                val cleaned = cleanPath(p)
                val f = ensureFile(cleaned)
                if (sawOldHeader || f.path.isEmpty()) f.path = cleaned
            }
            sawOldHeader = false
            continue
        }
        val hm = HUNK_HEADER.find(line)
        if (hm != null) {
            val f = ensureFile("")
            val g = hm.groupValues
            val h = MutableHunk(
                oldStart = g[1].toInt(),
                oldLines = g[2].ifEmpty { "1" }.toInt(),
                newStart = g[3].toInt(),
                newLines = g[4].ifEmpty { "1" }.toInt(),
                section = g[5],
            )
            f.hunks += h
            hunk = h
            oldNo = h.oldStart
            newNo = h.newStart
            continue
        }
        val h = hunk ?: continue
        if (line.startsWith("\\")) continue
        val text = if (line.isEmpty()) "" else line.substring(1)
        when {
            line.startsWith("+") -> h.lines += RawLine(DiffLineType.Add, text, newNo = newNo++)
            line.startsWith("-") -> h.lines += RawLine(DiffLineType.Del, text, oldNo = oldNo++)
            line.startsWith(" ") || line.isEmpty() -> h.lines += RawLine(DiffLineType.Ctx, text, oldNo++, newNo++)
        }
    }
    pushFile()
    return files.filter { it.path.isNotEmpty() || it.hunks.isNotEmpty() }
}

private fun splitKeep(value: String): List<String> {
    val parts = value.split('\n')
    return if (parts.isNotEmpty() && parts.last().isEmpty()) parts.dropLast(1) else parts
}

/**
 * `hunksFromContents`: a line diff of two texts folded into hunks with
 * [contextLines] of context. Myers' algorithm over the lines between the
 * common prefix and suffix, as the `diff` package computes it.
 */
fun hunksFromContents(oldText: String, newText: String, contextLines: Int = 3): List<RawHunk> {
    val a = splitKeep(oldText)
    val b = splitKeep(newText)
    val all = ArrayList<RawLine>(a.size + b.size)
    var oldNo = 1
    var newNo = 1
    if (a.isEmpty() || b.isEmpty()) {
        for (text in a) all += RawLine(DiffLineType.Del, text, oldNo = oldNo++)
        for (text in b) all += RawLine(DiffLineType.Add, text, newNo = newNo++)
        return foldHunks(all, contextLines)
    }
    for (op in lineDiff(a, b)) {
        when (op) {
            DiffLineType.Ctx -> { all += RawLine(DiffLineType.Ctx, a[oldNo - 1], oldNo, newNo); oldNo++; newNo++ }
            DiffLineType.Del -> { all += RawLine(DiffLineType.Del, a[oldNo - 1], oldNo = oldNo); oldNo++ }
            DiffLineType.Add -> { all += RawLine(DiffLineType.Add, b[newNo - 1], newNo = newNo); newNo++ }
        }
    }
    return foldHunks(all, contextLines)
}

/** The edit script turning [a] into [b], removals before additions in each changed run. */
internal fun lineDiff(a: List<String>, b: List<String>): List<DiffLineType> {
    var prefix = 0
    while (prefix < a.size && prefix < b.size && a[prefix] == b[prefix]) prefix++
    var suffix = 0
    while (suffix < a.size - prefix && suffix < b.size - prefix && a[a.size - 1 - suffix] == b[b.size - 1 - suffix]) suffix++
    val middle = myers(a.subList(prefix, a.size - suffix), b.subList(prefix, b.size - suffix))
    return List(prefix) { DiffLineType.Ctx } + middle + List(suffix) { DiffLineType.Ctx }
}

private fun myers(a: List<String>, b: List<String>): List<DiffLineType> {
    val n = a.size
    val m = b.size
    if (n == 0) return List(m) { DiffLineType.Add }
    if (m == 0) return List(n) { DiffLineType.Del }
    val max = n + m
    val offset = max
    var v = IntArray(2 * max + 2)
    val trace = ArrayList<IntArray>()
    var found = false
    for (d in 0..max) {
        trace += v.copyOf()
        val next = v.copyOf()
        var k = -d
        while (k <= d) {
            var x = if (k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1])) v[offset + k + 1] else v[offset + k - 1] + 1
            var y = x - k
            while (x < n && y < m && a[x] == b[y]) { x++; y++ }
            next[offset + k] = x
            if (x >= n && y >= m) { found = true; break }
            k += 2
        }
        v = next
        if (found) break
    }
    // Walk the trace back from (n, m), collecting operations in reverse.
    val ops = ArrayList<DiffLineType>(n + m)
    var x = n
    var y = m
    for (d in trace.lastIndex downTo 0) {
        val vd = trace[d]
        val k = x - y
        val prevK = if (k == -d || (k != d && vd[offset + k - 1] < vd[offset + k + 1])) k + 1 else k - 1
        val prevX = vd[offset + prevK]
        val prevY = prevX - prevK
        while (x > prevX && y > prevY) { ops += DiffLineType.Ctx; x--; y-- }
        if (d > 0) {
            if (x == prevX) { ops += DiffLineType.Add; y-- } else { ops += DiffLineType.Del; x-- }
        }
    }
    ops.reverse()
    return removalsFirst(ops)
}

/** Within each run of changes, removals come before additions, as the `diff` package emits them. */
private fun removalsFirst(ops: List<DiffLineType>): List<DiffLineType> {
    val out = ArrayList<DiffLineType>(ops.size)
    var i = 0
    while (i < ops.size) {
        if (ops[i] == DiffLineType.Ctx) { out += DiffLineType.Ctx; i++; continue }
        var dels = 0
        var adds = 0
        while (i < ops.size && ops[i] != DiffLineType.Ctx) {
            if (ops[i] == DiffLineType.Del) dels++ else adds++
            i++
        }
        repeat(dels) { out += DiffLineType.Del }
        repeat(adds) { out += DiffLineType.Add }
    }
    return out
}

/** `foldHunks`: unchanged runs longer than twice the context drop out between hunks. */
fun foldHunks(all: List<RawLine>, contextLines: Int): List<RawHunk> {
    if (all.none { it.type != DiffLineType.Ctx }) return emptyList()
    val keep = BooleanArray(all.size)
    var lastFilled = -1
    for (i in all.indices) {
        if (all[i].type == DiffLineType.Ctx) continue
        val from = maxOf(0, i - contextLines)
        val to = minOf(all.size - 1, i + contextLines)
        for (j in maxOf(from, lastFilled + 1)..to) keep[j] = true
        if (to > lastFilled) lastFilled = to
    }
    val hunks = ArrayList<RawHunk>()
    var i = 0
    while (i < all.size) {
        if (!keep[i]) { i++; continue }
        var j = i
        while (j < all.size && keep[j]) j++
        val slice = all.subList(i, j).toList()
        hunks += RawHunk(
            oldStart = slice.firstNotNullOfOrNull { it.oldNo } ?: 0,
            oldLines = slice.count { it.type != DiffLineType.Add },
            newStart = slice.firstNotNullOfOrNull { it.newNo } ?: 0,
            newLines = slice.count { it.type != DiffLineType.Del },
            section = "",
            lines = slice,
        )
        i = j
    }
    return hunks
}

private fun expandTabs(text: String, width: Int = 4): String {
    if ('\t' !in text) return text
    val out = StringBuilder()
    var column = 0
    for (ch in text) {
        if (ch == '\t') {
            val pad = width - column % width
            repeat(pad) { out.append(' ') }
            column += pad
        } else {
            out.append(ch)
            column++
        }
    }
    return out.toString()
}

/** buildDiff.ts `buildFile`, without syntax or word emphasis. */
fun buildDiffFile(raw: RawFile): DiffFile {
    val rows = ArrayList<DiffRow>()
    var additions = 0
    var deletions = 0
    var maxColumns = 0
    var maxLineNo = 0
    var previousOldEnd: Int? = null
    raw.hunks.forEachIndexed { hunkIndex, hunk ->
        val hidden = previousOldEnd?.let { hunk.oldStart - it } ?: (hunk.oldStart - 1)
        rows += DiffRow.Hunk(
            key = "h$hunkIndex",
            text = "@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@",
            section = hunk.section.trim(),
            hidden = hidden.takeIf { it > 0 },
        )
        previousOldEnd = hunk.oldStart + hunk.oldLines
        hunk.lines.forEachIndexed { lineIndex, line ->
            when (line.type) {
                DiffLineType.Add -> additions++
                DiffLineType.Del -> deletions++
                DiffLineType.Ctx -> Unit
            }
            val text = expandTabs(line.text)
            if (text.length > maxColumns) maxColumns = text.length
            maxLineNo = maxOf(maxLineNo, line.oldNo ?: 0, line.newNo ?: 0)
            rows += DiffRow.Line("$hunkIndex:$lineIndex", line.type, line.oldNo, line.newNo, text)
        }
    }
    if (raw.kind == FileChangeKind.Binary) rows += DiffRow.Message("binary", binary = true)
    else if (rows.isEmpty()) rows += DiffRow.Message("empty", binary = false)
    return DiffFile(
        path = raw.path,
        oldPath = raw.oldPath?.takeIf { it != raw.path },
        kind = raw.kind,
        additions = additions,
        deletions = deletions,
        rows = rows,
        maxColumns = maxColumns,
        maxLineNo = maxLineNo,
    )
}

fun buildDiffFromPatch(patch: String): List<DiffFile> = parsePatch(patch).map(::buildDiffFile)

fun buildDiffFromContents(path: String, oldText: String, newText: String, contextLines: Int = 3): DiffFile {
    val kind = when {
        oldText.isEmpty() && newText.isNotEmpty() -> FileChangeKind.Added
        newText.isEmpty() && oldText.isNotEmpty() -> FileChangeKind.Deleted
        else -> FileChangeKind.Modified
    }
    return buildDiffFile(RawFile(path, null, kind, hunksFromContents(oldText, newText, contextLines)))
}

/** layout.ts `selectVisibleRows`: the rows shown before "show more", never cutting a change run in half. */
fun selectVisibleRows(rows: List<DiffRow>, showHunkHeaders: Boolean, expanded: Boolean, collapseAfter: Int): Pair<List<DiffRow>, Int> {
    val visible = if (showHunkHeaders) rows else rows.filter { it !is DiffRow.Hunk }
    if (expanded || visible.size <= collapseAfter) return visible to 0
    fun isChange(row: DiffRow?) = row is DiffRow.Line && row.type != DiffLineType.Ctx
    var end = collapseAfter
    if (isChange(visible.getOrNull(end - 1)) && isChange(visible.getOrNull(end))) {
        val limit = minOf(visible.size, end + 200)
        while (end < limit && isChange(visible[end])) end++
    }
    return visible.subList(0, end) to visible.size - end
}

/** stats.ts `countPatchStats`. */
fun countPatchStats(patch: String): Pair<Int, Int> {
    var additions = 0
    var deletions = 0
    var inHunk = false
    for (line in patch.lineSequence()) {
        when {
            line.startsWith("@@") -> inHunk = true
            !inHunk -> Unit
            line.startsWith("+") && !line.startsWith("+++") -> additions++
            line.startsWith("-") && !line.startsWith("---") -> deletions++
            line.startsWith("diff ") -> inHunk = false
        }
    }
    return additions to deletions
}

/** stats.ts `countContentStats`: the same line diff the rows come from. */
fun countContentStats(oldText: String, newText: String): Pair<Int, Int> {
    val ops = lineDiff(splitKeep(oldText), splitKeep(newText))
    return ops.count { it == DiffLineType.Add } to ops.count { it == DiffLineType.Del }
}

/** codexUnifiedDiff.ts `materializeUnifiedDiffPatch`: a bare hunk gets file headers. */
fun materializeUnifiedDiffPatch(unifiedDiff: String, fileName: String, kind: String? = "update"): String {
    if ("\n--- " in unifiedDiff || unifiedDiff.startsWith("--- ") || "\n+++ " in unifiedDiff || unifiedDiff.startsWith("+++ ") ||
        unifiedDiff.startsWith("diff --git ")
    ) {
        return unifiedDiff
    }
    val oldPath = if (kind == "add") "/dev/null" else "a/$fileName"
    val newPath = if (kind == "delete") "/dev/null" else "b/$fileName"
    return "--- $oldPath\n+++ $newPath\n$unifiedDiff"
}

/** codexUnifiedDiff.ts `parseUnifiedDiff(...).fileName`: the `+++` path. */
fun unifiedDiffFileName(unifiedDiff: String): String? =
    unifiedDiff.lineSequence().lastOrNull { it.startsWith("+++ ") }?.removePrefix("+++ ")?.removePrefix("b/")
