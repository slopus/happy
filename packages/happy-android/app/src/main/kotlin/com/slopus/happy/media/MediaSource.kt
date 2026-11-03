package com.slopus.happy.media

import com.slopus.happy.connection.TransportResponse

/** Bytes [start] up to (not including) [end] of a file. */
data class ByteSpan(val start: Long, val end: Long) {
    val length: Long get() = end - start
    val isEmpty: Boolean get() = end <= start

    /** Within `0..<total`. */
    fun clamped(total: Long): ByteSpan = ByteSpan(start.coerceIn(0, total), end.coerceIn(0, total))
}

/**
 * Where a media file's bytes come from, as [MediaDownloads] reads them
 * (iOS `MediaSource`): a range at a time from the computer. [length] is the
 * file's size when it is known before the first answer.
 */
class MediaSource(val length: Long? = null, val fetch: suspend (ByteSpan) -> MediaPiece)

/**
 * An answer to one range: its bytes, where they start, and the whole
 * file's length when the server said. It may hold less than was asked, or
 * the whole file where a server ignores ranges.
 */
class MediaPiece(val offset: Long, val data: ByteArray, val total: Long?) {
    companion object {
        /** A `206` with its `Content-Range`, or a `200` holding the whole file. */
        fun http(response: TransportResponse): MediaPiece {
            if (response.status == 200) return MediaPiece(0, response.body, response.body.size.toLong())
            if (response.status != 206) throw MediaError.Status(response.status)
            val header = response.headers.entries.firstOrNull { it.key.equals("content-range", ignoreCase = true) }?.value
            val range = header?.let(ContentRange::parse) ?: throw MediaError.InvalidResponse()
            return MediaPiece(range.start, response.body, range.total)
        }

        /** `Range` for a request: `bytes=a-b`, both ends included. */
        fun header(span: ByteSpan): String = "bytes=${span.start}-${span.end - 1}"
    }
}

/** `Content-Range: bytes 0-1023/4096`; the total may be `*`. */
data class ContentRange(val start: Long, val end: Long, val total: Long?) {
    companion object {
        fun parse(header: String): ContentRange? {
            val trimmed = header.trim()
            if (!trimmed.startsWith("bytes ", ignoreCase = true)) return null
            val parts = trimmed.substring(6).split('/', limit = 2)
            if (parts.size != 2) return null
            val bounds = parts[0].split('-', limit = 2)
            val start = bounds.getOrNull(0)?.trim()?.toLongOrNull() ?: return null
            val end = bounds.getOrNull(1)?.trim()?.toLongOrNull() ?: return null
            if (start > end) return null
            return ContentRange(start, end, parts[1].trim().toLongOrNull())
        }
    }
}

/** Why a media file couldn't be read: none of these is worth trying again on its own. */
sealed class MediaError(message: String) : Exception(message) {
    class Status(val status: Int) : MediaError("HTTP $status")
    class InvalidResponse : MediaError("Invalid media response")
    /** What was asked for lies past the file's end. */
    class OutOfRange : MediaError("Past the end of the file")
    class Stopped : MediaError("Media downloads stopped")
}
