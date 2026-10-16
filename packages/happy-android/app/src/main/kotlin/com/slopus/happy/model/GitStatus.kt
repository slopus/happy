package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import java.io.ByteArrayOutputStream

// A checkout's working-tree status as the daemon's shell reports it:
// happy-app sync/gitStatusSync.ts parseGitStatusV2 and the parsers in
// sync/git-parsers (parseStatusV2.ts, parseDiff.ts, gitPath.ts).

/** storageTypes.ts GitStatus: one checkout, keyed by [gitStatusKey]. */
@Immutable
data class GitStatus(
    val branch: String?,
    val isDirty: Boolean,
    val modifiedCount: Int,
    val untrackedCount: Int,
    val stagedCount: Int,
    val lastUpdatedAt: Long,
    val stagedLinesAdded: Long,
    val stagedLinesRemoved: Long,
    val unstagedLinesAdded: Long,
    val unstagedLinesRemoved: Long,
    val linesAdded: Long,
    val linesRemoved: Long,
    val linesChanged: Long,
    val upstreamBranch: String? = null,
    val aheadCount: Int? = null,
    val behindCount: Int? = null,
    val stashCount: Int? = null,
)

/** storage.ts getSessionPathKey: `machineId:path`, or null without both. */
fun gitStatusKey(machineId: String?, path: String?): String? =
    if (machineId.isNullOrEmpty() || path.isNullOrEmpty()) null else "$machineId:$path"

/** The commands gitStatusSync.ts runs in the session's directory, with their timeouts. */
object GitStatusCommands {
    const val IS_REPO = "git rev-parse --is-inside-work-tree"
    const val STATUS = "git -c core.quotepath=false status --porcelain=v2 --branch --show-stash --untracked-files=all"
    const val UNSTAGED_NUMSTAT = "git -c core.quotepath=false diff --numstat"
    const val STAGED_NUMSTAT = "git -c core.quotepath=false diff --cached --numstat"
    const val IS_REPO_TIMEOUT_MS = 5_000L
    const val TIMEOUT_MS = 10_000L
}

/** gitStatusSync.ts parseGitStatusV2: the status lines plus both numstats. */
fun parseGitStatus(porcelainV2: String, unstagedNumStat: String, stagedNumStat: String, now: Long): GitStatus {
    val summary = parseStatusSummaryV2(porcelainV2)
    val unstaged = parseNumStat(unstagedNumStat)
    val staged = parseNumStat(stagedNumStat)
    val head = summary.branch.head
    val linesAdded = staged.insertions + unstaged.insertions
    val linesRemoved = staged.deletions + unstaged.deletions
    val tracking = summary.branch.upstream != null
    return GitStatus(
        branch = head?.takeIf { it != "(detached)" && it != "(initial)" },
        isDirty = summary.files.isNotEmpty() || summary.notAdded.isNotEmpty(),
        modifiedCount = summary.modified.size,
        untrackedCount = summary.notAdded.size,
        stagedCount = summary.staged.size,
        lastUpdatedAt = now,
        stagedLinesAdded = staged.insertions,
        stagedLinesRemoved = staged.deletions,
        unstagedLinesAdded = unstaged.insertions,
        unstagedLinesRemoved = unstaged.deletions,
        linesAdded = linesAdded,
        linesRemoved = linesRemoved,
        linesChanged = linesAdded + linesRemoved,
        upstreamBranch = summary.branch.upstream,
        aheadCount = if (tracking) summary.branch.ahead ?: 0 else null,
        behindCount = if (tracking) summary.branch.behind ?: 0 else null,
        stashCount = summary.stashCount,
    )
}

/** parseStatusV2.ts GitFileEntryV2: the parts of a changed-file line the counts read. */
data class GitFileEntry(val path: String, val index: Char, val workingDir: Char, val from: String? = null)

data class GitBranchInfo(
    val oid: String? = null,
    val head: String? = null,
    val upstream: String? = null,
    val ahead: Int? = null,
    val behind: Int? = null,
)

/** parseStatusV2.ts GitStatusSummaryV2; [notAdded] is untracked. */
data class GitStatusSummary(
    val files: List<GitFileEntry>,
    val staged: List<String>,
    val modified: List<String>,
    val created: List<String>,
    val deleted: List<String>,
    val renamed: List<String>,
    val conflicted: List<String>,
    val notAdded: List<String>,
    val ignored: List<String>,
    val branch: GitBranchInfo,
    val stashCount: Int?,
)

private val BRANCH_OID = Regex("^# branch\\.oid (.+)$")
private val BRANCH_HEAD = Regex("^# branch\\.head (.+)$")
private val BRANCH_UPSTREAM = Regex("^# branch\\.upstream (.+)$")
private val BRANCH_AB = Regex("^# branch\\.ab \\+(\\d+) -(\\d+)$")
private val STASH = Regex("^# stash (\\d+)$")
private val ORDINARY = Regex("^1 (.)(.) (.{4}) (\\d{6}) (\\d{6}) (\\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$")
private val RENAME_COPY = Regex("^2 (.)(.) (.{4}) (\\d{6}) (\\d{6}) (\\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\\d{1,3}) (.+)\\t(.+)$")
private val UNMERGED = Regex("^u (.)(.) (.{4}) (\\d{6}) (\\d{6}) (\\d{6}) (\\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$")
private val UNTRACKED = Regex("^\\? (.+)$")
private val IGNORED = Regex("^! (.+)$")

/** parseStatusSummaryV2: `git status --porcelain=v2 --branch --show-stash` output. */
fun parseStatusSummaryV2(output: String): GitStatusSummary {
    val files = ArrayList<GitFileEntry>()
    val staged = ArrayList<String>()
    val modified = ArrayList<String>()
    val created = ArrayList<String>()
    val deleted = ArrayList<String>()
    val renamed = ArrayList<String>()
    val conflicted = ArrayList<String>()
    val notAdded = ArrayList<String>()
    val ignored = ArrayList<String>()
    var branch = GitBranchInfo()
    var stashCount: Int? = null

    fun categorize(entry: GitFileEntry) {
        val path = entry.path
        if (entry.index != ' ' && entry.index != '.' && entry.index != '?') {
            staged.add(path)
            when (entry.index) {
                'A' -> created.add(path)
                'D' -> deleted.add(path)
                'R', 'C' -> renamed.add(path)
                'M' -> if (path !in created) modified.add(path)
                'U' -> conflicted.add(path)
            }
        }
        if (entry.workingDir != ' ' && entry.workingDir != '.') {
            when (entry.workingDir) {
                'M' -> if (path !in modified) modified.add(path)
                'D' -> if (path !in deleted) deleted.add(path)
                'R', 'C' -> if (path !in renamed) renamed.add(path)
                '?' -> notAdded.add(path)
                'U' -> if (path !in conflicted) conflicted.add(path)
            }
        }
    }

    fun add(entry: GitFileEntry) {
        files.add(entry)
        categorize(entry)
    }

    for (line in output.trim().split('\n')) {
        if (line.isEmpty()) continue
        when {
            line.startsWith("# branch.oid ") -> BRANCH_OID.find(line)?.let { branch = branch.copy(oid = it.groupValues[1]) }
            line.startsWith("# branch.head ") -> BRANCH_HEAD.find(line)?.let { branch = branch.copy(head = it.groupValues[1]) }
            line.startsWith("# branch.upstream ") -> BRANCH_UPSTREAM.find(line)?.let { branch = branch.copy(upstream = it.groupValues[1]) }
            line.startsWith("# branch.ab ") -> BRANCH_AB.find(line)?.let {
                branch = branch.copy(ahead = it.groupValues[1].toIntOrNull(), behind = it.groupValues[2].toIntOrNull())
            }
            line.startsWith("# stash ") -> STASH.find(line)?.let { stashCount = it.groupValues[1].toIntOrNull() }
            line.startsWith("1 ") -> ORDINARY.find(line)?.let { m ->
                add(GitFileEntry(decodeGitPath(m.groupValues[9]), m.groupValues[1][0], m.groupValues[2][0]))
            }
            line.startsWith("2 ") -> RENAME_COPY.find(line)?.let { m ->
                add(GitFileEntry(decodeGitPath(m.groupValues[12]), m.groupValues[1][0], m.groupValues[2][0], from = decodeGitPath(m.groupValues[11])))
            }
            line.startsWith("u ") -> UNMERGED.find(line)?.let { m ->
                add(GitFileEntry(decodeGitPath(m.groupValues[11]), m.groupValues[1][0], m.groupValues[2][0]))
            }
            line.startsWith("? ") -> UNTRACKED.find(line)?.let { notAdded.add(decodeGitPath(it.groupValues[1])) }
            line.startsWith("! ") -> IGNORED.find(line)?.let { ignored.add(decodeGitPath(it.groupValues[1])) }
        }
    }
    return GitStatusSummary(files, staged, modified, created, deleted, renamed, conflicted, notAdded, ignored, branch, stashCount)
}

/** parseDiff.ts DiffFileStat; a binary file counts 0 either way. */
data class DiffFileStat(val file: String, val insertions: Long, val deletions: Long, val binary: Boolean)

data class DiffSummary(val files: List<DiffFileStat>, val insertions: Long, val deletions: Long)

private val NUMSTAT = Regex("^(\\d+|-)\\t(\\d+|-)\\t(.*)$")

/** parseNumStat: `git diff --numstat` output. */
fun parseNumStat(output: String): DiffSummary {
    val files = ArrayList<DiffFileStat>()
    for (line in output.trim().split('\n')) {
        if (line.isEmpty()) continue
        val m = NUMSTAT.find(line) ?: continue
        val (added, removed, file) = m.destructured
        if (file.isEmpty()) continue
        val binary = added == "-" || removed == "-"
        files.add(
            DiffFileStat(
                decodeGitPath(file),
                if (binary) 0 else added.toLongOrNull() ?: 0,
                if (binary) 0 else removed.toLongOrNull() ?: 0,
                binary,
            ),
        )
    }
    return DiffSummary(files, files.sumOf { it.insertions }, files.sumOf { it.deletions })
}

/** gitPath.ts decodeGitPath: a quoted path's C escapes and octal UTF-8 bytes; anything else as is. */
fun decodeGitPath(path: String): String {
    if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
    val value = path.substring(1, path.length - 1)
    val bytes = ByteArrayOutputStream()
    val plain = StringBuilder()
    fun flushPlain() {
        if (plain.isEmpty()) return
        bytes.write(plain.toString().toByteArray(Charsets.UTF_8))
        plain.setLength(0)
    }
    var i = 0
    while (i < value.length) {
        val ch = value[i]
        if (ch != '\\') {
            plain.append(ch)
            i += 1
            continue
        }
        if (i + 1 >= value.length) {
            plain.append(ch)
            i += 1
            continue
        }
        var end = i + 1
        while (end < value.length && end < i + 4 && value[end] in '0'..'7') end++
        if (end > i + 1) {
            flushPlain()
            bytes.write(value.substring(i + 1, end).toInt(8))
            i = end
            continue
        }
        val next = value[i + 1]
        plain.append(simpleEscape(next) ?: next)
        i += 2
    }
    flushPlain()
    return bytes.toByteArray().toString(Charsets.UTF_8)
}

private fun simpleEscape(value: Char): Char? = when (value) {
    'a' -> '\u0007'
    'b' -> '\b'
    'f' -> '\u000C'
    'n' -> '\n'
    'r' -> '\r'
    't' -> '\t'
    'v' -> '\u000B'
    '"' -> '"'
    '\\' -> '\\'
    else -> null
}
