package com.slopus.happy.sync

import com.slopus.happy.model.GitStatusFiles
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File as DiskFile
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * storage.ts `sessionFileCache` and `pathGitStatusFiles`: the file
 * viewer's last read of each file, and each checkout's last `git status`
 * file list, so a screen shows them at once while it fetches again. One per
 * account, never shared. A deleted session's files go with it (storage.ts
 * `deleteSession`); the file lists are keyed by checkout and stay, in
 * memory.
 *
 * happy-app keeps reads in memory only. Given a [directory] (the
 * account's own), this one also keeps each read on disk, so a file seen
 * once shows again after a relaunch, offline (iOS b6982bd92, 7c6c5bb2d,
 * a22e5599e). Only files the person opened are kept; nothing is fetched to
 * fill it.
 * - In memory, the [maxCount] most recently used reads, at most [maxCost]
 *   bytes of text; [file] reads only these, so a screen may ask as it opens.
 * - On disk, the [maxFiles] most recently used, at most [maxDiskBytes];
 *   [snapshot] reads one off the main thread, once however many ask. A read
 *   bigger than [maxEntryBytes] is shown but never written, and a file on
 *   disk bigger than that is removed unread. At most [maxPendingReads]
 *   files are read at once; one asked past that is a miss.
 * - Writes run one at a time on the cache's own lane, and a read sees every
 *   write asked for before it. Waiting writes are one per file, the newest;
 *   at most [maxPendingBytes] of text wait (an older one gives way as a
 *   removal of its file, so an older copy never comes back stale) and at
 *   most [maxPendingChanges] files or sessions (past that the directory is
 *   emptied before what comes next).
 * - [close] lets everything go; once it returns nothing more is read or
 *   written, so the account's directory can be removed.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionFileCache(
    private val directory: DiskFile? = null,
    private val maxCount: Int = 32,
    private val maxCost: Int = 8 * 1024 * 1024,
    private val maxFiles: Int = 256,
    private val maxDiskBytes: Long = 64L * 1024 * 1024,
    private val maxEntryBytes: Int = 4 * 1024 * 1024,
    private val maxPendingBytes: Int = 8 * 1024 * 1024,
    private val maxPendingChanges: Int = 64,
    private val maxPendingReads: Int = 8,
    io: CoroutineDispatcher = Dispatchers.IO,
) {
    /** storage.ts `sessionFileCache[sessionId][filePath]`. */
    data class File(val content: String?, val diff: String?, val isBinary: Boolean, val cachedAt: Long) {
        /** Its text, in characters: what the budgets count. */
        internal val cost: Int get() = (content?.length ?: 0) + (diff?.length ?: 0)
    }

    /** A checkout's last answer; [files] is null when `git status` failed. */
    data class StatusFiles(val files: GitStatusFiles?)

    internal data class Key(val sessionId: String, val path: String)

    private sealed interface Change {
        data class Write(val file: File) : Change
        data object Remove : Change
    }

    private val lock = Any()
    private val memory = LinkedHashMap<Key, File>(16, 0.75f, true)
    private var memoryCost = 0
    private val statusFiles = ConcurrentHashMap<String, StatusFiles>()
    private val reads = HashMap<Key, Deferred<File?>>()
    /** Keys set or removed while their disk read was under way: that read is older than what is kept now. */
    private val overtaken = HashSet<Key>()
    private var closed = false

    private val scope = CoroutineScope(SupervisorJob() + io)
    private val lane = io.limitedParallelism(1)
    private val pending = LinkedHashMap<Key, Change>()
    private val pendingSessions = LinkedHashSet<String>()
    private var pendingWipe = false
    private var pendingBytes = 0
    private var draining: Job? = null

    fun file(sessionId: String, filePath: String): File? = synchronized(lock) { if (closed) null else memory[Key(sessionId, filePath)] }

    /**
     * The read kept in memory, else on disk (read off the main thread, then
     * kept in memory). Asks no computer for anything.
     */
    suspend fun snapshot(sessionId: String, filePath: String): File? {
        val key = Key(sessionId, filePath)
        val read: Deferred<File?> = synchronized(lock) {
            if (closed) return null
            memory[key]?.let { return it }
            when (val change = pending[key]) {
                is Change.Write -> return change.file
                Change.Remove -> return null
                null -> Unit
            }
            if (pendingWipe || sessionId in pendingSessions) return null
            reads[key] ?: run {
                if (directory == null || reads.size >= maxPendingReads) return null
                scope.async(lane) { finishRead(key, readDisk(key)) }.also { reads[key] = it }
            }
        }
        return read.await()
    }

    private fun finishRead(key: Key, value: File?): File? = synchronized(lock) {
        reads.remove(key)
        if (closed) return null
        if (overtaken.remove(key)) return memory[key]
        value ?: return null
        keep(key, value)
        value
    }

    /** storage.ts `applyFileCache`: in memory now, on disk behind it. */
    fun putFile(sessionId: String, filePath: String, content: String?, diff: String?, isBinary: Boolean, now: Long = System.currentTimeMillis()) {
        val key = Key(sessionId, filePath)
        val file = File(content, diff, isBinary, now)
        synchronized(lock) {
            if (closed) return
            if (key in reads) overtaken += key
            keep(key, file)
            if (directory != null) enqueue(key, if (file.cost > maxEntryBytes) Change.Remove else Change.Write(file))
        }
    }

    /** `useSessionGitStatusFiles`: null until the checkout's first answer. */
    fun statusFiles(pathKey: String): StatusFiles? = statusFiles[pathKey]

    /** storage.ts `applyGitStatusFiles`. */
    fun putStatusFiles(pathKey: String, value: GitStatusFiles?) {
        statusFiles[pathKey] = StatusFiles(value)
    }

    /** A deleted session's reads go, its waiting writes at once. */
    fun forgetSession(sessionId: String) {
        synchronized(lock) {
            if (closed) return
            reads.keys.filter { it.sessionId == sessionId }.forEach { overtaken += it }
            memory.entries.removeAll { (key, file) -> (key.sessionId == sessionId).also { if (it) memoryCost -= file.cost } }
            if (directory == null) return
            pending.keys.filter { it.sessionId == sessionId }.forEach { dropPending(it) }
            pendingSessions += sessionId
            if (pending.size + pendingSessions.size > maxPendingChanges) wipeInstead()
            drain()
        }
    }

    /** The account is going: nothing is shown from now on, and once this returns nothing more is read or written. */
    suspend fun close() {
        val last = synchronized(lock) {
            closed = true
            memory.clear()
            memoryCost = 0
            overtaken.clear()
            draining
        }
        last?.join()
        scope.coroutineContext[Job]?.cancel()
    }

    // In memory.

    private fun keep(key: Key, file: File) {
        memory.remove(key)?.let { memoryCost -= it.cost }
        // One read past the whole budget is shown, not kept.
        if (file.cost > maxCost) return
        memory[key] = file
        memoryCost += file.cost
        val oldest = memory.entries.iterator()
        while ((memory.size > maxCount || memoryCost > maxCost) && oldest.hasNext()) {
            memoryCost -= oldest.next().value.cost
            oldest.remove()
        }
    }

    // Waiting for the disk.

    private fun enqueue(key: Key, change: Change) {
        dropPending(key)
        pending[key] = change
        if (change is Change.Write) pendingBytes += change.file.cost
        // Older waiting writes give way as removals, so their older copy never comes back.
        val iterator = pending.entries.iterator()
        while (pendingBytes > maxPendingBytes && iterator.hasNext()) {
            val entry = iterator.next()
            val waiting = entry.value as? Change.Write ?: continue
            if (entry.key == key) continue
            pendingBytes -= waiting.file.cost
            entry.setValue(Change.Remove)
        }
        if (pending.size + pendingSessions.size > maxPendingChanges) wipeInstead()
        drain()
    }

    private fun dropPending(key: Key) {
        (pending.remove(key) as? Change.Write)?.let { pendingBytes -= it.file.cost }
    }

    /** Past [maxPendingChanges]: the directory is emptied before what comes next. */
    private fun wipeInstead() {
        pending.clear()
        pendingSessions.clear()
        pendingBytes = 0
        pendingWipe = true
    }

    private fun drain() {
        if (draining?.isActive == true) return
        draining = scope.launch(lane) {
            while (true) {
                val (wipe, sessions, changes) = synchronized(lock) {
                    if (!pendingWipe && pendingSessions.isEmpty() && pending.isEmpty()) {
                        draining = null
                        return@launch
                    }
                    Triple(pendingWipe, pendingSessions.toList(), pending.toList()).also {
                        pendingWipe = false
                        pendingSessions.clear()
                        pending.clear()
                        pendingBytes = 0
                    }
                }
                val dir = directory ?: return@launch
                if (!dir.isDirectory) continue
                if (wipe) dir.listFiles()?.forEach { it.delete() }
                for (session in sessions) {
                    val prefix = prefix(session)
                    dir.listFiles { f -> f.name.startsWith(prefix) }?.forEach { it.delete() }
                }
                for ((key, change) in changes) {
                    val file = DiskFile(dir, name(key))
                    when (change) {
                        Change.Remove -> file.delete()
                        is Change.Write -> runCatching {
                            val temp = DiskFile(dir, file.name + ".tmp")
                            temp.writeText(encode(change.file))
                            if (!temp.renameTo(file)) temp.delete()
                        }
                    }
                }
                prune(dir)
            }
        }
    }

    // On disk.

    private fun readDisk(key: Key): File? {
        val dir = directory ?: return null
        val file = DiskFile(dir, name(key))
        if (!file.isFile) return null
        // Never decode more than one entry's worth (its text, escaped as JSON).
        if (file.length() > maxEntryBytes * 2L) {
            file.delete()
            return null
        }
        val decoded = runCatching { decode(file.readText()) }.getOrNull()
        if (decoded == null) file.delete() else file.setLastModified(System.currentTimeMillis())
        return decoded
    }

    /** The [maxFiles] most recently used, within [maxDiskBytes]; the oldest go first. */
    private fun prune(dir: DiskFile) {
        val files = dir.listFiles { f -> f.name.endsWith(".json") }?.sortedByDescending { it.lastModified() } ?: return
        var bytes = 0L
        files.forEachIndexed { index, file ->
            bytes += file.length()
            if (index >= maxFiles || bytes > maxDiskBytes) file.delete()
        }
    }

    internal companion object {
        /** A file's name: the session's and the path's SHA-256, so it says nothing of either, and a session's files share a prefix. */
        fun name(key: Key): String = prefix(key.sessionId) + sha256(key.path) + ".json"

        fun prefix(sessionId: String): String = sha256(sessionId) + "-"

        private fun sha256(text: String): String =
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

        fun encode(file: File): String = buildJsonObject {
            file.content?.let { put("content", it) }
            file.diff?.let { put("diff", it) }
            put("isBinary", file.isBinary)
            put("cachedAt", file.cachedAt)
        }.toString()

        fun decode(text: String): File? {
            val o = Json.parseToJsonElement(text) as? JsonObject ?: return null
            fun str(name: String) = (o[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
            return File(str("content"), str("diff"), o["isBinary"]?.jsonPrimitive?.booleanOrNull ?: return null, o["cachedAt"]?.jsonPrimitive?.longOrNull ?: 0)
        }

        /** The cache's directory inside an account's files. */
        fun directory(root: DiskFile, accountId: String): DiskFile = DiskFile(root, "file-cache/$accountId")
    }

    // For tests.
    internal val keptCount: Int get() = synchronized(lock) { memory.size }

    /** Waits until everything asked of the disk so far is done. */
    internal suspend fun drained() {
        while (true) {
            val job = synchronized(lock) { draining } ?: return
            job.join()
        }
    }

}
