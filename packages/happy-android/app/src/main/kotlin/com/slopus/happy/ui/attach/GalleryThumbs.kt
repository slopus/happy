package com.slopus.happy.ui.attach

import android.content.ContentResolver
import android.content.ContentUris
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import coil3.ImageLoader
import coil3.BitmapImage
import coil3.asImage
import coil3.decode.DataSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.ImageFetchResult
import coil3.key.Keyer
import coil3.request.Options
import coil3.size.pxOrElse
import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * A gallery item's thumbnail, for the grid: the system's own (MediaStore's
 * thumbnail cache), which is fast and gives a video its frame, rather than
 * decoding the full picture. Loaded by [GalleryThumbFetcher] through the
 * app's image loader, so it is memory-cached like every other picture.
 */
data class GalleryThumb(val uri: String, val isVideo: Boolean)

/** Loads a [GalleryThumb] at the size it is drawn, through ContentResolver.loadThumbnail (API 29) or the old MediaStore thumbnails. */
class GalleryThumbFetcher(private val thumb: GalleryThumb, private val options: Options) : Fetcher {
    override suspend fun fetch(): FetchResult {
        val resolver = options.context.contentResolver
        val uri = Uri.parse(thumb.uri)
        val width = options.size.width.pxOrElse { DEFAULT_PX }.coerceAtLeast(1)
        val height = options.size.height.pxOrElse { DEFAULT_PX }.coerceAtLeast(1)
        val bitmap: Bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            resolver.loadThumbnail(uri, Size(width, height), null)
        } else {
            @Suppress("DEPRECATION")
            val id = ContentUris.parseId(uri)
            @Suppress("DEPRECATION")
            if (thumb.isVideo) {
                MediaStore.Video.Thumbnails.getThumbnail(resolver, id, MediaStore.Video.Thumbnails.MINI_KIND, null)
            } else {
                MediaStore.Images.Thumbnails.getThumbnail(resolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null)
            } ?: throw IOException("No thumbnail")
        }
        return ImageFetchResult(bitmap.asImage(), isSampled = true, dataSource = DataSource.DISK)
    }

    class Factory : Fetcher.Factory<GalleryThumb> {
        override fun create(data: GalleryThumb, options: Options, imageLoader: ImageLoader): Fetcher = GalleryThumbFetcher(data, options)
    }

    /** One memory-cache entry per item; Coil adds the size. */
    class Key : Keyer<GalleryThumb> {
        override fun key(data: GalleryThumb, options: Options): String = "thumb:${data.uri}"
    }

    private companion object {
        const val DEFAULT_PX = 256
    }
}

/** The longer side of the thumbnail a photo goes as while it is read ([galleryThumbnail]). */
private const val PENDING_PX = 512

/**
 * A gallery photo's system thumbnail as a JPEG, upright and of the photo's
 * shape, to stand in for it while it is read; null when the system has
 * none (a pick from elsewhere), so it is read before it goes.
 */
fun galleryThumbnail(resolver: ContentResolver, uri: String): ByteArray? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !uri.startsWith("content://media/")) return null
    val bitmap = try {
        resolver.loadThumbnail(Uri.parse(uri), Size(PENDING_PX, PENDING_PX), null)
    } catch (e: IOException) {
        return null
    } catch (e: SecurityException) {
        return null
    }
    return try {
        ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
    } finally {
        bitmap.recycle()
    }
}

/** The grid's thumbnail of [uri] if the loader still holds it, at whatever size it was drawn. */
fun galleryThumbBitmap(loader: ImageLoader, uri: String): Bitmap? {
    val cache = loader.memoryCache ?: return null
    val key = cache.keys.firstOrNull { it.key == "thumb:$uri" } ?: return null
    return (cache[key]?.image as? BitmapImage)?.bitmap
}
