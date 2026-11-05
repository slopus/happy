package com.slopus.happy.vaults

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.InputStream

/** Bytes to upload: a picked document, read from the start each time it is opened. */
interface VaultUploadSource {
    val name: String
    val size: Long
    fun open(): InputStream
}

/**
 * The phone's uploads into vaults (API.md, "Vault Surfaces" › Uploads),
 * one at a time in the order they were asked for, for as long as the
 * connection is open, whatever screen is shown. Each sends its bytes in
 * pieces sized to take a few seconds each, resuming from what the daemon
 * says it has after a failure, then places the upload: a new file, a new
 * artifact (a file named "*.artifact", which the daemon unpacks), or a new
 * version of [Task.replacing]. A name already taken in the folder by an
 * entry of the same kind waits for the person to replace it or keep both.
 */
class VaultUploads(
    private val routes: VaultClient,
    private val scope: CoroutineScope,
    /** An entry an upload made or changed, for the folders showing it. */
    private val placed: (VaultItem) -> Unit,
    private val retryMs: Long = 2_000,
) {
    enum class Status { Waiting, Sending, Placing, NameTaken, Failed }

    @Immutable
    data class Task(
        val id: String,
        val surfaceId: String,
        val parentId: String?,
        val name: String,
        val size: Long,
        /** [VaultItem.FILE], or [VaultItem.ARTIFACT] for a ".artifact" bundle. */
        val kind: String = VaultItem.FILE,
        val sent: Long = 0,
        val status: Status = Status.Waiting,
        /** A new version of this file rather than a new file. */
        val replacing: VaultItem? = null,
        /** The file already called [name], while [status] is NameTaken. */
        val taken: VaultItem? = null,
        val problem: Problem? = null,
        /** The daemon refused it (a bad `.artifact`, a name it can't take): trying again won't help. */
        val refused: Boolean = false,
    ) {
        val progress: Float get() = if (size <= 0) 1f else (sent.toFloat() / size).coerceIn(0f, 1f)
    }

    /** What to do about a taken name. */
    enum class Choice { Replace, KeepBoth, Cancel }

    private val tasksFlow = MutableStateFlow<List<Task>>(emptyList())
    val tasks: StateFlow<List<Task>> = tasksFlow.asStateFlow()
    private val sources = HashMap<String, VaultUploadSource>()
    private val jobs = HashMap<String, Job>()
    private val choices = HashMap<String, CompletableDeferred<Choice>>()
    private val uploadIds = HashMap<String, String>()
    private val turn = Mutex()

    /** Uploads [source] into [parentId]: an artifact when its name ends in ".artifact", otherwise a file. */
    fun add(surfaceId: String, parentId: String?, source: VaultUploadSource): String {
        val kind = if (VaultNames.isArtifact(source.name)) VaultItem.ARTIFACT else VaultItem.FILE
        return start(Task(AgentClient.newId(), surfaceId, parentId, source.name, source.size, kind), source)
    }

    /** Uploads [source] as a new version of [entry]: a file's bytes, or an artifact's ".artifact" bundle. */
    fun replace(entry: VaultItem, source: VaultUploadSource): String =
        start(Task(AgentClient.newId(), entry.surfaceId, entry.parentId, entry.name, source.size, entry.kind, replacing = entry), source)

    fun resolve(taskId: String, choice: Choice) {
        synchronized(this) { choices.remove(taskId) }?.complete(choice)
    }

    fun cancel(taskId: String) {
        val job = synchronized(this) { jobs.remove(taskId) }
        resolve(taskId, Choice.Cancel)
        job?.cancel()
        finish(taskId)
    }

    fun retry(taskId: String) {
        val task = tasksFlow.value.firstOrNull { it.id == taskId } ?: return
        val source = synchronized(this) { sources[taskId] } ?: return
        if (task.status != Status.Failed || task.refused) return
        set(taskId) { it.copy(status = Status.Waiting, problem = null) }
        run(taskId, source)
    }

    private fun start(task: Task, source: VaultUploadSource): String {
        synchronized(this) { sources[task.id] = source }
        tasksFlow.update { it + task }
        run(task.id, source)
        return task.id
    }

    private fun run(taskId: String, source: VaultUploadSource) {
        val job = scope.launch {
            turn.withLock {
                try {
                    val uploadId = send(taskId, source)
                    place(taskId, uploadId)
                    finish(taskId)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    val refused = e is AgentApiException && e.status in 400..499 && e.status !in RETRYABLE
                    set(taskId) { it.copy(status = Status.Failed, problem = Conversation.describe(e), refused = refused) }
                }
            }
        }
        synchronized(this) { jobs[taskId] = job }
    }

    private fun finish(taskId: String) {
        val upload = synchronized(this) {
            sources.remove(taskId)
            jobs.remove(taskId)
            uploadIds.remove(taskId)
        }
        tasksFlow.update { list -> list.filter { it.id != taskId } }
        // An upload that was never placed expires on its own; this only frees it sooner.
        if (upload != null) scope.launch { runCatching { routes.discardUpload(upload) } }
    }

    private fun set(taskId: String, change: (Task) -> Task) = tasksFlow.update { list -> list.map { if (it.id == taskId) change(it) else it } }

    private fun task(taskId: String): Task = tasksFlow.value.first { it.id == taskId }

    /** Sends every byte, resuming where the daemon is; the complete upload's ID. */
    private suspend fun send(taskId: String, source: VaultUploadSource): String {
        set(taskId) { it.copy(status = Status.Sending) }
        val size = source.size
        var upload = synchronized(this) { uploadIds[taskId] }?.let { id ->
            try {
                routes.upload(id)
            } catch (e: AgentApiException) {
                if (e.status == 404) null else throw e
            }
        } ?: routes.startUpload(size).also { started -> synchronized(this) { uploadIds[taskId] = started.id } }
        var chunk = INITIAL_CHUNK
        var failures = 0
        var stream: InputStream? = null
        var at = -1L
        try {
            while (!upload.complete && upload.received < size) {
                if (stream == null || at != upload.received) {
                    stream?.close()
                    stream = source.open()
                    skipFully(stream, upload.received)
                    at = upload.received
                }
                val bytes = readUpTo(stream, minOf(chunk.toLong(), size - at).toInt())
                if (bytes.isEmpty()) throw java.io.IOException("The file ended early")
                val began = System.nanoTime()
                upload = try {
                    routes.append(upload.id, at, size, bytes).also {
                        at += bytes.size
                        failures = 0
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AgentApiException) {
                    if (e.status != 409) throw e
                    if (e.code == "hash_mismatch") throw e
                    VaultClient.conflictUpload(e) ?: routes.upload(upload.id)
                } catch (e: Exception) {
                    if (++failures > MAX_FAILURES) throw e
                    delay(retryMs * failures)
                    routes.upload(upload.id)
                }
                val seconds = (System.nanoTime() - began) / 1e9
                // Pieces that take about [TARGET_SECONDS] each: few requests on a fast link, no timeouts on a slow one.
                if (failures == 0) chunk = when {
                    seconds < TARGET_SECONDS / 2 -> minOf(chunk * 2, MAX_CHUNK)
                    seconds > TARGET_SECONDS * 2 -> maxOf(chunk / 2, MIN_CHUNK)
                    else -> chunk
                }
                set(taskId) { it.copy(sent = upload.received) }
            }
        } finally {
            stream?.close()
        }
        return upload.id
    }

    private suspend fun place(taskId: String, uploadId: String) {
        set(taskId) { it.copy(status = Status.Placing, sent = it.size) }
        val task = task(taskId)
        task.replacing?.let { entry ->
            placed(newVersion(entry, uploadId))
            synchronized(this) { uploadIds.remove(taskId) }
            return
        }
        var name = task.name
        var copy = 1
        var keepingBoth = false
        val createId = AgentClient.newId()
        while (true) {
            try {
                placed(routes.createFile(task.surfaceId, task.parentId, name, uploadId, id = if (keepingBoth) AgentClient.newId() else createId))
                synchronized(this) { uploadIds.remove(taskId) }
                return
            } catch (e: AgentApiException) {
                if (e.status != 409 || e.code != "name_taken") throw e
                val taken = VaultClient.conflictItem(e)
                if (keepingBoth || taken == null || taken.kind != task.kind) {
                    keepingBoth = true
                    copy += 1
                    if (copy > MAX_COPIES) throw e
                    name = numbered(task.name, copy)
                    continue
                }
                val answer = CompletableDeferred<Choice>()
                synchronized(this) { choices[taskId] = answer }
                set(taskId) { it.copy(status = Status.NameTaken, taken = taken) }
                when (answer.await()) {
                    Choice.Cancel -> throw CancellationException("cancelled")
                    Choice.Replace -> {
                        set(taskId) { it.copy(status = Status.Placing, taken = null) }
                        placed(newVersion(taken, uploadId))
                        synchronized(this) { uploadIds.remove(taskId) }
                        return
                    }
                    Choice.KeepBoth -> {
                        set(taskId) { it.copy(status = Status.Placing, taken = null) }
                        keepingBoth = true
                        copy += 1
                        name = numbered(task.name, copy)
                    }
                }
            }
        }
    }

    /** A new version of [entry], once more against its current version if it changed meanwhile. */
    private suspend fun newVersion(entry: VaultItem, uploadId: String): VaultItem = try {
        routes.newVersion(entry, uploadId = uploadId).first
    } catch (e: AgentApiException) {
        if (e.status != 409 || e.code == "name_taken") throw e
        val current = VaultClient.conflictItem(e) ?: routes.location(entry).item
        if (current.deletedAt != null) throw e
        routes.newVersion(current, uploadId = uploadId).first
    }

    companion object {
        const val MIN_CHUNK = 256 * 1024
        const val INITIAL_CHUNK = 1024 * 1024
        const val MAX_CHUNK = 16 * 1024 * 1024
        const val TARGET_SECONDS = 3.0
        const val MAX_FAILURES = 6
        const val MAX_COPIES = 99

        /** Refusals that may pass on another try: a timeout, a conflict, too many requests. */
        private val RETRYABLE = setOf(408, 409, 429)

        /** "report.pdf" as its [n]th copy: "report 2.pdf"; a name without an extension, or a dotfile, gets the number at the end. */
        fun numbered(name: String, n: Int): String {
            val dot = name.lastIndexOf('.')
            return if (dot <= 0) "$name $n" else "${name.substring(0, dot)} $n${name.substring(dot)}"
        }

        private fun skipFully(stream: InputStream, count: Long) {
            var left = count
            while (left > 0) {
                val skipped = stream.skip(left)
                if (skipped > 0) {
                    left -= skipped
                } else {
                    if (stream.read() < 0) throw java.io.IOException("The file ended early")
                    left -= 1
                }
            }
        }

        private fun readUpTo(stream: InputStream, count: Int): ByteArray {
            val buffer = ByteArray(count)
            var filled = 0
            while (filled < count) {
                val read = stream.read(buffer, filled, count - filled)
                if (read < 0) break
                filled += read
            }
            return if (filled == count) buffer else buffer.copyOf(filled)
        }
    }
}
