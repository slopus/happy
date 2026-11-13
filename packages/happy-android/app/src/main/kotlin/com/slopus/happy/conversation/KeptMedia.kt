package com.slopus.happy.conversation

import android.media.MediaDataSource
import androidx.compose.runtime.Stable
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.media.ByteSpan
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.media.MediaDownloads
import com.slopus.happy.media.MediaError
import com.slopus.happy.media.MediaLibrary
import com.slopus.happy.media.MediaPiece
import com.slopus.happy.media.MediaSource
import com.slopus.happy.media.MediaStream
import com.slopus.happy.media.NotKept
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * One conversation's presented media, kept on this phone for good (iOS
 * `MediaLoader`'s kept files): each tool call's file is read into the
 * connection's [MediaLibrary] once, a range at a time over the media route
 * ([range]). A photo or small file reads itself as it shows up
 * ([MediaAutoDownload]); anything else waits for a tap on its ring. A
 * recording streams through the library, so what was played is kept.
 */
@Stable
class KeptMedia(
    private val library: MediaLibrary,
    private val agentId: String,
    private val range: suspend (MediaRef, ByteSpan) -> TransportResponse,
    private val rules: StateFlow<MediaAutoDownload>,
    private val scope: CoroutineScope,
) {
    /** Files a person asked for, read whatever the automatic rules say. */
    private val requested = ConcurrentHashMap.newKeySet<String>()
    /** Files already handed to automatic download, under [handedUnder]. */
    private val handed = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var handedUnder: MediaAutoDownload? = null

    /** The file's ID in the library: a tool call's media is never another's; an attachment is its bytes'. */
    fun id(ref: MediaRef): String = ref.attachment?.let { attachmentId(agentId, it) } ?: "tool/$agentId/${ref.toolCallId}/${ref.index}"

    /** Where its bytes come from: the computer's media route, a range at a time. */
    fun source(ref: MediaRef): MediaSource = MediaSource(ref.item.size?.toLong()) { span ->
        val response = range(ref, span)
        // A refusal won't change by asking again; anything else might.
        if (response.status in 400..499 && response.status != 408 && response.status != 429) throw MediaError.Status(response.status)
        if (response.status != 200 && response.status != 206) throw IOException("HTTP ${response.status}")
        MediaPiece.http(response)
    }

    /** Where its download is, as the board last said; snapshot state, so a tile reading it follows it. */
    fun phase(ref: MediaRef): DownloadPhase? = library.board.phase(id(ref))

    /** A tile shows [ref]: its phase is read from the disk, and it reads itself where the rules allow. */
    fun shown(ref: MediaRef) {
        val rules = rules.value
        if (handedUnder != rules) {
            handedUnder = rules
            handed.clear()
        }
        val (id, source) = id(ref) to source(ref)
        val automatic = handed.add(ref.key) && rules.allows(kind(ref.item), ref.item.size?.toLong())
        scope.launch {
            library.downloads.phase(id, source)
            if (automatic) library.downloads.download(id, source, MediaDownloads.Priority.Background)
        }
    }

    /** A tap on its ring: pause what is going, else read it. */
    fun toggle(ref: MediaRef) {
        requested += ref.key
        val (id, source) = id(ref) to source(ref)
        scope.launch { library.downloads.toggle(id, source) }
    }

    /** A recording plays: the rest of it reads on behind the player, so it is kept once played. */
    fun play(ref: MediaRef) {
        requested += ref.key
        val (id, source) = id(ref) to source(ref)
        scope.launch { library.downloads.download(id, source, MediaDownloads.Priority.User) }
    }

    /** A picture's bytes, read first where the rules or a tap allow; [NotKept] where neither does and it isn't here. */
    suspend fun picture(ref: MediaRef): ByteArray {
        val (id, source) = id(ref) to source(ref)
        val allowed = ref.key in requested || rules.value.allows(MediaAutoDownload.Kind.Photos, ref.item.size?.toLong())
        if (!allowed && !library.downloads.phase(id, source).isComplete) throw NotKept()
        return library.downloads.data(id, source, MediaDownloads.Priority.User)
    }

    /** The whole file, read first where it isn't here: a file a person opens. */
    suspend fun file(ref: MediaRef): ByteArray {
        requested += ref.key
        return library.downloads.data(id(ref), source(ref), MediaDownloads.Priority.User)
    }

    /** A recording for the player and the frame reader: what is here at once, the rest a range at a time as they ask. */
    fun video(ref: MediaRef): MediaDataSource = MediaStream(library.downloads, id(ref), source(ref))

    companion object {
        /** An attachment of [agentId]'s conversation in the library: the sender keeps its own bytes there as they go. */
        fun attachmentId(agentId: String, attachment: String): String = "attachment/$agentId/$attachment"
    }

    private fun kind(item: MediaItem): MediaAutoDownload.Kind = when {
        item.kind == "video" -> MediaAutoDownload.Kind.Videos
        item.isVisual -> MediaAutoDownload.Kind.Photos
        else -> MediaAutoDownload.Kind.Files
    }
}
