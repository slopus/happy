package com.slopus.happy.documents

import com.slopus.happy.agent.AgentClient
import kotlinx.serialization.Serializable
import java.io.File
import java.io.RandomAccessFile

/**
 * One document as this phone keeps it, under the connection's folder
 * (`<connection>.documents/<surfaceId>/`; iOS's `DocumentKeep`):
 *
 * - `state.yjs`: the whole replica as one update, rewritten now and then;
 * - `local.log`: every local change since, appended as it is made, so a
 *   kill a moment after a keystroke keeps it;
 * - `sending.json`: the change on its way, with its mutation ID, so a
 *   retry after a relaunch sends the same bytes under the same ID;
 * - `meta.json`: what the computer is known to have and whether anything
 *   made here is still unsent.
 *
 * Every file but the log is written whole and atomically. The log is
 * replayed over the state when opened: applying an update twice changes
 * nothing, so a kill between rewriting the state and emptying the log
 * loses nothing either. Not thread-safe, and disk work: [DocumentSync] owns
 * it, off the main thread.
 */
class DocumentKeep(val directory: File) {
    @Serializable
    data class Meta(
        /** The computer's last head this phone saw. */
        val seq: Int = 0,
        /** What the computer is known to hold, per client. */
        val serverVector: Map<Long, Int> = emptyMap(),
        /** The clients whose changes were made on this phone, by any open of it. */
        val localClients: Set<Long> = emptySet(),
        /** Something made here the computer may not have yet. */
        val unsent: Boolean = false,
    )

    @Serializable
    data class Sending(
        val mutationId: String,
        /** The update, base64. */
        val update: String,
        /**
         * The replica's vector for local clients when it was made: what
         * the computer holds of them once it takes it.
         */
        val vector: Map<Long, Int>,
    ) {
        val bytes: ByteArray get() = java.util.Base64.getDecoder().decode(update)
    }

    class Kept(val state: ByteArray?, val local: List<ByteArray>, val meta: Meta, val sending: Sending?)

    private var log: RandomAccessFile? = null
    var logSize = 0L
        private set

    private val stateFile get() = File(directory, "state.yjs")
    private val logFile get() = File(directory, "local.log")
    private val sendingFile get() = File(directory, "sending.json")
    private val metaFile get() = File(directory, "meta.json")

    /** What was kept: the replica state, the local changes logged after it, and the rest. */
    fun read(): Kept {
        val state = runCatching { stateFile.takeIf { it.exists() }?.readBytes() }.getOrNull()
        val meta = runCatching { metaFile.takeIf { it.exists() }?.readText()?.let { AgentClient.json.decodeFromString(Meta.serializer(), it) } }.getOrNull() ?: Meta()
        val sending = runCatching { sendingFile.takeIf { it.exists() }?.readText()?.let { AgentClient.json.decodeFromString(Sending.serializer(), it) } }.getOrNull()
        val local = ArrayList<ByteArray>()
        val bytes = runCatching { logFile.takeIf { it.exists() }?.readBytes() }.getOrNull()
        if (bytes != null) {
            var i = 0
            // A record cut short by a kill mid-write is dropped; the ones before it stand.
            while (i + 4 <= bytes.size) {
                val length = (bytes[i].toInt() and 0xff) or (bytes[i + 1].toInt() and 0xff shl 8) or
                    (bytes[i + 2].toInt() and 0xff shl 16) or (bytes[i + 3].toInt() and 0xff shl 24)
                if (length < 0 || i + 4 + length > bytes.size) break
                local += bytes.copyOfRange(i + 4, i + 4 + length)
                i += 4 + length
            }
            logSize = i.toLong()
        }
        return Kept(state, local, meta, sending)
    }

    val exists: Boolean get() = stateFile.exists()

    /** Keeps one local change at once. */
    fun append(update: ByteArray) {
        val file = log ?: run {
            directory.mkdirs()
            RandomAccessFile(logFile, "rw").also {
                // Past whatever a kill left half-written.
                it.setLength(logSize)
                it.seek(logSize)
                log = it
            }
        }
        val n = update.size
        val record = ByteArray(4 + n)
        record[0] = n.toByte(); record[1] = (n shr 8).toByte(); record[2] = (n shr 16).toByte(); record[3] = (n shr 24).toByte()
        update.copyInto(record, 4)
        file.write(record)
        logSize += record.size
    }

    /** The whole replica, after which the log is empty. */
    fun writeState(state: ByteArray) {
        directory.mkdirs()
        atomically(stateFile) { it.writeBytes(state) }
        val open = log
        if (open != null) {
            open.setLength(0)
            open.seek(0)
        } else {
            logFile.delete()
        }
        logSize = 0
    }

    fun writeMeta(meta: Meta) {
        directory.mkdirs()
        atomically(metaFile) { it.writeText(AgentClient.json.encodeToString(Meta.serializer(), meta)) }
    }

    fun writeSending(sending: Sending?) {
        if (sending == null) {
            sendingFile.delete()
            return
        }
        directory.mkdirs()
        atomically(sendingFile) { it.writeText(AgentClient.json.encodeToString(Sending.serializer(), sending)) }
    }

    fun close() {
        runCatching { log?.close() }
        log = null
    }

    /** Forgets the document: it was removed, or the computer's copy replaces this one. */
    fun remove() {
        close()
        directory.deleteRecursively()
        logSize = 0
    }

    private inline fun atomically(file: File, write: (File) -> Unit) {
        val temp = File(file.path + ".tmp")
        write(temp)
        if (!temp.renameTo(file)) {
            file.delete()
            temp.renameTo(file)
        }
    }

    companion object {
        fun directory(root: File, surfaceId: String): File = File(root, surfaceId.filter { it.isLetterOrDigit() || it == '-' || it == '_' })
    }
}
