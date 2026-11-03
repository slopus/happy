package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import android.media.MediaDataSource
import android.util.Base64
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import com.slopus.happy.artifacts.RangedSource
import com.slopus.happy.artifacts.VideoProbe
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ConversationViewing
import com.slopus.happy.conversation.KeptMedia
import com.slopus.happy.conversation.MediaRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

/** A presented recording as its tile shows it: its first frame, upright pixel size and length, each once known. */
class VideoPoster(val frame: Bitmap?, val width: Float?, val height: Float?, val seconds: Double?)

/**
 * What one conversation screen has read of its presented media, kept
 * while memory allows so a tile scrolled back, and the viewer paging to
 * it, don't read it again: pictures' bytes, and recordings' first frames
 * and lengths (iOS's `MediaLoader`). A recording itself is never read
 * whole; [video] streams it by range ([rangeOf], the media route with a
 * `Range` header), as the player and the retriever ask.
 */
@Stable
class ConversationMediaStore(
    private val load: suspend (MediaRef) -> ByteArray,
    private val rangeOf: (suspend (MediaRef, LongRange) -> TransportResponse)?,
    /** The connection's media kept on this phone; where there is one, every read goes through it. */
    val kept: KeptMedia? = null,
) {
    private val bytes = object : LruCache<String, ByteArray>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }
    private val posters = LruCache<String, VideoPoster>(48)

    /**
     * A presented picture's bytes; throws when they can't be had, and
     * [KeptMedia.NotKept] where it waits for a tap on its ring.
     */
    suspend fun bytes(ref: MediaRef): ByteArray {
        bytes.get(ref.key)?.let { return it }
        return (kept?.picture(ref) ?: load(ref)).also { bytes.put(ref.key, it) }
    }

    /** A file a person opens or pages to: read whatever the automatic rules say. */
    suspend fun file(ref: MediaRef): ByteArray {
        bytes.get(ref.key)?.let { return it }
        return kept?.file(ref) ?: load(ref)
    }

    /** A presented recording to play, read a range at a time (the rest reads on behind it where it is kept); null where ranges can't be asked for. */
    fun video(ref: MediaRef): MediaDataSource? {
        if (ref.item.kind != "video") return null
        kept?.let {
            it.play(ref)
            return it.video(ref)
        }
        return stream(ref)
    }

    /** A recording read as far as a reader asks, nothing more. */
    private fun stream(ref: MediaRef): MediaDataSource? {
        kept?.let { return it.video(ref) }
        val range = rangeOf ?: return null
        return RangedSource(ref.item.size?.toLong() ?: -1) { start, end -> runBlocking { range(ref, start..end) } }
    }

    /** A presented recording's first frame (up to 1080 on its long side), size and length; null when none could be read. */
    suspend fun poster(ref: MediaRef): VideoPoster? {
        posters.get(ref.key)?.let { return it }
        if (ref.item.kind != "video") return null
        val source = stream(ref) ?: return null
        val info = withContext(Dispatchers.IO) { VideoProbe.read(source, POSTER_PIXELS) } ?: return null
        return VideoPoster(info.poster, info.size?.width?.toFloat(), info.size?.height?.toFloat(), info.seconds).also { posters.put(ref.key, it) }
    }

    companion object {
        const val POSTER_PIXELS = 1080
    }
}

@Composable
internal fun rememberConversationMediaStore(
    load: suspend (MediaRef) -> ByteArray,
    range: (suspend (MediaRef, LongRange) -> TransportResponse)?,
    kept: KeptMedia? = null,
): ConversationMediaStore = remember(load, range, kept) { ConversationMediaStore(load, range, kept) }

/** A conversation's pages for the viewer: a message's own pictures from the bytes it carries, the rest through [store]. */
internal class ConversationViewerSource(entries: List<ConversationViewing.Entry>, private val store: ConversationMediaStore) : ViewerSource {
    private val byKey = entries.associateBy { it.item.key }

    override fun cached(key: String): ByteArray? = byKey[key]?.inline?.let { decode(it.data) }

    override suspend fun bytes(key: String): ByteArray? {
        val entry = byKey[key] ?: return null
        entry.inline?.let { return decode(it.data) }
        return entry.presented?.let { store.file(it) }
    }

    override fun video(key: String): MediaDataSource? = byKey[key]?.presented?.let(store::video)

    private fun decode(data: String): ByteArray? = try {
        Base64.decode(data, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
        null
    }
}
