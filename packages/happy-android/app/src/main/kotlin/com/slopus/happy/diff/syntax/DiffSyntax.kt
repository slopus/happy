package com.slopus.happy.diff.syntax

import com.slopus.happy.diff.DiffBuilder
import com.slopus.happy.diff.DiffFile
import com.slopus.happy.diff.DiffLineType
import com.slopus.happy.diff.DiffLruCache
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.DiffSpan
import com.slopus.happy.diff.Intraline
import com.slopus.happy.diff.SpanEmphasis
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.SyntaxRun
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext

/**
 * happy-app components/diff/syntax: colour is prepared apart from the
 * document, one contiguous hunk or code block at a time, and laid over
 * rows already on screen. Limits keep a pathological input plain instead
 * of slow.
 */
object DiffSyntax {
    const val REVEAL_MS = 1000L
    const val MAX_CHARACTERS = 128_000
    const val MAX_LINE = 2000
    const val MAX_LINES = 2000
    const val MAX_RUNS = 20_000

    /** Bounds the spans of one non-virtualized code block. */
    const val MAX_CODE_SPANS = 2000

    /** protocol.ts `SyntaxInput`: a contiguous hunk or code block (all ctx). */
    data class Input(val language: String, val lines: List<Pair<String, DiffLineType>>)

    enum class Status { Highlighted, Unsupported, Limited }

    /** protocol.ts `SyntaxResult`: runs per input line when [status] is Highlighted. */
    data class Result(val status: Status, val runs: List<List<SyntaxRun>> = emptyList())

    fun withinLimits(input: Input): Boolean {
        if (input.lines.size > MAX_LINES) return false
        var characters = 0
        for ((text) in input.lines) {
            if (text.length > MAX_LINE) return false
            characters += text.length + 1
            if (characters > MAX_CHARACTERS) return false
        }
        return true
    }

    /** tokenize.ts: each side tokenized once, runs put back on the interleaved lines; new side wins. */
    fun tokenize(input: Input, highlighter: PrismHighlighter = PrismHighlighter): Result {
        val started = System.currentTimeMillis()
        if (!withinLimits(input)) return Result(Status.Limited)
        if (!Prism.hasGrammar(input.language)) return Result(Status.Unsupported)
        val oldLines = input.lines.filter { it.second != DiffLineType.Add }.map { it.first }
        val newLines = input.lines.filter { it.second != DiffLineType.Del }.map { it.first }
        val oldRuns = if (oldLines.isNotEmpty()) highlighter.highlightLines(oldLines.joinToString("\n"), input.language) else emptyList()
        if (System.currentTimeMillis() - started >= REVEAL_MS) return Result(Status.Limited)
        // Code blocks have identical sides: tokenize once.
        val unchanged = input.lines.all { it.second == DiffLineType.Ctx }
        val newRuns = when {
            unchanged -> oldRuns
            newLines.isNotEmpty() -> highlighter.highlightLines(newLines.joinToString("\n"), input.language)
            else -> emptyList()
        }
        if (System.currentTimeMillis() - started >= REVEAL_MS) return Result(Status.Limited)
        var oldIndex = 0
        var newIndex = 0
        var runCount = 0
        val runs = input.lines.map { (_, type) ->
            val old = if (type != DiffLineType.Add) oldRuns.getOrNull(oldIndex++) else null
            val next = if (type != DiffLineType.Del) newRuns.getOrNull(newIndex++) else null
            (next ?: old ?: emptyList()).also { runCount += it.size }
        }
        return if (runCount > MAX_RUNS) Result(Status.Limited) else Result(Status.Highlighted, runs)
    }

    /** plan.ts `SyntaxHunk`. */
    data class Hunk(val input: Input, val rows: List<DiffRow.Line>)

    /**
     * planSyntax: whole hunks that intersect [displayed], so comments and
     * template strings keep their context; never hidden tails, unknown
     * languages, hunks already coloured or past the limits.
     */
    fun plan(file: DiffFile, displayed: List<DiffRow>): List<Hunk> {
        val language = file.language ?: return emptyList()
        val wanted = displayed.toIdentitySet()
        val hunks = ArrayList<Hunk>()
        var rows = ArrayList<DiffRow.Line>()
        var intersects = false
        fun flush() {
            if (intersects && rows.isNotEmpty() && rows.none { row -> row.spans.any { it.kind != SpanKind.Plain } }) {
                val input = Input(language, rows.map { it.text to it.type })
                if (withinLimits(input)) hunks.add(Hunk(input, rows))
            }
            rows = ArrayList()
            intersects = false
        }
        for (row in file.rows) {
            if (row !is DiffRow.Line) {
                flush()
                continue
            }
            rows.add(row)
            if (row in wanted) intersects = true
        }
        flush()
        return hunks
    }

    /** applySyntax: colours laid over [displayed]; text, word emphasis and untouched rows kept as they are. */
    fun apply(displayed: List<DiffRow>, plan: List<Hunk>, outcomes: Map<Input, Result>): List<DiffRow> {
        val wanted = displayed.toIdentitySet()
        val replacements = java.util.IdentityHashMap<DiffRow.Line, DiffRow.Line>()
        for (hunk in plan) {
            val result = outcomes[hunk.input]?.takeIf { it.status == Status.Highlighted } ?: continue
            hunk.rows.forEachIndexed { index, row ->
                if (row !in wanted) return@forEachIndexed
                val runs = result.runs.getOrNull(index)
                if (runs == null || runs.none { it.kind != SpanKind.Plain }) return@forEachIndexed
                val emphasis = ArrayList<Intraline.Range>()
                var offset = 0
                for (span in row.spans) {
                    if (span.emphasis != SpanEmphasis.None) emphasis.add(Intraline.Range(offset, offset + span.text.length))
                    offset += span.text.length
                }
                val value = if (row.type == DiffLineType.Add) SpanEmphasis.Inserted else SpanEmphasis.Deleted
                replacements[row] = row.copy(spans = DiffBuilder.mergeSpans(row.text, runs, emphasis, value))
            }
        }
        if (replacements.isEmpty()) return displayed
        return displayed.map { row -> (row as? DiffRow.Line)?.let { replacements[it] } ?: row }
    }

    /** code.ts planCodeSyntax: a code block as one all-context input, or null when empty, uncoloured or too big. */
    fun planCode(code: String, language: String?): Input? {
        if (language == null || code.isEmpty() || code.length > MAX_CHARACTERS) return null
        val lines = code.split('\n', limit = MAX_LINES + 1)
        if (lines.size > MAX_LINES) return null
        val input = Input(language, lines.map { it to DiffLineType.Ctx })
        return input.takeIf(::withinLimits)
    }

    /** code.ts codeSyntaxSpans: the block's spans, joined across lines; null when nothing is coloured or too many. */
    fun codeSpans(input: Input, result: Result?): List<DiffSpan>? {
        if (result?.status != Status.Highlighted) return null
        val spans = ArrayList<DiffSpan>()
        fun append(text: String, kind: SpanKind) {
            if (text.isEmpty()) return
            val last = spans.lastOrNull()
            if (last != null && last.kind == kind) spans[spans.lastIndex] = last.copy(text = last.text + text) else spans.add(DiffSpan(text, kind, SpanEmphasis.None))
        }
        input.lines.forEachIndexed { index, (text) ->
            var offset = 0
            for (run in result.runs.getOrNull(index).orEmpty()) {
                val end = minOf(text.length, offset + run.length)
                append(text.substring(minOf(offset, end), end), run.kind)
                offset += run.length
                if (spans.size > MAX_CODE_SPANS) return null
            }
            if (offset < text.length) append(text.substring(offset), SpanKind.Plain)
            if (index < input.lines.size - 1) append("\n", SpanKind.Plain)
            if (spans.size > MAX_CODE_SPANS) return null
        }
        return spans.takeIf { list -> list.any { it.kind != SpanKind.Plain } }
    }

    private fun <T> List<T>.toIdentitySet(): Set<T> = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<T, Boolean>()).also { it.addAll(this) }
}

/**
 * service.ts: one worker thread (Prism's) and an LRU of results (512 inputs, 4 MB
 * of text), so the same hunk or block is tokenized once however often it
 * is shown. [highlight] runs on [dispatcher]; callers bound how long they
 * wait with [DiffSyntax.REVEAL_MS].
 */
class SyntaxService(private val dispatcher: CoroutineDispatcher = Prism.executor.asCoroutineDispatcher()) {
    private val cache = DiffLruCache<DiffSyntax.Result>(512, 4L * 1024 * 1024)

    private fun key(input: DiffSyntax.Input) = buildString {
        append(input.language)
        for ((text, type) in input.lines) append('\u0000').append(type.wire).append(text)
    }

    fun peek(input: DiffSyntax.Input): DiffSyntax.Result? = cache.get(key(input))

    suspend fun highlight(input: DiffSyntax.Input): DiffSyntax.Result {
        val key = key(input)
        cache.get(key)?.let { return it }
        // Cached on the worker, so a caller that stopped waiting still leaves the result behind.
        return withContext(dispatcher) {
            cache.get(key) ?: DiffSyntax.tokenize(input).also { cache.set(key, it, key.length.toLong() * 2) }
        }
    }

    companion object {
        /** The app's one queue (happy-app's `diffSyntax`). */
        val Shared by lazy { SyntaxService() }
    }
}
