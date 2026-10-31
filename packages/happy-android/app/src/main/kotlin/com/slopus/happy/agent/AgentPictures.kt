package com.slopus.happy.agent

import com.slopus.happy.data.DiskThread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * Pictures the agent serves (bots' avatars, project pictures), read once
 * over the tunnel and kept by path and ThumbHash: in memory, so a row
 * scrolled back into view draws at once, and in [directory], so the next
 * start and an offline home draw them without asking. A changed picture
 * comes with a new ThumbHash and is read again.
 */
class AgentPictures(
    private val connectionId: String,
    /** Where the pictures are kept on disk, one file each; null keeps them in memory only. */
    private val directory: File? = null,
    private val fetch: suspend (path: String) -> ByteArray,
) {
    private val kept = ConcurrentHashMap<String, ByteArray>()

    /** What [path] at [thumbhash] is kept under, here and in the image loader's memory cache. */
    fun key(path: String, thumbhash: String?) = "agent/$connectionId$path#${thumbhash.orEmpty()}"

    fun kept(path: String, thumbhash: String?): ByteArray? = kept[key(path, thumbhash)]

    suspend fun read(path: String, thumbhash: String?): ByteArray {
        val key = key(path, thumbhash)
        kept[key]?.let { return it }
        val file = directory?.let { File(it, "picture-${digest(key)}.bin") }
        file?.let { withContext(Dispatchers.IO) { readFile(it) } }?.let { bytes ->
            kept[key] = bytes
            return bytes
        }
        val bytes = fetch(path)
        kept[key] = bytes
        if (file != null) withContext(Dispatchers.IO) { writeFile(file, bytes) }
        return bytes
    }

    private fun readFile(file: File): ByteArray? {
        DiskThread.check()
        return try {
            file.takeIf { it.exists() }?.readBytes()
        } catch (_: Exception) {
            null
        }
    }

    private fun writeFile(file: File, bytes: ByteArray) {
        DiskThread.check()
        try {
            file.parentFile?.mkdirs()
            val temp = File(file.path + ".tmp")
            temp.writeBytes(bytes)
            if (!temp.renameTo(file)) temp.delete()
        } catch (_: Exception) {
            // Read over the tunnel again next time.
        }
    }

    private fun digest(key: String): String =
        MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).take(16).joinToString("") { "%02x".format(it) }
}
