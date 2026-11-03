package com.slopus.happy.ui.artifacts

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.LruCache
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.exifinterface.media.ExifInterface
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.artifacts.ArtifactSummary
import com.slopus.happy.ui.cards.CardListSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream

/**
 * The artifacts list's small pictures (iOS's `ArtifactThumbnails`): each
 * image or recording entry read once through the artifact viewer's own
 * media ([ArtifactMedia]), decoded at the tile's size off the main thread
 * and kept for the screen (300). Four read at a time, so a fling doesn't
 * queue the whole catalog on the agent connection.
 */
class ArtifactThumbnails(private val files: ArtifactClient, private val scope: CoroutineScope) {
    private val images = LruCache<String, ImageBitmap>(300)
    private val loading = HashMap<String, Deferred<ImageBitmap?>>()
    private val gate = Semaphore(4)

    fun cached(artifact: ArtifactSummary): ImageBitmap? = images.get(key(artifact))

    /** [artifact]'s picture at [pixels] square, read once however many rows ask. Call on the main thread. */
    suspend fun load(artifact: ArtifactSummary, pixels: Int): ImageBitmap? {
        val key = key(artifact)
        images.get(key)?.let { return it }
        val entry = artifact.entry ?: return null
        val running = loading[key] ?: scope.async {
            try {
                gate.withPermit { read(artifact, entry, pixels) }?.asImageBitmap()?.also { images.put(key, it) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }.also { loading[key] = it }
        return try {
            running.await()
        } finally {
            if (loading[key] === running && running.isCompleted) loading.remove(key)
        }
    }

    private suspend fun read(artifact: ArtifactSummary, entry: com.slopus.happy.artifacts.ArtifactFile, pixels: Int): Bitmap? {
        val media = ArtifactMedia(files, artifact.id, artifact.latestVersion) { null }
        try {
            val item = media.media(entry, entry.name)
            if (item.isVideo) return media.poster(item.key, pixels * 2)
            val bytes = media.data(item.key) ?: return null
            return withContext(Dispatchers.Default) { decodeThumbnail(bytes, pixels) }
        } finally {
            media.close()
        }
    }

    companion object {
        /** A row's thumbnail is its version's entry. */
        fun key(artifact: ArtifactSummary) = "${artifact.id}/${artifact.latestVersion}"
    }
}

/**
 * [bytes] decoded upright, sampled down by powers of two while its short
 * side stays at least [pixels]; null when it isn't a picture.
 */
internal fun decodeThumbnail(bytes: ByteArray, pixels: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= pixels) sample *= 2
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val degrees = try {
        ExifInterface(ByteArrayInputStream(bytes)).rotationDegrees
    } catch (_: Exception) {
        0
    }
    if (degrees == 0) return bitmap
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
}

/**
 * A row's picture over its kind's tile, which shows until it arrives; it
 * fades in over 0.2 s, or shows at once when the screen already holds it.
 */
@Composable
internal fun ArtifactThumbnail(artifact: ArtifactSummary, thumbnails: ArtifactThumbnails) {
    val pixels = with(LocalDensity.current) { CardListSpec.tile.roundToPx() }
    val held = remember(artifact.id, artifact.latestVersion) { thumbnails.cached(artifact) }
    var image by remember(artifact.id, artifact.latestVersion) { mutableStateOf(held) }
    val alpha = remember(artifact.id, artifact.latestVersion) { Animatable(if (held != null) 1f else 0f) }
    LaunchedEffect(artifact.id, artifact.latestVersion) {
        if (image != null) return@LaunchedEffect
        image = thumbnails.load(artifact, pixels) ?: return@LaunchedEffect
        alpha.animateTo(1f, tween(ArtifactListSpec.THUMBNAIL_FADE_MS))
    }
    image?.let {
        Image(
            it,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer { this.alpha = alpha.value }
                .clip(RoundedCornerShape(CardListSpec.tileRadius))
                .testTag(ArtifactsTags.THUMBNAIL),
        )
    }
}
