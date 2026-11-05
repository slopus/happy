package com.slopus.happy.vaults

import com.slopus.happy.agent.AgentApiException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.OutputStream

/** What a download writes: the file as it is, or a folder or an artifact as a zip, and its name. */
object VaultDownloads {
    /** The name it is saved or shared under: a file's own, a folder's or an artifact's with `.zip`. */
    /** A file's own name; an artifact's, which ends in ".artifact" (a zip with its manifest); a folder's zip. */
    fun name(entry: VaultItem): String = if (entry.isFolder) "${entry.name}.zip" else entry.name

    fun mediaType(entry: VaultItem): String = when {
        entry.isFile -> entry.mediaType ?: "application/octet-stream"
        entry.isArtifact -> "application/octet-stream"
        else -> "application/zip"
    }

    /**
     * Writes [entry] (a file's [version], null the latest) to [out]: a file a
     * range at a time, so a large one never sits whole in memory; a folder as
     * the zip the daemon streams, an artifact as its ".artifact" bundle. [progress] hears the bytes
     * written and the whole, when known.
     */
    suspend fun write(routes: VaultClient, entry: VaultItem, version: Int?, size: Long?, out: OutputStream, progress: (Long, Long?) -> Unit = { _, _ -> }) {
        if (!entry.isFile) {
            val bytes = routes.zip(entry, version)
            out.write(bytes)
            progress(bytes.size.toLong(), bytes.size.toLong())
            return
        }
        val total = size ?: entry.size ?: 0L
        if (total <= 0L) {
            out.write(routes.content(entry.surfaceId, entry.id, version).body)
            return
        }
        var at = 0L
        while (at < total) {
            currentCoroutineContext().ensureActive()
            val end = minOf(at + CHUNK, total) - 1
            val response = routes.content(entry.surfaceId, entry.id, version, "bytes=$at-$end")
            when (response.status) {
                // A server that ignores ranges sends the whole file.
                200 -> {
                    out.write(response.body)
                    progress(response.body.size.toLong(), response.body.size.toLong())
                    return
                }
                206 -> {
                    if (response.body.isEmpty()) throw AgentApiException(response.status, null, null)
                    out.write(response.body)
                    at += response.body.size
                    progress(at, total)
                }
                else -> throw AgentApiException(response.status, null, null)
            }
        }
    }

    const val CHUNK = 4L * 1024 * 1024
}
