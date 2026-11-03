package com.slopus.happy.artifacts

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaDataSource
import android.util.Base64
import android.util.LruCache
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.mutableStateMapOf
import androidx.exifinterface.media.ExifInterface
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.browser.BrowserFetcher
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.media.MediaDownloads
import com.slopus.happy.media.MediaError
import com.slopus.happy.media.MediaLibrary
import com.slopus.happy.media.MediaPiece
import com.slopus.happy.media.MediaSource
import com.slopus.happy.media.MediaStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** One picture or recording as the screens draw it, by [key]. */
@Immutable
data class ArtifactMediaItem(val key: String, val isVideo: Boolean, val label: String)

/**
 * One artifact version's pictures and recordings, by key (iOS's
 * `ArtifactMedia`): its own files read through the file route over the
 * agent connection, a range at a time; an http(s) picture a document links
 * to through the computer's network ([BrowserFetcher]), never the phone's;
 * a `data:` picture from what it says. Bytes are kept while memory allows.
 * A recording plays and is measured through [videoSource], whose ranges the
 * daemon answers with `206`, so nothing reads the whole file to start.
 *
 * Sizes and lengths land in [sizes] and [durations], snapshot state, so the
 * screens lay out again as they arrive.
 *
 * Given the connection's [library], the version's own files are read into
 * it once and kept (iOS ba7b68346): a numbered version never changes, so
 * what was read, or played, is there next time, and a tile's ring follows it.
 */
class ArtifactMedia(
    private val files: ArtifactClient,
    val artifactId: String,
    val version: Int,
    private val library: MediaLibrary? = null,
    private val fetcher: () -> BrowserFetcher?,
) {
    sealed interface Source {
        data class FileItem(val file: ArtifactFile) : Source
        data class Web(val url: String) : Source
        data class Data(val url: String) : Source
    }

    private val sources = ConcurrentHashMap<String, Source>()
    private val reading = ConcurrentHashMap<String, CompletableDeferred<ByteArray?>>()
    private val bytes = object : LruCache<String, ByteArray>(48 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }
    private var openedFetcher: BrowserFetcher? = null

    /** Upright pixel sizes, once known. */
    val sizes = mutableStateMapOf<String, Extent>()
    /** A recording's seconds, once known. */
    val durations = mutableStateMapOf<String, Double>()

    fun media(file: ArtifactFile, label: String): ArtifactMediaItem {
        val key = key(file.path)
        sources[key] = Source.FileItem(file)
        return ArtifactMediaItem(key, file.isVideo, label)
    }

    /** A picture a document links to by its address. */
    fun web(url: String, label: String): ArtifactMediaItem {
        val key = "web/$url"
        sources[key] = Source.Web(url)
        return ArtifactMediaItem(key, false, label)
    }

    fun data(url: String, label: String): ArtifactMediaItem {
        val key = "data/${url.hashCode()}"
        sources[key] = Source.Data(url)
        return ArtifactMediaItem(key, false, label)
    }

    fun source(key: String): Source? = sources[key]

    /** The item's bytes, read once however many ask; null when they can't be had. */
    suspend fun data(key: String): ByteArray? {
        bytes.get(key)?.let { return it }
        val mine = CompletableDeferred<ByteArray?>()
        val running = reading.putIfAbsent(key, mine)
        if (running != null) return running.await()
        val result = try {
            withContext(Dispatchers.IO) { read(sources[key]) }
        } catch (e: CancellationException) {
            mine.complete(null)
            reading.remove(key)
            throw e
        } catch (_: Exception) {
            null
        }
        if (result != null) bytes.put(key, result)
        mine.complete(result)
        reading.remove(key)
        return result
    }

    private suspend fun read(source: Source?): ByteArray? = when (source) {
        null -> null
        is Source.FileItem -> library?.downloads?.data(resourceId(source.file), fileSource(source.file), MediaDownloads.Priority.User)
            ?: files.bytes(artifactId, version, source.file.path)
        is Source.Web -> (openedFetcher ?: fetcher()?.also { openedFetcher = it })?.data(source.url)
        is Source.Data -> decodeDataUrl(source.url)
    }

    /**
     * The item's upright size in pixels, which a document and the grid lay
     * it out by: a picture's from its header, a recording's from its track.
     */
    suspend fun pixelSize(key: String): Extent? {
        sizes[key]?.let { return it }
        val source = sources[key]
        val size = if (source is Source.FileItem && source.file.isVideo) {
            videoInfo(key)?.first
        } else {
            data(key)?.let { withContext(Dispatchers.Default) { pictureSize(it) } }
        }
        if (size != null) sizes[key] = size
        return size
    }

    /** A recording's length in seconds. */
    suspend fun duration(key: String): Double? = durations[key] ?: videoInfo(key)?.second

    private suspend fun videoInfo(key: String): Pair<Extent?, Double?>? {
        val source = videoSource(key) ?: return null
        val info = withContext(Dispatchers.IO) { VideoProbe.read(source) } ?: return null
        info.size?.let { sizes[key] = it }
        info.seconds?.let { durations[key] = it }
        return info.size to info.seconds
    }

    /** A recording's first frame, no larger than [maxPixels] on its long side. */
    suspend fun poster(key: String, maxPixels: Int): Bitmap? {
        val source = videoSource(key) ?: return null
        return withContext(Dispatchers.IO) { VideoProbe.read(source, maxPixels)?.poster }
    }

    /** A recording's bytes as the platform's player and retriever read them: a range at a time, kept where there is a library. */
    fun videoSource(key: String): MediaDataSource? {
        val file = (sources[key] as? Source.FileItem)?.file?.takeIf { it.isVideo } ?: return null
        library?.let { return MediaStream(it.downloads, resourceId(file), fileSource(file)) }
        return RangedSource(file.size) { start, end -> runBlocking { files.file(artifactId, version, file.path, "bytes=$start-$end") } }
    }

    /** Where a version's file is kept: a numbered version never changes. */
    fun resourceId(file: ArtifactFile): String = "artifact/$artifactId/$version/${file.path}"

    /** Its bytes from the file route, a range at a time. */
    private fun fileSource(file: ArtifactFile): MediaSource = MediaSource(file.size.takeIf { it > 0 }) { span ->
        val response = try {
            files.file(artifactId, version, file.path, MediaPiece.header(span))
        } catch (e: AgentApiException) {
            // A refusal won't change by asking again; anything else might.
            if (e.status in 400..499 && e.status != 408 && e.status != 429) throw MediaError.Status(e.status)
            throw e
        }
        MediaPiece.http(response)
    }

    private fun kept(key: String): Pair<String, MediaSource>? {
        val file = (sources[key] as? Source.FileItem)?.file ?: return null
        return resourceId(file) to fileSource(file)
    }

    /** Where an own file's download is, as the board last said; null for any other item, or without a library. */
    fun phase(key: String): DownloadPhase? {
        val library = library ?: return null
        val (id, _) = kept(key) ?: return null
        return library.board.phase(id)
    }

    /** A tile shows [key]: where its download is is read from the disk, for its ring. */
    suspend fun publish(key: String) {
        val library = library ?: return
        val (id, source) = kept(key) ?: return
        library.downloads.phase(id, source)
    }

    /** A tap on its ring: pause what is going, else read it. */
    suspend fun toggle(key: String) {
        val library = library ?: return
        val (id, source) = kept(key) ?: return
        library.downloads.toggle(id, source)
    }

    /** A recording plays: the rest of it reads on behind the player, so it is kept once played. */
    suspend fun play(key: String) {
        val library = library ?: return
        val (id, source) = kept(key) ?: return
        library.downloads.download(id, source, MediaDownloads.Priority.User)
    }

    /**
     * The item as a file named as the artifact names it, for the share
     * sheet: written under [directory], which the caller's file provider shares.
     */
    suspend fun shareable(key: String, directory: File): File? {
        val source = sources[key] ?: return null
        val name = when (source) {
            is Source.FileItem -> source.file.name
            is Source.Web -> source.url.substringBefore('?').substringAfterLast('/').ifEmpty { "picture" }
            is Source.Data -> "picture." + (source.url.removePrefix("data:").substringBefore(';').substringBefore(',').substringAfter('/', "png").ifEmpty { "png" })
        }
        val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim('.', ' ').ifEmpty { "file" }.take(96)
        return withContext(Dispatchers.IO) {
            val folder = File(directory, "artifact-${artifactId.filter(Char::isLetterOrDigit)}-$version").apply { mkdirs() }
            val target = File(folder, safe)
            if (!target.canonicalPath.startsWith(directory.canonicalPath)) return@withContext null
            if (target.exists() && target.length() > 0) return@withContext target
            try {
                val library = library
                if (source is Source.FileItem && library != null) {
                    // Kept whole first, then copied out as the artifact names it.
                    val id = resourceId(source.file)
                    library.downloads.complete(id, fileSource(source.file), MediaDownloads.Priority.User)
                    library.store.completeFile(id).copyTo(target, overwrite = true)
                } else if (source is Source.FileItem) {
                    target.outputStream().use { out ->
                        ArtifactClient.read({ range -> files.file(artifactId, version, source.file.path, range?.let { "bytes=${it.first}-${it.last}" }) }) { piece, _ -> out.write(piece) }
                    }
                } else {
                    target.writeBytes(data(key) ?: return@withContext null)
                }
                target
            } catch (e: CancellationException) {
                target.delete()
                throw e
            } catch (_: Exception) {
                target.delete()
                null
            }
        }
    }

    fun close() {
        openedFetcher?.close()
        openedFetcher = null
        bytes.evictAll()
    }

    companion object {
        fun key(path: String) = "artifact/$path"

        /** Upright pixels from a picture's header: EXIF's quarter turns swap them. */
        fun pictureSize(data: ByteArray): Extent? {
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(data, 0, data.size, options)
            val width = options.outWidth
            val height = options.outHeight
            if (width <= 0 || height <= 0) return null
            val orientation = runCatching { ExifInterface(data.inputStream()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
                .getOrDefault(ExifInterface.ORIENTATION_NORMAL)
            val turned = orientation in setOf(
                ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_ROTATE_270,
                ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_TRANSVERSE,
            )
            return if (turned) Extent(height.toDouble(), width.toDouble()) else Extent(width.toDouble(), height.toDouble())
        }

        /** A `data:…;base64,` picture's bytes; anything else is null. */
        fun decodeDataUrl(url: String): ByteArray? {
            val comma = url.indexOf(',')
            if (comma < 0 || !url.substring(0, comma).endsWith(";base64")) return null
            return runCatching { Base64.decode(url.substring(comma + 1), Base64.DEFAULT) }.getOrNull()
        }
    }
}

/**
 * A file the platform's player reads by position (`MediaDataSource`), each
 * read answered from a few cached chunks fetched as `Range` requests. Reads
 * come on the player's own thread, so blocking is what it expects.
 */
class RangedSource(
    private val length: Long,
    private val fetch: (start: Long, end: Long) -> com.slopus.happy.connection.TransportResponse,
) : MediaDataSource() {
    private val chunks = object : LinkedHashMap<Long, ByteArray>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, ByteArray>?) = size > 6
    }
    @Volatile private var known: Long = length.takeIf { it > 0 } ?: -1
    @Volatile private var closed = false

    /** Not stated, the length comes from the first range's answer, read here: a player asks before it reads. */
    override fun getSize(): Long {
        if (known < 0 && !closed) readAt(0, ByteArray(1), 0, 1)
        return known
    }

    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (closed || size <= 0) return if (size == 0) 0 else -1
        if (known in 0..position) return -1
        val index = position / CHUNK
        val chunk = synchronized(chunks) { chunks[index] } ?: run {
            val start = index * CHUNK
            val end = if (known > 0) minOf(start + CHUNK, known) - 1 else start + CHUNK - 1
            val response = try {
                fetch(start, end)
            } catch (_: Exception) {
                return -1
            }
            if (response.status == 200) {
                // A server that ignores ranges answers with the whole file.
                known = response.body.size.toLong()
                synchronized(chunks) {
                    var at = 0L
                    while (at < response.body.size) {
                        chunks[at / CHUNK] = response.body.copyOfRange(at.toInt(), minOf(at + CHUNK, response.body.size.toLong()).toInt())
                        at += CHUNK
                    }
                }
                synchronized(chunks) { chunks[index] } ?: return -1
            } else {
                if (response.status != 206 || response.body.isEmpty()) return -1
                ArtifactClient.length(response.headers["content-range"])?.let { known = it }
                synchronized(chunks) { chunks[index] = response.body }
                response.body
            }
        }
        val within = (position - index * CHUNK).toInt()
        if (within >= chunk.size) return -1
        val count = minOf(size, chunk.size - within)
        System.arraycopy(chunk, within, buffer, offset, count)
        return count
    }

    override fun close() {
        closed = true
        synchronized(chunks) { chunks.clear() }
    }

    companion object {
        const val CHUNK = 1024L * 1024
    }
}
