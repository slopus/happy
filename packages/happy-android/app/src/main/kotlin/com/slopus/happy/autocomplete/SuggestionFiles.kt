package com.slopus.happy.autocomplete

import com.slopus.happy.sync.RipgrepResult
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** suggestionFile.ts `FileItem`. Folders end in a slash, in both [fileName] and [fullPath]. */
data class FileItem(val fileName: String, val filePath: String, val fullPath: String, val fileType: FileType) {
    enum class FileType { File, Folder }
}

/**
 * suggestionFile.ts `FileSearchCache`: each session's files from
 * `rg --files --follow` over the session's ripgrep RPC, then every folder
 * above them, kept 5 minutes and searched with Fuse on the name (0.7) and
 * the full path (0.3). A failed listing leaves the cache empty, so the next
 * search tries again.
 */
class FileSearchCache(
    private val ripgrep: suspend (sessionId: String, args: List<String>) -> RipgrepResult,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class SessionCache {
        var files: List<FileItem> = emptyList()
        var fuse: Fuse<FileItem>? = null
        var lastRefresh = 0L
        val lock = Mutex()
    }

    private val sessions = HashMap<String, SessionCache>()

    private fun cache(sessionId: String) = synchronized(sessions) { sessions.getOrPut(sessionId, ::SessionCache) }

    private suspend fun ensureValid(sessionId: String) {
        val cache = cache(sessionId)
        if (now() - cache.lastRefresh <= CACHE_TIMEOUT_MS && cache.files.isNotEmpty()) return
        cache.lock.withLock {
            if (now() - cache.lastRefresh < 1000) return
            // A newer keystroke cancels the search, not the listing everyone is waiting on.
            val response = withContext(NonCancellable) { ripgrep(sessionId, listOf("--files", "--follow")) }
            val stdout = response.stdout
            if (!response.success || stdout.isNullOrEmpty()) return
            cache.files = fileItems(stdout.split('\n').filter { it.isNotBlank() })
            cache.lastRefresh = now()
            cache.fuse = cache.files.takeIf { it.isNotEmpty() }?.let { files ->
                Fuse(
                    files,
                    listOf(FuseKey(0.7) { it.fileName }, FuseKey(0.3) { it.fullPath }),
                    threshold = 0.3,
                    ignoreLocation = true,
                    useExtendedSearch = true,
                )
            }
        }
    }

    /** suggestionFile.ts `search`: the first [limit] entries for a blank query, else the Fuse ranking. */
    suspend fun search(sessionId: String, query: String, limit: Int = 10): List<FileItem> {
        ensureValid(sessionId)
        val cache = cache(sessionId)
        val fuse = cache.fuse ?: return emptyList()
        if (query.isBlank()) return cache.files.take(limit)
        return fuse.search(query, limit).map { it.item }
    }

    fun clear(sessionId: String? = null) = synchronized(sessions) {
        if (sessionId == null) sessions.clear() else sessions.remove(sessionId)
    }

    companion object {
        const val CACHE_TIMEOUT_MS = 5 * 60 * 1000L

        /** The listed files, then each folder above them once, in first-seen order. */
        fun fileItems(paths: List<String>): List<FileItem> {
            val files = paths.map { path ->
                val parts = path.split('/')
                val fileName = parts.last().ifEmpty { path }
                val parent = parts.dropLast(1).joinToString("/")
                FileItem(fileName, if (parent.isNotEmpty()) "$parent/" else "", path, FileItem.FileType.File)
            }
            val directories = LinkedHashSet<String>()
            for (path in paths) {
                val parts = path.split('/')
                for (i in 1 until parts.size) {
                    parts.subList(0, i).joinToString("/").takeIf { it.isNotEmpty() }?.let(directories::add)
                }
            }
            val folders = directories.map { dir ->
                val parts = dir.split('/')
                val parent = parts.dropLast(1).joinToString("/")
                FileItem(parts.last() + "/", if (parent.isNotEmpty()) "$parent/" else "", "$dir/", FileItem.FileType.Folder)
            }
            return files + folders
        }
    }
}
