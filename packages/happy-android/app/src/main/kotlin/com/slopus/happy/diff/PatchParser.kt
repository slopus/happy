package com.slopus.happy.diff

/*
 * happy-app engine/parsePatch.ts: a tolerant unified-diff parser. Agent
 * tools, `git diff` and hand-written patches all come through here, and a
 * malformed header degrades to "render what we can" rather than failing.
 * The output is the raw shape; colouring and word diffs come later.
 */

data class RawLine(val type: DiffLineType, val text: String, val oldNo: Int? = null, val newNo: Int? = null)

data class RawHunk(
    val oldStart: Int,
    val oldLines: Int,
    val newStart: Int,
    val newLines: Int,
    /** What follows the closing `@@`, usually the enclosing function. */
    val section: String,
    val lines: List<RawLine>,
)

data class RawFile(val path: String, val oldPath: String?, val kind: FileChangeKind, val hunks: List<RawHunk>)

/** An optional contents-diff budget ran out. */
class DiffBudgetExceededException : RuntimeException("Diff budget exceeded")

object PatchParser {
    private class MutableHunk(val oldStart: Int, val oldLines: Int, val newStart: Int, val newLines: Int, val section: String) {
        val lines = ArrayList<RawLine>()
    }

    private class MutableFile(var path: String, var oldPath: String?, var kind: FileChangeKind) {
        val hunks = ArrayList<MutableHunk>()

        fun build() = RawFile(path, oldPath, kind, hunks.map { RawHunk(it.oldStart, it.oldLines, it.newStart, it.newLines, it.section, it.lines.toList()) })
    }

    /** parsePatch. */
    fun parse(patch: String): List<RawFile> {
        val lines = patch.split('\n').toMutableList()
        // The newline ending the last line is a terminator, not a line.
        if (lines.size > 1 && lines.last().isEmpty()) lines.removeAt(lines.lastIndex)
        val files = ArrayList<RawFile>()

        var file: MutableFile? = null
        var hunk: MutableHunk? = null
        var oldNo = 0
        var newNo = 0
        // `---`/`+++` pairs give the real paths; the `diff --git` line is
        // unreliable when paths contain spaces.
        var sawOldHeader = false

        fun pushFile() {
            file?.let { files.add(it.build()) }
            file = null
            hunk = null
        }

        fun ensureFile(path: String): MutableFile = file ?: MutableFile(path, null, FileChangeKind.Modified).also { file = it }

        for (line in lines) {
            if (line.startsWith("diff --git ") || line.startsWith("diff -")) {
                pushFile()
                sawOldHeader = false
                // Best effort from the header; ---/+++ refine it.
                gitHeaderPaths(line)?.let { (old, new) -> file = MutableFile(cleanPath(new), cleanPath(old), FileChangeKind.Modified) }
                continue
            }
            if (line.startsWith("new file mode")) {
                file?.kind = FileChangeKind.Added
                continue
            }
            if (line.startsWith("deleted file mode")) {
                file?.kind = FileChangeKind.Deleted
                continue
            }
            if (line.startsWith("rename from ")) {
                file?.let {
                    it.oldPath = cleanPath(line.substring("rename from ".length))
                    it.kind = FileChangeKind.Renamed
                }
                continue
            }
            if (line.startsWith("rename to ")) {
                val path = cleanPath(line.substring("rename to ".length))
                val current = file
                if (current != null) {
                    current.path = path
                    current.kind = FileChangeKind.Renamed
                } else {
                    file = MutableFile(path, null, FileChangeKind.Renamed)
                }
                continue
            }
            if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
                file?.kind = FileChangeKind.Binary
                continue
            }
            if (line.startsWith("index ") || line.startsWith("similarity index") || line.startsWith("old mode") || line.startsWith("new mode")) {
                continue
            }

            if (line.startsWith("--- ")) {
                val path = line.substring(4)
                sawOldHeader = true
                val current = file
                if (JsText.trim(path) == "/dev/null") {
                    if (current != null) current.kind = FileChangeKind.Added else file = MutableFile("", null, FileChangeKind.Added)
                } else if (current != null) {
                    current.oldPath = cleanPath(path)
                } else {
                    file = MutableFile(cleanPath(path), cleanPath(path), FileChangeKind.Modified)
                }
                continue
            }

            if (line.startsWith("+++ ")) {
                val path = line.substring(4)
                if (JsText.trim(path) == "/dev/null") {
                    val f = ensureFile(file?.oldPath ?: "")
                    f.kind = FileChangeKind.Deleted
                    val old = f.oldPath
                    if (f.path.isEmpty() && !old.isNullOrEmpty()) f.path = old
                } else {
                    val cleaned = cleanPath(path)
                    val f = ensureFile(cleaned)
                    // A `+++` right after `---` always names the current file.
                    if (sawOldHeader || f.path.isEmpty()) f.path = cleaned
                }
                sawOldHeader = false
                continue
            }

            val header = hunkHeader(line)
            if (header != null) {
                val f = ensureFile("")
                hunk = header.also { f.hunks.add(it) }
                oldNo = header.oldStart
                newNo = header.newStart
                continue
            }

            val current = hunk ?: continue

            // `\ No newline at end of file` is metadata, not content.
            if (line.startsWith("\\")) continue

            val text = if (line.isEmpty()) "" else line.substring(1)
            when {
                line.startsWith("+") -> current.lines.add(RawLine(DiffLineType.Add, text, newNo = newNo++))
                line.startsWith("-") -> current.lines.add(RawLine(DiffLineType.Del, text, oldNo = oldNo++))
                line.startsWith(" ") || line.isEmpty() -> current.lines.add(RawLine(DiffLineType.Ctx, text, oldNo = oldNo++, newNo = newNo++))
            }
            // Anything else (junk between files) is ignored.
        }

        pushFile()
        return files.filter { it.path.isNotEmpty() || it.hunks.isNotEmpty() }
    }

    /** `/^diff --git (.+) (.+)$/`: split at the last space that leaves both sides non-empty. */
    private fun gitHeaderPaths(line: String): Pair<String, String>? {
        if (!line.startsWith("diff --git ")) return null
        val rest = line.substring("diff --git ".length)
        if (rest.any(JsText::isLineTerminator) || rest.length < 3) return null
        var split = rest.length - 2
        while (split >= 1 && rest[split] != ' ') split--
        if (split < 1) return null
        return rest.substring(0, split) to rest.substring(split + 1)
    }

    /**
     * `/^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/` by hand: the
     * section's `.` stops at line terminators and `$` only matches at the
     * very end, as in JavaScript (Java's `$` also matches before a final `\r`).
     */
    private fun hunkHeader(line: String): MutableHunk? {
        var index = 0
        fun atSigns(): Boolean {
            val start = index
            while (index < line.length && line[index] == '@') index++
            return index - start >= 2
        }
        fun literal(text: String): Boolean {
            if (!line.startsWith(text, index)) return false
            index += text.length
            return true
        }
        fun number(): Int? {
            val start = index
            while (index < line.length && line[index] in '0'..'9') index++
            if (index == start) return null
            return line.substring(start, index).toIntOrNull() ?: Int.MAX_VALUE
        }
        // null: no count; -1: a comma without digits, which fails the match.
        fun optionalCount(): Int? {
            if (index >= line.length || line[index] != ',') return null
            index++
            return number() ?: -1
        }

        if (!atSigns() || !literal(" -")) return null
        val oldStart = number() ?: return null
        val oldLines = optionalCount()
        if (oldLines == -1 || !literal(" +")) return null
        val newStart = number() ?: return null
        val newLines = optionalCount()
        if (newLines == -1 || !literal(" ") || !atSigns()) return null
        if (index < line.length && line[index] == ' ') index++
        val section = line.substring(index)
        if (section.any(JsText::isLineTerminator)) return null
        return MutableHunk(oldStart, oldLines ?: 1, newStart, newLines ?: 1, section)
    }

    /** Strips git's `a/` and `b/`, unquotes `core.quotepath` output, drops the timestamp `diff -u` puts after a tab. */
    internal fun cleanPath(raw: String): String {
        var path = JsText.trim(raw)
        if (path.startsWith('"') && path.endsWith('"') && path.length > 1) {
            path = JsText.parseJsonString(path) ?: path.substring(1, path.length - 1)
        }
        val tab = path.indexOf('\t')
        if (tab != -1) path = path.substring(0, tab)
        if (path.startsWith("a/") || path.startsWith("b/")) path = path.substring(2)
        return path
    }

    /** rawFileFromContents: a single-file patch built from two whole files. */
    fun rawFileFromContents(
        path: String,
        oldText: String,
        newText: String,
        contextLines: Int,
        ignoreWhitespace: Boolean = false,
        budget: MyersDiff.Budget? = null,
    ): RawFile = RawFile(path, null, contentsKind(oldText, newText), hunksFromContents(oldText, newText, contextLines, ignoreWhitespace, budget))

    internal fun contentsKind(oldText: String, newText: String) = when {
        oldText.isEmpty() && newText.isNotEmpty() -> FileChangeKind.Added
        newText.isEmpty() && oldText.isNotEmpty() -> FileChangeKind.Deleted
        else -> FileChangeKind.Modified
    }

    /**
     * hunksFromContents: the Myers line diff of two blobs, folded into hunks
     * with [contextLines] of context. Throws [DiffBudgetExceededException]
     * when [budget] runs out.
     */
    fun hunksFromContents(
        oldText: String,
        newText: String,
        contextLines: Int,
        ignoreWhitespace: Boolean = false,
        budget: MyersDiff.Budget? = null,
    ): List<RawHunk> {
        val all = ArrayList<RawLine>()
        var oldNo = 1
        var newNo = 1
        val oldLines = JsText.lines(oldText, dropTrailingEmpty = true)
        val newLines = JsText.lines(newText, dropTrailingEmpty = true)

        // A one-sided file needs no edit search, and must not spend a
        // two-sided budget on rows that are trivial to build.
        if (oldLines.isEmpty() || newLines.isEmpty()) {
            for (text in oldLines) all.add(RawLine(DiffLineType.Del, text, oldNo = oldNo++))
            for (text in newLines) all.add(RawLine(DiffLineType.Add, text, newNo = newNo++))
            return foldHunks(all, contextLines)
        }

        data class Values(val lines: List<String>, val added: Boolean, val removed: Boolean)
        val changes = if (ignoreWhitespace) {
            // Compare without whitespace, but keep each original line so the
            // renderer never shows a normalized copy.
            val result = MyersDiff.diffArrays(oldLines, newLines, JsText::stripWhitespace, budget ?: MyersDiff.Budget.Unlimited)
                ?: throw DiffBudgetExceededException()
            result.map { Values(it.value, it.added, it.removed) }
        } else {
            val result = MyersDiff.diffLines(oldText, newText, budget ?: MyersDiff.Budget.Unlimited) ?: throw DiffBudgetExceededException()
            result.map { Values(JsText.lines(it.value, dropTrailingEmpty = true), it.added, it.removed) }
        }

        for (change in changes) {
            for (text in change.lines) {
                when {
                    change.added -> all.add(RawLine(DiffLineType.Add, text, newNo = newNo++))
                    change.removed -> all.add(RawLine(DiffLineType.Del, text, oldNo = oldNo++))
                    else -> all.add(RawLine(DiffLineType.Ctx, text, oldNo = oldNo++, newNo = newNo++))
                }
            }
        }
        return foldHunks(all, contextLines)
    }

    /** foldHunks: groups a whole file's lines into hunks, dropping unchanged runs longer than twice the context. */
    fun foldHunks(all: List<RawLine>, contextLines: Int): List<RawHunk> {
        if (all.none { it.type != DiffLineType.Ctx }) return emptyList()

        val keep = BooleanArray(all.size)
        var lastFilled = -1
        for (i in all.indices) {
            if (all[i].type == DiffLineType.Ctx) continue
            val from = maxOf(0, i - contextLines)
            val to = minOf(all.size - 1, i + contextLines)
            if (from > to) continue
            for (j in maxOf(from, lastFilled + 1)..to) keep[j] = true
            if (to > lastFilled) lastFilled = to
        }

        val hunks = ArrayList<RawHunk>()
        var i = 0
        while (i < all.size) {
            if (!keep[i]) {
                i++
                continue
            }
            var j = i
            while (j < all.size && keep[j]) j++
            val slice = all.subList(i, j).toList()
            val first = slice[0]
            val oldStart = first.oldNo ?: slice.firstOrNull { it.oldNo != null }?.oldNo ?: 0
            val newStart = first.newNo ?: slice.firstOrNull { it.newNo != null }?.newNo ?: 0
            hunks.add(
                RawHunk(
                    oldStart = oldStart,
                    oldLines = slice.count { it.type != DiffLineType.Add },
                    newStart = newStart,
                    newLines = slice.count { it.type != DiffLineType.Del },
                    section = "",
                    lines = slice,
                ),
            )
            i = j
        }
        return hunks
    }
}
