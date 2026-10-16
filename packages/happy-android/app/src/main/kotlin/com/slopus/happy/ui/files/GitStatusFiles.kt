package com.slopus.happy.ui.files

import java.io.ByteArrayOutputStream

/** gitStatusFiles.ts `GitFileStatus.status`. */
enum class GitFileStatusKind { Modified, Added, Deleted, Renamed, Untracked }

/** One changed file from `git status` (gitStatusFiles.ts `GitFileStatus`). */
data class GitFileStatus(
    val fileName: String,
    val filePath: String,
    val fullPath: String,
    val status: GitFileStatusKind,
    val isStaged: Boolean,
    val linesAdded: Int,
    val linesRemoved: Int,
    /** For renames. */
    val oldPath: String? = null,
)

/** gitStatusFiles.ts `GitStatusFiles`. */
data class GitStatusFiles(
    val stagedFiles: List<GitFileStatus>,
    val unstagedFiles: List<GitFileStatus>,
    val branch: String?,
) {
    val totalStaged get() = stagedFiles.size
    val totalUnstaged get() = unstagedFiles.size
}

/**
 * The legacy CLI sessions' git plumbing over the session shell:
 * git-parsers/parseStatusV2.ts, parseDiff.ts `parseNumStat`, gitPath.ts and
 * gitStatusFiles.ts `parseGitStatusFilesV2`, plus gitDiffCommand.ts.
 */
object GitStatusParser {
    /** `git status --porcelain=v2` for every file, untracked ones listed one by one. */
    const val STATUS_COMMAND = "git -c core.quotepath=false status --porcelain=v2 --branch --untracked-files=all"

    /** Unstaged then staged line counts, split by a marker so a file with both never double counts. */
    const val NUMSTAT_COMMAND = "git -c core.quotepath=false diff --numstat && echo \"---STAGED---\" && git -c core.quotepath=false diff --cached --numstat"

    /** Context wide enough to swallow any real file, for "show everything". */
    const val FULL_FILE_CONTEXT = 100_000

    data class Entry(val path: String, val index: Char, val workingDir: Char, val from: String? = null)

    data class Summary(val files: List<Entry>, val untracked: List<String>, val branchHead: String?)

    private val ordinary = Regex("^1 (.)(.) (.{4}) (\\d{6}) (\\d{6}) (\\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$")
    private val renameCopy = Regex("^2 (.)(.) (.{4}) (\\d{6}) (\\d{6}) (\\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\\d{1,3}) (.+)\\t(.+)$")
    private val unmerged = Regex("^u (.)(.) (.{4}) (\\d{6}) (\\d{6}) (\\d{6}) (\\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$")
    private val numstat = Regex("^(\\d+|-)\\t(\\d+|-)\\t(.*)$")

    /** parseStatusSummaryV2, the parts the file list uses. */
    fun parseStatus(output: String): Summary {
        val files = ArrayList<Entry>()
        val untracked = ArrayList<String>()
        var head: String? = null
        for (line in output.trim().split('\n')) {
            if (line.isEmpty()) continue
            when {
                line.startsWith("# branch.head ") -> head = line.removePrefix("# branch.head ").ifEmpty { null }
                line.startsWith("1 ") -> ordinary.find(line)?.let { m -> files += Entry(decodeGitPath(m.groupValues[9]), m.groupValues[1][0], m.groupValues[2][0]) }
                line.startsWith("2 ") -> renameCopy.find(line)?.let { m ->
                    files += Entry(decodeGitPath(m.groupValues[12]), m.groupValues[1][0], m.groupValues[2][0], from = decodeGitPath(m.groupValues[11]))
                }
                line.startsWith("u ") -> unmerged.find(line)?.let { m -> files += Entry(decodeGitPath(m.groupValues[11]), m.groupValues[1][0], m.groupValues[2][0]) }
                line.startsWith("? ") -> untracked += decodeGitPath(line.substring(2))
            }
        }
        return Summary(files, untracked, head)
    }

    data class NumStat(val added: Int, val removed: Int, val binary: Boolean)

    /** parseNumStat + createDiffStatsMap. */
    fun parseNumStat(output: String): Map<String, NumStat> {
        val stats = LinkedHashMap<String, NumStat>()
        for (line in output.trim().split('\n')) {
            val m = numstat.find(line) ?: continue
            val (ins, del, file) = m.destructured
            val binary = ins == "-" || del == "-"
            stats[decodeGitPath(file)] = NumStat(if (binary) 0 else ins.toInt(), if (binary) 0 else del.toInt(), binary)
        }
        return stats
    }

    /** parseGitStatusFilesV2. */
    fun parseFiles(statusOutput: String, combinedDiffOutput: String): GitStatusFiles {
        val summary = parseStatus(statusOutput)
        val parts = combinedDiffOutput.split("---STAGED---")
        val unstagedStats = parseNumStat(parts.getOrElse(0) { "" }.trim())
        val stagedStats = parseNumStat(parts.getOrElse(1) { "" }.trim())
        val staged = ArrayList<GitFileStatus>()
        val unstaged = ArrayList<GitFileStatus>()
        fun status(path: String, code: Char, isStaged: Boolean, stats: NumStat?, from: String?) = GitFileStatus(
            fileName = path.substringAfterLast('/').ifEmpty { path },
            filePath = if ('/' in path) path.substringBeforeLast('/') else "",
            fullPath = path,
            status = when (code) {
                'M' -> GitFileStatusKind.Modified
                'A' -> GitFileStatusKind.Added
                'D' -> GitFileStatusKind.Deleted
                'R', 'C' -> GitFileStatusKind.Renamed
                '?' -> GitFileStatusKind.Untracked
                else -> GitFileStatusKind.Modified
            },
            isStaged = isStaged,
            linesAdded = stats?.added ?: 0,
            linesRemoved = stats?.removed ?: 0,
            oldPath = from,
        )
        for (file in summary.files) {
            if (file.index != ' ' && file.index != '.' && file.index != '?') staged += status(file.path, file.index, true, stagedStats[file.path], file.from)
            if (file.workingDir != ' ' && file.workingDir != '.') unstaged += status(file.path, file.workingDir, false, unstagedStats[file.path], file.from)
        }
        for (path in summary.untracked) {
            // --untracked-files=all lists files; a directory entry would be a git oddity, skipped.
            if (path.endsWith('/')) continue
            unstaged += status(path, '?', false, null, null)
        }
        val branch = summary.branchHead?.takeIf { it != "(detached)" && it != "(initial)" }
        return GitStatusFiles(staged, unstaged, branch)
    }

    /** gitPath.ts `decodeGitPath`: git's C-quoted paths, octal escapes as UTF-8 bytes. */
    fun decodeGitPath(path: String): String {
        if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
        val value = path.substring(1, path.length - 1)
        val bytes = ByteArrayOutputStream()
        val plain = StringBuilder()
        fun flush() {
            if (plain.isEmpty()) return
            bytes.write(plain.toString().toByteArray(Charsets.UTF_8))
            plain.setLength(0)
        }
        var i = 0
        while (i < value.length) {
            val ch = value[i]
            if (ch != '\\' || i + 1 >= value.length) {
                plain.append(ch)
                i++
                continue
            }
            var end = i + 1
            while (end < value.length && end < i + 4 && value[end] in '0'..'7') end++
            if (end > i + 1) {
                flush()
                bytes.write(value.substring(i + 1, end).toInt(8) and 0xFF)
                i = end
                continue
            }
            val next = value[i + 1]
            plain.append(
                when (next) {
                    'a' -> '\u0007'; 'b' -> '\b'; 'f' -> '\u000C'; 'n' -> '\n'; 'r' -> '\r'; 't' -> '\t'; 'v' -> '\u000B'
                    else -> next
                },
            )
            i += 2
        }
        flush()
        return String(bytes.toByteArray(), Charsets.UTF_8)
    }

    /** gitDiffCommand.ts `quoteShellPath`: a double-quoted shell argument. */
    fun quoteShellPath(path: String) = "\"" + path.replace(Regex("([\\\\\"$`])"), "\\\\$1") + "\""

    /** gitDiffCommand.ts `buildGitDiffCommand`. */
    fun diffCommand(path: String, contextLines: Int? = null, ignoreWhitespace: Boolean = false): String {
        val flags = buildList {
            add("--no-ext-diff")
            if (contextLines != null) add("-U$contextLines")
            if (ignoreWhitespace) add("-w")
        }
        return "git -c core.quotepath=false diff HEAD ${flags.joinToString(" ")} -- ${quoteShellPath(path)}"
    }

    /** gitDiffCommand.ts `buildGitShowBase64Command`: a tracked file as it stands in HEAD. */
    fun showBase64Command(path: String) = "git -c core.quotepath=false show HEAD:${quoteShellPath(path)} | base64"
}

/** imageFiles.ts: formats worth showing as a picture; SVG is text and diffs as text. */
object ImageFiles {
    private val mimeTypes = mapOf(
        "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
        "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp",
    )

    fun mimeType(path: String): String? {
        val dot = path.lastIndexOf('.')
        if (dot == -1) return null
        return mimeTypes[path.substring(dot + 1).lowercase()]
    }

    fun isImage(path: String) = mimeType(path) != null

    /** Already-base64 content as a `data:` URI; shell output's line breaks dropped. */
    fun dataUri(path: String, base64: String): String? {
        val mime = mimeType(path) ?: return null
        val clean = base64.replace(Regex("\\s+"), "")
        if (clean.isEmpty()) return null
        return "data:$mime;base64,$clean"
    }
}

/** sessionFileLinks.ts `SessionFileLink`. */
data class SessionFileLink(
    val path: String,
    val absolutePath: String,
    val relativePath: String?,
    val withinSessionRoot: Boolean,
    val line: Int?,
    val column: Int?,
)

/** sessionFileLinks.ts `resolveSessionFilePath`: a path, maybe `:line[:column]`, against the session's root. */
object SessionFilePaths {
    private val windowsAbsolute = Regex("^[A-Za-z]:[\\\\/]")
    private val fileUrl = Regex("^file://", RegexOption.IGNORE_CASE)

    fun resolve(path: String, sessionRoot: String?): SessionFileLink? {
        val trimmed = path.trim()
        var line: Int? = null
        var column: Int? = null
        var bare = trimmed
        Regex("^(.*):(\\d+):(\\d+)$").find(trimmed)?.let { m ->
            bare = m.groupValues[1]; line = m.groupValues[2].toIntOrNull(); column = m.groupValues[3].toIntOrNull()
        } ?: Regex("^(.*):(\\d+)$").find(trimmed)?.let { m ->
            bare = m.groupValues[1]; line = m.groupValues[2].toIntOrNull()
        }
        val absolute = resolvePath(bare, sessionRoot) ?: return null
        return SessionFileLink(normalize(bare), absolute, relativePath(absolute, sessionRoot), isWithinRoot(absolute, sessionRoot), line, column)
    }

    private fun decodeFileUrl(value: String): String {
        if (!fileUrl.containsMatchIn(value)) return value
        val stripped = value.replace(fileUrl, "")
        val normalized = if (stripped.startsWith("/")) stripped else "/$stripped"
        return runCatching { java.net.URLDecoder.decode(normalized.replace("+", "%2B"), "UTF-8") }.getOrDefault(normalized)
    }

    private fun home(root: String?): String? {
        root ?: return null
        return Regex("^([A-Za-z]:/Users/[^/]+|/Users/[^/]+|/home/[^/]+)").find(normalize(root))?.groupValues?.get(1)
    }

    private fun expandHome(value: String, root: String?): String {
        if (!value.startsWith("~/")) return value
        val home = home(root) ?: return value
        return "$home/${value.substring(2)}"
    }

    fun normalize(value: String): String {
        val slashes = value.replace('\\', '/')
        val windows = Regex("^[A-Za-z]:/").containsMatchIn(slashes)
        val posix = slashes.startsWith("/")
        val prefix = if (windows) slashes.substring(0, 2) + "/" else if (posix) "/" else ""
        val remainder = if (windows) slashes.substring(3) else if (posix) slashes.trimStart('/') else slashes
        val parts = ArrayList<String>()
        for (part in remainder.split('/')) {
            if (part.isEmpty() || part == ".") continue
            if (part == "..") {
                if (parts.isNotEmpty() && parts.last() != "..") parts.removeAt(parts.lastIndex)
                else if (prefix.isEmpty()) parts += part
                continue
            }
            parts += part
        }
        if (prefix.isEmpty()) return parts.joinToString("/")
        if (parts.isEmpty()) return prefix
        return prefix + parts.joinToString("/")
    }

    private fun resolvePath(path: String, root: String?): String? {
        val expanded = expandHome(decodeFileUrl(path), root)
        if (expanded.isEmpty()) return null
        if (windowsAbsolute.containsMatchIn(expanded) || expanded.startsWith("/")) return normalize(expanded)
        root ?: return null
        return normalize("${normalize(root)}/$expanded")
    }

    private fun isWithinRoot(path: String, root: String?): Boolean {
        root ?: return false
        val p = normalize(path)
        val r = normalize(root)
        return p == r || p.startsWith("$r/")
    }

    private fun relativePath(path: String, root: String?): String? {
        if (root == null || !isWithinRoot(path, root)) return null
        val p = normalize(path)
        val r = normalize(root)
        return if (p == r) "." else p.substring(r.length + 1)
    }
}
