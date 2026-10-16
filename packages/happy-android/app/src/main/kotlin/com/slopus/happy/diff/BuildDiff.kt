package com.slopus.happy.diff

/** A run of [length] UTF-16 units of one syntax class inside a line (highlight.ts `SyntaxRun`). */
data class SyntaxRun(val kind: SpanKind, val length: Int)

/** Turns a block of text into runs, one list per `\n`-separated line (highlight.ts `highlightLines`). */
fun interface DiffHighlighter {
    fun highlightLines(text: String, language: String): List<List<SyntaxRun>>
}

/** buildDiff.ts `DiffBudget`: limits for a full-contents line diff. */
data class DiffBudget(val timeoutMs: Long, val maxEditLength: Int)

/** buildDiff.ts `BuildOptions`, with happy-app's defaults. */
data class BuildOptions(
    /** Context lines when diffing two blobs; patches keep their own. */
    val contextLines: Int = 3,
    /** Fold away whitespace-only changes when diffing two blobs. */
    val ignoreWhitespace: Boolean = false,
    /** Abort an expensive contents diff before it blocks. */
    val diffBudget: DiffBudget? = null,
    /** Syntax colouring; null is off, as happy-app's default (colour is prepared separately). */
    val highlighter: DiffHighlighter? = null,
    /** Word-level emphasis inside changed lines. */
    val intraline: Boolean = true,
    /** Tabs are expanded at build time so column math is exact. */
    val tabWidth: Int = 4,
    /** Files past this many lines skip colour and word diffs. */
    val maxHighlightLines: Int = 8000,
)

/**
 * happy-app engine/buildDiff.ts: raw patches into render-ready documents.
 * Parsing, tab expansion, colouring, word diffs and span merging happen
 * once per input; results are cached (48 documents) and theme-independent.
 * Call off the main thread.
 */
object DiffBuilder {
    private val cache = DiffLruCache<DiffDocument>(48)

    /** buildDiffFromPatch. */
    fun fromPatch(patch: String, options: BuildOptions = BuildOptions()): DiffDocument {
        val key = cacheKey("p", patch, options)
        cache.get(key)?.let { return it }
        val started = System.nanoTime()
        val doc = finish(PatchParser.parse(patch).map { buildFile(it, options) }, started)
        cache.set(key, doc)
        return doc
    }

    /** buildDiffFromContents. */
    fun fromContents(path: String, oldText: String, newText: String, options: BuildOptions = BuildOptions()): DiffDocument {
        val key = cacheKey("c", "$path\u0000$oldText\u0000$newText", options)
        cache.get(key)?.let { return it }
        val started = System.nanoTime()
        val emphasisDeadline = options.diffBudget?.let { System.currentTimeMillis() + it.timeoutMs }
        val hunks = try {
            PatchParser.hunksFromContents(
                oldText, newText, options.contextLines, options.ignoreWhitespace,
                options.diffBudget?.let { MyersDiff.Budget(it.timeoutMs, it.maxEditLength) },
            )
        } catch (_: DiffBudgetExceededException) {
            return DiffDocument(emptyList(), 0, 0, elapsed(started), "Diff is too large to render on this device.")
        }
        val raw = RawFile(path, null, PatchParser.contentsKind(oldText, newText), hunks)
        val doc = finish(listOf(buildFile(raw, options, emphasisDeadline)), started)
        cache.set(key, doc)
        return doc
    }

    /** clearDiffCache. */
    fun clearCache() = cache.clear()

    private fun elapsed(started: Long) = (System.nanoTime() - started) / 1e6

    private fun finish(files: List<DiffFile>, started: Long) =
        DiffDocument(files, files.sumOf { it.additions }, files.sumOf { it.deletions }, elapsed(started))

    private fun buildFile(raw: RawFile, options: BuildOptions, emphasisDeadline: Long? = null): DiffFile {
        val language = DiffLanguage.detect(raw.path)
        val totalLines = raw.hunks.sumOf { it.lines.size }
        val rich = totalLines <= options.maxHighlightLines

        val rows = ArrayList<DiffRow>()
        var additions = 0
        var deletions = 0
        var maxColumns = 0
        var maxLineNo = 0
        var previousOldEnd: Int? = null

        raw.hunks.forEachIndexed { hunkIndex, hunk ->
            // Tabs first: every offset afterwards refers to the expanded text.
            val lines = hunk.lines.map { it.copy(text = expandTabs(it.text, options.tabWidth)) }

            val hidden = previousOldEnd?.let { hunk.oldStart - it } ?: (hunk.oldStart - 1)
            rows.add(
                DiffRow.Hunk(
                    key = "h$hunkIndex",
                    text = "@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@",
                    section = JsText.trim(hunk.section),
                    hidden = hidden.takeIf { it > 0 },
                ),
            )
            previousOldEnd = hunk.oldStart + hunk.oldLines

            val syntax = if (rich && options.highlighter != null) highlightHunk(lines, language, options.highlighter) else null
            val emphasis = if (rich && options.intraline) Intraline.computeEmphasis(lines, emphasisDeadline) else null

            lines.forEachIndexed { lineIndex, line ->
                if (line.type == DiffLineType.Add) additions++ else if (line.type == DiffLineType.Del) deletions++
                val runs = syntax?.getOrNull(lineIndex) ?: plainRuns(line.text)
                val spans = mergeSpans(
                    line.text, runs, emphasis?.get(lineIndex),
                    if (line.type == DiffLineType.Add) SpanEmphasis.Inserted else SpanEmphasis.Deleted,
                )
                if (line.text.length > maxColumns) maxColumns = line.text.length
                val no = maxOf(line.oldNo ?: 0, line.newNo ?: 0)
                if (no > maxLineNo) maxLineNo = no
                rows.add(DiffRow.Line("$hunkIndex:$lineIndex", line.type, line.oldNo, line.newNo, line.text, spans))
            }
        }

        if (raw.kind == FileChangeKind.Binary) {
            rows.add(DiffRow.Message("binary", DiffRow.Message.Code.Binary))
        } else if (rows.isEmpty()) {
            rows.add(DiffRow.Message("empty", DiffRow.Message.Code.Empty))
        }

        return DiffFile(
            path = raw.path,
            oldPath = raw.oldPath?.takeIf { it.isNotEmpty() && it != raw.path },
            kind = raw.kind,
            language = language,
            additions = additions,
            deletions = deletions,
            rows = rows,
            maxColumns = maxColumns,
            maxLineNo = maxLineNo,
        )
    }

    /**
     * Colours a hunk by rebuilding each side as contiguous text, so block
     * comments and template strings span lines, then puts the runs back on
     * the interleaved lines. Context lines take the new side's colouring.
     */
    private fun highlightHunk(lines: List<RawLine>, language: String?, highlighter: DiffHighlighter): List<List<SyntaxRun>> {
        if (language == null) return lines.map { plainRuns(it.text) }
        val oldIndex = ArrayList<Int>()
        val newIndex = ArrayList<Int>()
        lines.forEachIndexed { i, line ->
            if (line.type != DiffLineType.Add) oldIndex.add(i)
            if (line.type != DiffLineType.Del) newIndex.add(i)
        }
        val result = arrayOfNulls<List<SyntaxRun>>(lines.size)
        val oldRuns = highlighter.highlightLines(oldIndex.joinToString("\n") { lines[it].text }, language)
        val newRuns = highlighter.highlightLines(newIndex.joinToString("\n") { lines[it].text }, language)
        oldIndex.forEachIndexed { i, lineIndex -> result[lineIndex] = oldRuns.getOrNull(i) ?: plainRuns(lines[lineIndex].text) }
        newIndex.forEachIndexed { i, lineIndex -> result[lineIndex] = newRuns.getOrNull(i) ?: result[lineIndex] ?: plainRuns(lines[lineIndex].text) }
        return result.mapIndexed { i, runs -> runs ?: plainRuns(lines[i].text) }
    }

    private fun plainRuns(text: String) = if (text.isEmpty()) emptyList() else listOf(SyntaxRun(SpanKind.Plain, text.length))

    /**
     * mergeSpans: word-diff ranges over syntax runs, split at every boundary
     * of either, with neighbours of the same class and emphasis joined.
     */
    fun mergeSpans(text: String, runs: List<SyntaxRun>, ranges: List<Intraline.Range>?, emphasis: SpanEmphasis): List<DiffSpan> {
        if (text.isEmpty()) return emptyList()
        val spans = ArrayList<DiffSpan>()
        fun append(from: Int, to: Int, kind: SpanKind, e: SpanEmphasis) {
            if (to <= from) return
            val last = spans.lastOrNull()
            if (last != null && last.kind == kind && last.emphasis == e) {
                spans[spans.lastIndex] = last.copy(text = last.text + text.substring(from, to))
            } else {
                spans.add(DiffSpan(text.substring(from, to), kind, e))
            }
        }

        var pos = 0
        var rangeIndex = 0
        for (run in runs) {
            val runEnd = minOf(pos + run.length, text.length)
            if (ranges.isNullOrEmpty()) {
                append(pos, runEnd, run.kind, SpanEmphasis.None)
                pos = runEnd
                continue
            }
            var cursor = pos
            while (cursor < runEnd) {
                while (rangeIndex < ranges.size && ranges[rangeIndex].end <= cursor) rangeIndex++
                val range = ranges.getOrNull(rangeIndex)
                if (range == null || range.start >= runEnd) {
                    append(cursor, runEnd, run.kind, SpanEmphasis.None)
                    break
                }
                if (range.start > cursor) {
                    append(cursor, range.start, run.kind, SpanEmphasis.None)
                    cursor = range.start
                }
                val end = minOf(range.end, runEnd)
                append(cursor, end, run.kind, emphasis)
                cursor = end
            }
            pos = runEnd
        }
        // Text the runs did not cover (defensive).
        if (pos < text.length) append(pos, text.length, SpanKind.Plain, SpanEmphasis.None)
        return spans
    }

    private fun expandTabs(text: String, width: Int): String {
        if (text.indexOf('\t') == -1) return text
        val out = StringBuilder(text.length + 8)
        var column = 0
        for (char in text) {
            if (char == '\t') {
                val pad = width - (column % width)
                repeat(pad) { out.append(' ') }
                column += pad
            } else {
                out.append(char)
                column++
            }
        }
        return out.toString()
    }

    private fun cacheKey(prefix: String, input: String, o: BuildOptions): String {
        val flags = "${o.contextLines}:${if (o.ignoreWhitespace) 1 else 0}:${o.highlighter?.let { System.identityHashCode(it) } ?: 0}:" +
            "${if (o.intraline) 1 else 0}:${o.tabWidth}:${o.maxHighlightLines}"
        val budget = o.diffBudget?.let { ":budget:${it.timeoutMs}:${it.maxEditLength}" }.orEmpty()
        return "$prefix:$flags$budget:${input.length}:${fnv1a(input)}"
    }

    /** FNV-1a over the input's UTF-16 units. */
    private fun fnv1a(input: String): String {
        var hash = 0x811c9dc5.toInt()
        for (char in input) {
            hash = hash xor char.code
            hash *= 16777619
        }
        return Integer.toUnsignedString(hash, 36)
    }
}
