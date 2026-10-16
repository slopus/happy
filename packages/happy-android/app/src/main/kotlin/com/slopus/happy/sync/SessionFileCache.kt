package com.slopus.happy.sync

import com.slopus.happy.model.GitStatusFiles
import java.util.concurrent.ConcurrentHashMap

/**
 * storage.ts `sessionFileCache` and `pathGitStatusFiles`, in memory for the
 * account's life (happy-app doesn't persist either): the file viewer's last
 * read of each file, and each checkout's last `git status` file list, so a
 * screen shows them at once while it fetches again. A deleted session's
 * files go with it (storage.ts `deleteSession`); the file lists are keyed by
 * checkout, not session, and stay.
 */
class SessionFileCache {
    /** storage.ts `sessionFileCache[sessionId][filePath]`. */
    data class File(val content: String?, val diff: String?, val isBinary: Boolean, val cachedAt: Long)

    /** A checkout's last answer; [files] is null when `git status` failed. */
    data class StatusFiles(val files: GitStatusFiles?)

    private val files = ConcurrentHashMap<String, ConcurrentHashMap<String, File>>()
    private val statusFiles = ConcurrentHashMap<String, StatusFiles>()

    fun file(sessionId: String, filePath: String): File? = files[sessionId]?.get(filePath)

    /** storage.ts `applyFileCache`. */
    fun putFile(sessionId: String, filePath: String, content: String?, diff: String?, isBinary: Boolean, now: Long = System.currentTimeMillis()) {
        files.getOrPut(sessionId) { ConcurrentHashMap() }[filePath] = File(content, diff, isBinary, now)
    }

    /** `useSessionGitStatusFiles`: null until the checkout's first answer. */
    fun statusFiles(pathKey: String): StatusFiles? = statusFiles[pathKey]

    /** storage.ts `applyGitStatusFiles`. */
    fun putStatusFiles(pathKey: String, value: GitStatusFiles?) {
        statusFiles[pathKey] = StatusFiles(value)
    }

    fun forgetSession(sessionId: String) {
        files.remove(sessionId)
    }
}
