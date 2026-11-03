package com.slopus.happy.media

import android.media.MediaDataSource
import kotlinx.coroutines.runBlocking

/**
 * A kept recording as `MediaDataSource` reads it (iOS `MediaStream`): what
 * runs on without a hole from where it asks goes at once, in big pieces;
 * what isn't here is fetched a range at a time, the range it asks first.
 * The player's threads block on it, as they do on any data source.
 */
class MediaStream(private val downloads: MediaDownloads, private val id: String, private val source: MediaSource) : MediaDataSource() {
    @Volatile private var total: Long = -1
    @Volatile private var closed = false

    override fun getSize(): Long {
        if (total < 0 && !closed) total = runCatching { runBlocking { downloads.length(id, source) } }.getOrDefault(-1)
        return total
    }

    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (closed || size < 0) return -1
        if (size == 0) return 0
        val length = getSize()
        if (length in 0..position) return -1
        val end = if (length >= 0) minOf(length, position + size) else position + size
        return runCatching {
            runBlocking {
                val here = downloads.available(id, position, minOf(PIECE, end - position))
                val span = ByteSpan(position, position + if (here > 0) here else minOf(MediaDownloads.STREAM_CHUNK, end - position))
                downloads.read(id, source, span)
            }
        }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { bytes ->
            System.arraycopy(bytes, 0, buffer, offset, bytes.size)
            bytes.size
        } ?: -1
    }

    override fun close() {
        closed = true
    }

    private companion object {
        /** Answered at a time while the bytes are here. */
        const val PIECE = 512L * 1024
    }
}
