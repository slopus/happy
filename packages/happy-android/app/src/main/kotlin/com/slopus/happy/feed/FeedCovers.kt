package com.slopus.happy.feed

import android.util.LruCache
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.media.MediaLibrary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.concurrent.ConcurrentHashMap

/**
 * The Feed's cover pictures, read through the artifact's own file route
 * as the artifact viewer reads its files ([ArtifactMedia]): kept in the
 * connection's media library for good (a numbered version never changes)
 * and the last few in memory, so a post scrolled back draws at once. The
 * image loader decodes them at the width they are shown. Three read at a
 * time, so a fling doesn't queue the whole feed on the connection.
 */
class FeedCovers(private val fetch: suspend (FeedCover) -> ByteArray?) {
    private val kept = object : LruCache<String, ByteArray>(MEMORY_BYTES) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }
    private val reading = ConcurrentHashMap<String, CompletableDeferred<ByteArray?>>()
    private val gate = Semaphore(3)

    /** [cover]'s bytes if they are in memory: the post draws them from its first frame. */
    fun kept(cover: FeedCover): ByteArray? = kept.get(cover.key)

    /** [cover]'s bytes, read once however many posts ask; null when they can't be had. */
    suspend fun read(cover: FeedCover): ByteArray? {
        kept.get(cover.key)?.let { return it }
        val mine = CompletableDeferred<ByteArray?>()
        val running = reading.putIfAbsent(cover.key, mine)
        if (running != null) return running.await()
        val bytes = try {
            gate.withPermit { fetch(cover) }
        } catch (e: CancellationException) {
            mine.complete(null)
            reading.remove(cover.key)
            throw e
        } catch (_: Exception) {
            // Asked again when the post shows again.
            null
        }
        bytes?.let { kept.put(cover.key, it) }
        mine.complete(bytes)
        reading.remove(cover.key)
        return bytes
    }

    companion object {
        const val MEMORY_BYTES = 16 * 1024 * 1024

        /** Covers through [files], kept in [library] where the connection keeps media. */
        fun of(files: ArtifactClient, library: MediaLibrary?) = FeedCovers { cover ->
            val media = ArtifactMedia(files, cover.artifactId, cover.version, library) { null }
            try {
                val file = ArtifactFile(cover.path, cover.mimeType, 0)
                media.data(media.media(file, file.name).key)
            } finally {
                media.close()
            }
        }
    }
}
