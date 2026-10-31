package com.slopus.happy.attachments

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/** One photo or video of the phone's gallery, newest first. */
data class GalleryItem(
    val id: Long,
    val uri: String,
    val isVideo: Boolean,
    val mimeType: String,
    val name: String,
    val size: Long,
    val width: Int,
    val height: Int,
    val durationMs: Long,
) {
    fun picked(): PickedMedia = PickedMedia(
        uri = uri,
        kind = if (isVideo) PickedKind.Video else PickedKind.Photo,
        name = name,
        mimeType = mimeType,
        size = size,
        width = width,
        height = height,
        durationMs = durationMs,
    )
}

/**
 * How much of the gallery the app may read. Android 14 lets a person give
 * only some photos and videos ([Partial]): those are listed, with a way to
 * pick more.
 */
enum class GalleryAccess {
    Full,
    Partial,
    None;

    companion object {
        /** What [context] may read now. */
        fun of(context: Context, sdk: Int = Build.VERSION.SDK_INT): GalleryAccess {
            fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
            return when {
                sdk >= Build.VERSION_CODES.TIRAMISU && granted(Manifest.permission.READ_MEDIA_IMAGES) && granted(Manifest.permission.READ_MEDIA_VIDEO) -> Full
                sdk >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> Partial
                // Android 13 asked for the two separately: either one lists what it covers.
                sdk >= Build.VERSION_CODES.TIRAMISU && (granted(Manifest.permission.READ_MEDIA_IMAGES) || granted(Manifest.permission.READ_MEDIA_VIDEO)) -> Partial
                sdk < Build.VERSION_CODES.TIRAMISU && granted(Manifest.permission.READ_EXTERNAL_STORAGE) -> Full
                else -> None
            }
        }

        /**
         * What to ask for (Telegram's `requestGalleryPermission`): images and
         * videos, and on Android 14 the partial grant too, so the system
         * offers "Select photos and videos".
         */
        fun permissions(sdk: Int = Build.VERSION.SDK_INT): Array<String> = when {
            sdk >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            )
            sdk >= Build.VERSION_CODES.TIRAMISU -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
            else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }
}

/**
 * The phone's photos and videos from MediaStore, newest first (Telegram's
 * "Recents", `MediaController.loadGalleryPhotosAlbums`), as far as the
 * granted access reaches.
 */
class MediaGallery(private val resolver: ContentResolver) {

    /** Up to [limit] items, videos only when [videos]. Empty when nothing can be read. */
    fun load(videos: Boolean, photos: Boolean = true, limit: Int = MAX_ITEMS): List<GalleryItem> {
        if (!videos && !photos) return emptyList()
        val types = buildList {
            if (photos) add(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE)
            if (videos) add(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO)
        }
        val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (${types.joinToString(",")})" +
            " AND ${MediaStore.MediaColumns.SIZE} > 0"
        val projection = buildList {
            add(MediaStore.MediaColumns._ID)
            add(MediaStore.Files.FileColumns.MEDIA_TYPE)
            add(MediaStore.MediaColumns.MIME_TYPE)
            add(MediaStore.MediaColumns.DISPLAY_NAME)
            add(MediaStore.MediaColumns.SIZE)
            add(MediaStore.MediaColumns.WIDTH)
            add(MediaStore.MediaColumns.HEIGHT)
            add(DURATION)
            add(MediaStore.MediaColumns.DATE_ADDED)
        }.toTypedArray()
        val cursor = try {
            resolver.query(
                MediaStore.Files.getContentUri("external"),
                projection,
                selection,
                null,
                "${MediaStore.MediaColumns.DATE_ADDED} DESC, ${MediaStore.MediaColumns._ID} DESC",
            )
        } catch (_: SecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        } ?: return emptyList()
        return cursor.use { read(it, limit) }
    }

    private fun read(cursor: Cursor, limit: Int): List<GalleryItem> {
        val items = ArrayList<GalleryItem>(minOf(cursor.count, limit))
        val id = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
        val type = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
        val mime = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
        val name = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
        val size = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
        val width = cursor.getColumnIndex(MediaStore.MediaColumns.WIDTH)
        val height = cursor.getColumnIndex(MediaStore.MediaColumns.HEIGHT)
        val duration = cursor.getColumnIndex(DURATION)
        while (cursor.moveToNext() && items.size < limit) {
            val video = cursor.getInt(type) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
            val rowId = cursor.getLong(id)
            val base = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            items += GalleryItem(
                id = rowId,
                uri = ContentUris.withAppendedId(base, rowId).toString(),
                isVideo = video,
                mimeType = cursor.getString(mime) ?: if (video) "video/mp4" else "image/jpeg",
                name = cursor.getString(name) ?: rowId.toString(),
                size = cursor.getLong(size),
                width = if (width >= 0) cursor.getInt(width) else 0,
                height = if (height >= 0) cursor.getInt(height) else 0,
                durationMs = if (duration >= 0) cursor.getLong(duration) else 0,
            )
        }
        return items
    }

    /** A tick each time the gallery changes (a photo taken while the sheet is up). */
    fun changes(): Flow<Unit> = callbackFlow {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                trySend(Unit)
            }
        }
        val uri: Uri = MediaStore.Files.getContentUri("external")
        try {
            resolver.registerContentObserver(uri, true, observer)
        } catch (_: SecurityException) {
        }
        awaitClose { resolver.unregisterContentObserver(observer) }
    }

    companion object {
        /** How far back the grid reaches; older photos are a Browse away. */
        const val MAX_ITEMS = 3000

        /** `MediaColumns.DURATION`, also present on the files table before API 29. */
        private const val DURATION = "duration"
    }
}
