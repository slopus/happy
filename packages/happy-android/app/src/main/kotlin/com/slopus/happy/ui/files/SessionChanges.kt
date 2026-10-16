package com.slopus.happy.ui.files

import com.slopus.happy.diff.DiffBudget
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.DiffStats
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.model.GitFileStatus
import com.slopus.happy.model.GitFileStatusKind
import com.slopus.happy.model.GitStatusFiles
import com.slopus.happy.model.GitStatusParser
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.BashResult
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import com.slopus.happy.sync.GitState
import com.slopus.happy.sync.ReadFileResult
import com.slopus.happy.sync.SessionFileCache
import com.slopus.happy.ui.diff.DiffFileItem
import com.slopus.happy.ui.diff.DiffImages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.Base64

/** What the changes and file screens ask of the session's machine. */
interface SessionFileOps {
    suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long): BashResult
    suspend fun readFile(sessionId: String, path: String): ReadFileResult
    suspend fun gitState(sessionId: String): GitState
    suspend fun readGitFile(sessionId: String, base: String, file: GitFile): GitFileContent
}

/** Sync's session ops and Happy Agent git. */
class SyncSessionFileOps(private val account: AccountSync) : SessionFileOps {
    override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long) = account.sessionOps.bash(sessionId, command, cwd, timeoutMs)
    override suspend fun readFile(sessionId: String, path: String) = account.sessionOps.readFile(sessionId, path)
    override suspend fun gitState(sessionId: String) = account.git.state(sessionId)
    override suspend fun readGitFile(sessionId: String, base: String, file: GitFile) = account.git.readFile(sessionId, base, file)
}

/**
 * gitStatusFiles.ts `getGitStatusFiles`: `git status` and the line counts
 * over the session shell in [path]. Null when it isn't a repository or
 * git failed.
 */
suspend fun SessionFileOps.gitStatusFiles(sessionId: String, path: String): GitStatusFiles? {
    val status = bash(sessionId, GitStatusParser.STATUS_COMMAND, path, 10_000)
    if (!status.success || status.exitCode != 0) return null
    val numstat = bash(sessionId, GitStatusParser.NUMSTAT_COMMAND, path, 10_000)
    return GitStatusParser.parseFiles(status.stdout, if (numstat.success) numstat.stdout else "")
}

/** Lines in a blob, not counting the terminator after the last one (AllFilesDiffView `countLines`). */
internal fun countLines(text: String): Int {
    if (text.isEmpty()) return 0
    val parts = text.split('\n').size
    return if (text.endsWith('\n')) parts - 1 else parts
}

/** Strict base64 to UTF-8 (TextDecoder's replacement on bad bytes); null when it isn't base64. */
internal fun decodeBase64Text(content: String): String? = try {
    String(Base64.getMimeDecoder().decode(content), Charsets.UTF_8)
} catch (_: IllegalArgumentException) {
    null
}

/**
 * AllFilesDiffView's legacy viewer for CLI sessions: the uncommitted files
 * from `git status`, every one's diff fetched over the shell (`git diff
 * HEAD`; untracked files read whole; images as both sides). A file whose
 * status, staging, counts, context or whitespace setting changed is fetched
 * again; others keep their diff so the list never jumps. The checkout's
 * last file list, from [cache] under [pathKey], shows at once
 * (useGitStatusFiles' stale-while-revalidate) and every answer replaces it.
 */
class LegacyChanges(
    private val scope: CoroutineScope,
    private val ops: SessionFileOps,
    private val sessionId: String,
    private val sessionPath: String?,
    private val cache: SessionFileCache? = null,
    private val pathKey: String? = null,
) {
    data class Result(val file: GitFileStatus, val content: Content?, val error: String?)

    sealed interface Content {
        data class Patch(val patch: String) : Content
        data class NewFile(val contents: String) : Content
        data class Image(val before: String?, val after: String?) : Content
    }

    data class State(
        /** Null until `git status` first answers. */
        val files: List<GitFileStatus>? = null,
        val results: Map<String, Result> = emptyMap(),
        val loadedOnce: Boolean = false,
        val expanded: Set<String> = emptySet(),
        val ignoreWhitespace: Boolean = false,
    ) {
        /** The first-load spinner: files known, no diff back yet. */
        val loading get() = !loadedOnce && results.isEmpty() && !files.isNullOrEmpty()

        /** AllFilesDiffView `diffItems`: git's counts until the content arrives, then the content's own. */
        val items: List<DiffFileItem> get() = files.orEmpty().map { file ->
            val result = results[file.fullPath]
            val content = result?.content
            val stats = when (content) {
                null, is Content.Image -> DiffStats.Counts(file.linesAdded, file.linesRemoved)
                is Content.Patch -> DiffStats.countPatch(content.patch)
                is Content.NewFile -> DiffStats.Counts(countLines(content.contents), 0)
            }
            DiffFileItem(
                path = file.fullPath,
                kind = when (file.status) {
                    GitFileStatusKind.Untracked -> FileChangeKind.Added
                    GitFileStatusKind.Deleted -> FileChangeKind.Deleted
                    else -> FileChangeKind.Modified
                },
                additions = stats.additions,
                deletions = stats.deletions,
                error = result?.error,
                image = (content as? Content.Image)?.let { DiffImages(it.before, it.after) },
                source = when (content) {
                    is Content.Patch -> DiffSource.Patch(content.patch)
                    is Content.NewFile -> DiffSource.Contents(file.fullPath, "", content.contents)
                    else -> null
                },
            )
        }
    }

    private val mutable = MutableStateFlow(State(files = pathKey?.let { cache?.statusFiles(it) }?.let { flatten(it.files) }))
    val state: StateFlow<State> = mutable.asStateFlow()

    private val fetched = HashMap<String, String>()
    private val inFlight = HashSet<String>()
    private var statusJob: Job? = null

    /** useGitStatusFiles: `git status` again (on open and on every return to the screen). */
    fun refresh() {
        if (statusJob?.isActive == true) return
        val path = sessionPath ?: return
        // A cached list fetches its diffs while git status runs.
        reconcile()
        statusJob = scope.launch {
            val status = runCatching { ops.gitStatusFiles(sessionId, path) }.getOrElse { if (it is CancellationException) throw it else null }
            if (pathKey != null) cache?.putStatusFiles(pathKey, status)
            val files = flatten(status)
            mutable.update { it.copy(files = files) }
            reconcile()
        }
    }

    /** A tapped "N unchanged lines": the whole file as context. */
    fun expandContext(path: String) {
        if (path in mutable.value.expanded) return
        mutable.update { it.copy(expanded = it.expanded + path) }
        reconcile()
    }

    fun setIgnoreWhitespace(value: Boolean) {
        if (value == mutable.value.ignoreWhitespace) return
        mutable.update { it.copy(ignoreWhitespace = value) }
        reconcile()
    }

    /** Staged and unstaged together, once per path, sorted. */
    private fun flatten(status: GitStatusFiles?): List<GitFileStatus> {
        if (status == null) return emptyList()
        val seen = LinkedHashMap<String, GitFileStatus>()
        for (file in status.stagedFiles + status.unstagedFiles) seen.putIfAbsent(file.fullPath, file)
        return seen.values.sortedWith { a, b -> java.text.Collator.getInstance().compare(a.fullPath, b.fullPath) }
    }

    private fun signature(file: GitFileStatus, state: State) =
        "${file.status}|${if (file.isStaged) 1 else 0}|${file.linesAdded}|${file.linesRemoved}" +
            "|${if (file.fullPath in state.expanded) "full" else "near"}|${if (state.ignoreWhitespace) "w" else ""}"

    private fun reconcile() {
        val state = mutable.value
        val files = state.files ?: return
        if (files.isEmpty()) {
            fetched.clear()
            inFlight.clear()
            mutable.update { it.copy(results = emptyMap(), loadedOnce = true) }
            return
        }
        val keys = files.map { it.fullPath }.toSet()
        fetched.keys.retainAll(keys)
        inFlight.retainAll(keys)
        mutable.update { it.copy(results = it.results.filterKeys(keys::contains)) }
        val toFetch = files.filter { it.fullPath !in inFlight && fetched[it.fullPath] != signature(it, state) }
        if (toFetch.isEmpty()) {
            if (!state.loadedOnce) mutable.update { it.copy(loadedOnce = true) }
            return
        }
        for (file in toFetch) {
            inFlight += file.fullPath
            fetched[file.fullPath] = signature(file, state)
        }
        scope.launch {
            val results = toFetch.map { file -> async { fetch(file, state) } }.awaitAll()
            mutable.update { current ->
                current.copy(results = current.results + results.filter { it.file.fullPath in keys }.associateBy { it.file.fullPath }, loadedOnce = true)
            }
            for (result in results) inFlight -= result.file.fullPath
        }
    }

    private suspend fun fetch(file: GitFileStatus, state: State): Result {
        val root = sessionPath ?: return Result(file, null, "No session path")
        val resolved = SessionFilePaths.resolve(file.fullPath, root)
        val relative = resolved?.takeIf { it.withinSessionRoot }?.relativePath
            ?: return Result(file, null, "File is outside the session root.")
        return try {
            when {
                // Images diff as pictures: both sides, not a patch git can't produce.
                ImageFiles.isImage(file.fullPath) -> coroutineScopeImages(file, relative, resolved.absolutePath, root)
                file.status == GitFileStatusKind.Untracked -> {
                    val read = ops.readFile(sessionId, resolved.absolutePath)
                    val content = read.content
                    if (!read.success || content.isNullOrEmpty()) return Result(file, null, read.error ?: "Failed to read file")
                    val text = decodeBase64Text(content) ?: return Result(file, null, "Failed to decode file")
                    Result(file, Content.NewFile(text), null)
                }
                else -> {
                    val command = GitStatusParser.diffCommand(
                        relative,
                        contextLines = if (file.fullPath in state.expanded) GitStatusParser.FULL_FILE_CONTEXT else null,
                        ignoreWhitespace = state.ignoreWhitespace,
                    )
                    val res = ops.bash(sessionId, command, root, 5_000)
                    if (!res.success) Result(file, null, res.error ?: "Failed to fetch diff") else Result(file, Content.Patch(res.stdout), null)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result(file, null, e.message ?: "Failed to fetch diff")
        }
    }

    private suspend fun coroutineScopeImages(file: GitFileStatus, relative: String, absolute: String, root: String): Result =
        kotlinx.coroutines.coroutineScope {
            val head = async {
                if (file.status == GitFileStatusKind.Untracked) null
                else runCatching { ops.bash(sessionId, GitStatusParser.showBase64Command(relative), root, 8_000) }.getOrNull()
                    ?.takeIf { it.success }?.stdout
            }
            val working = async {
                if (file.status == GitFileStatusKind.Deleted) null
                else runCatching { ops.readFile(sessionId, absolute) }.getOrNull()?.takeIf { it.success }?.content
            }
            val before = head.await()?.let { ImageFiles.dataUri(file.fullPath, it) }
            val after = working.await()?.let { ImageFiles.dataUri(file.fullPath, it) }
            Result(file, Content.Image(before, after), null)
        }
}

/**
 * HappyAgentDiffView: a Happy Agent session's workspace against its
 * comparison base. One snapshot at a time ([refresh] reads a fresh one);
 * a file's two sides are read only when it is expanded, at most two
 * files at once.
 */
class AgentChanges(
    private val scope: CoroutineScope,
    private val ops: SessionFileOps,
    private val sessionId: String,
    val supported: Boolean,
) {
    sealed interface Load {
        data object Loading : Load
        data class Error(val message: String) : Load
        data class Ready(val git: GitState, val revision: Int) : Load
    }

    data class FileResult(val content: GitFileContent?, val error: String?)

    data class State(
        val load: Load = Load.Loading,
        val results: Map<String, FileResult> = emptyMap(),
        val expandedContext: Set<String> = emptySet(),
        val ignoreWhitespace: Boolean = false,
    ) {
        val fileCount: Int? get() = (load as? Load.Ready)?.git?.takeIf { it.comparison == "ready" }?.changedFiles?.toInt()

        /** HappyAgentDiffFiles `items`; [fileEmpty] is files.fileEmpty. */
        fun items(fileEmpty: String): List<DiffFileItem> {
            val git = (load as? Load.Ready)?.git ?: return emptyList()
            return git.files.map { file ->
                val result = results[file.path]
                val content = result?.content
                DiffFileItem(
                    path = file.path,
                    kind = when (file.status) {
                        "added", "untracked", "copied" -> FileChangeKind.Added
                        "deleted" -> FileChangeKind.Deleted
                        "renamed" -> FileChangeKind.Renamed
                        else -> FileChangeKind.Modified
                    },
                    additions = (file.insertions ?: 0).toInt(),
                    deletions = (file.deletions ?: 0).toInt(),
                    error = result?.error,
                    image = (content as? GitFileContent.Image)?.let { DiffImages(it.before, it.after) },
                    message = when {
                        content is GitFileContent.Message -> content.message
                        content is GitFileContent.Text && content.oldText == content.newText ->
                            if (content.newText.isEmpty()) fileEmpty else "File contents match the comparison base."
                        else -> null
                    },
                    source = (content as? GitFileContent.Text)?.let {
                        DiffSource.Contents(
                            file.path, it.oldText, it.newText,
                            contextLines = if (file.path in expandedContext) GitStatusParser.FULL_FILE_CONTEXT else null,
                            ignoreWhitespace = ignoreWhitespace,
                            diffBudget = NATIVE_DIFF_BUDGET,
                        )
                    },
                )
            }
        }

        /** The notices above the list: truncated, approximate, conflicted. */
        val notices: List<String> get() {
            val git = (load as? Load.Ready)?.git ?: return emptyList()
            return buildList {
                if (git.filesTruncated) add("Showing ${git.files.size} of ${git.changedFiles} changed files. Open the workspace on your computer to see the full list.")
                if (!git.countsExact) add("Change counts are approximate for this workspace.")
                if (git.conflicted) add("This workspace has unresolved merge conflicts.")
            }
        }

        val clean: Boolean get() {
            val git = (load as? Load.Ready)?.git ?: return false
            return git.changedFiles == 0L && git.countsExact && !git.filesTruncated && !git.conflicted
        }
    }

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    private var revision = 0
    private var job: Job? = null
    private val requested = LinkedHashSet<String>()
    private val inFlight = HashSet<String>()

    /** A fresh snapshot: on open, on return to the screen and on reload. */
    fun refresh() {
        if (!supported) return
        job?.cancel()
        val request = ++revision
        requested.clear()
        inFlight.clear()
        mutable.update { it.copy(load = Load.Loading, results = emptyMap(), expandedContext = emptySet()) }
        job = scope.launch {
            val load = try {
                Load.Ready(ops.gitState(sessionId), request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Load.Error(e.message ?: "Could not load changes from Happy Agent.")
            }
            if (request == revision) mutable.update { it.copy(load = load) }
        }
    }

    /** DiffFilesList asks for an expanded file's sides. */
    fun requestContent(path: String) {
        val ready = mutable.value.load as? Load.Ready ?: return
        if (ready.git.files.none { it.path == path }) return
        requested += path
        pump(ready)
    }

    fun expandContext(path: String) = mutable.update { it.copy(expandedContext = it.expandedContext + path) }

    fun setIgnoreWhitespace(value: Boolean) = mutable.update { it.copy(ignoreWhitespace = value) }

    private fun pump(ready: Load.Ready) {
        val base = ready.git.base ?: return
        for (path in requested.toList()) {
            // Each file reads at most two sides, so at most four RPCs are live.
            if (inFlight.size >= 2) break
            if (path in mutable.value.results || path in inFlight) continue
            val file = ready.git.files.firstOrNull { it.path == path } ?: continue
            inFlight += path
            scope.launch {
                val result = try {
                    FileResult(ops.readGitFile(sessionId, base, file), null)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    FileResult(null, e.message ?: "Could not load this file. Reload changes to try again.")
                }
                if (ready.revision != revision) return@launch
                inFlight -= path
                mutable.update { it.copy(results = it.results + (path to result)) }
                pump(ready)
            }
        }
    }

    companion object {
        /** The phone runs the line diff itself; the edit length bounds its cost, the timeout backs it up. */
        val NATIVE_DIFF_BUDGET = DiffBudget(timeoutMs = 200, maxEditLength = 2000)
    }
}
