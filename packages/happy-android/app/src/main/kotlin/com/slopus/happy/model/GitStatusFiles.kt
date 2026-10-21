package com.slopus.happy.model

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
 * gitStatusFiles.ts `parseGitStatusFilesV2` over model/GitStatus.kt's
 * parsers, plus gitDiffCommand.ts.
 */
object GitStatusParser {
    /** `git status --porcelain=v2` for every file, untracked ones listed one by one. */
    const val STATUS_COMMAND = "git -c core.quotepath=false status --porcelain=v2 --branch --untracked-files=all"

    /** Unstaged then staged line counts, split by a marker so a file with both never double counts. */
    const val NUMSTAT_COMMAND = "git -c core.quotepath=false diff --numstat && echo \"---STAGED---\" && git -c core.quotepath=false diff --cached --numstat"

    /** Context wide enough to swallow any real file, for "show everything". */
    const val FULL_FILE_CONTEXT = 100_000

    /** parseGitStatusFilesV2. */
    fun parseFiles(statusOutput: String, combinedDiffOutput: String): GitStatusFiles {
        val summary = parseStatusSummaryV2(statusOutput)
        val parts = combinedDiffOutput.split("---STAGED---")
        val unstagedStats = parseNumStat(parts.getOrElse(0) { "" }).files.associateBy { it.file }
        val stagedStats = parseNumStat(parts.getOrElse(1) { "" }).files.associateBy { it.file }
        val staged = ArrayList<GitFileStatus>()
        val unstaged = ArrayList<GitFileStatus>()
        fun status(path: String, code: Char, isStaged: Boolean, stats: DiffFileStat?, from: String?) = GitFileStatus(
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
            linesAdded = stats?.insertions?.toInt() ?: 0,
            linesRemoved = stats?.deletions?.toInt() ?: 0,
            oldPath = from,
        )
        for (file in summary.files) {
            if (file.index != ' ' && file.index != '.' && file.index != '?') staged += status(file.path, file.index, true, stagedStats[file.path], file.from)
            if (file.workingDir != ' ' && file.workingDir != '.') unstaged += status(file.path, file.workingDir, false, unstagedStats[file.path], file.from)
        }
        for (path in summary.notAdded) {
            // --untracked-files=all lists files; a directory entry would be a git oddity, skipped.
            if (path.endsWith('/')) continue
            unstaged += status(path, '?', false, null, null)
        }
        val branch = summary.branch.head?.takeIf { it != "(detached)" && it != "(initial)" }
        return GitStatusFiles(staged, unstaged, branch)
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
