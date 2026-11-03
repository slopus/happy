package com.slopus.happy.media

import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

/**
 * One account's media on this phone, kept for good (iOS `MediaStore`,
 * after Telegram's resource store): a complete file under its name and a
 * partial one ([PartialFile]) beside it while it is read. A file's name is
 * a hash of its ID, the content's own (a tool call's media), so it is read
 * once and never again. Nothing is evicted on its own; only [removeAll]
 * (Data and Storage's Clear Media) or removing the account empties it.
 *
 * An agent connection's is beside its kept catalog, in no-backup storage:
 * it can always be read again from where it came from.
 */
class MediaStore(val directory: File) {
    private val lock = Any()
    private val partials = HashMap<String, PartialFile>()

    /** Where the complete file is, or goes. */
    fun completeFile(id: String): File = File(directory, name(id))

    fun isComplete(id: String): Boolean = completeFile(id).isFile

    /** The complete file's length. */
    fun completeLength(id: String): Long? = completeFile(id).takeIf { it.isFile }?.length()

    /** The file being read, opened once. */
    fun partial(id: String): PartialFile = synchronized(lock) {
        partials.getOrPut(id) {
            directory.mkdirs()
            val base = completeFile(id).path
            PartialFile(File("$base.part"), File("$base.part.meta"))
        }
    }

    /** Whether anything of it is here yet, without making a record. */
    fun hasPartial(id: String): Boolean =
        synchronized(lock) { id in partials } || File(completeFile(id).path + ".part.meta").isFile

    /** The partial file is whole: it becomes the complete one. */
    fun finish(id: String) {
        val partial = partial(id)
        if (!partial.isComplete || partial.total == null) throw MediaError.InvalidResponse()
        partial.close()
        val target = completeFile(id)
        target.delete()
        if (!partial.data.renameTo(target)) {
            partial.data.copyTo(target, overwrite = true)
            partial.data.delete()
        }
        partial.meta.delete()
        synchronized(lock) { partials.remove(id) }
    }

    /** Keeps bytes this phone already has: they are never read from the computer. */
    fun keep(id: String, bytes: ByteArray) {
        val target = completeFile(id)
        if (target.isFile) return
        directory.mkdirs()
        val staging = File(directory, "${UUID.randomUUID()}.in")
        staging.writeBytes(bytes)
        // Another writer kept the same content first: theirs stays.
        if (!staging.renameTo(target)) staging.delete()
    }

    /** The bytes of [span]: from the complete file, else from what the partial one holds; null while any is missing. */
    fun read(id: String, span: ByteSpan): ByteArray? {
        val complete = completeFile(id)
        if (complete.isFile) {
            if (span.isEmpty) return ByteArray(0)
            return runCatching {
                RandomAccessFile(complete, "r").use { file ->
                    if (span.end > file.length()) return null
                    ByteArray(span.length.toInt()).also { file.seek(span.start); file.readFully(it) }
                }
            }.getOrNull()
        }
        return partial(id).read(span)
    }

    /** The bytes kept, partial files and all. */
    fun usage(): Long = directory.listFiles()?.sumOf { it.length() } ?: 0

    /** Forgets every file. What is being read starts over. */
    fun removeAll() {
        synchronized(lock) {
            partials.values.forEach { it.close() }
            partials.clear()
        }
        directory.deleteRecursively()
    }

    companion object {
        /** The file name an ID is kept under: the first 16 bytes of its SHA-256, hex. */
        fun name(id: String): String =
            MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).take(16).joinToString("") { "%02x".format(it) }
    }
}
