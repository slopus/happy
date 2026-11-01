package com.slopus.happy.conversation

import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream

/**
 * A picture a message carries, read from its base64: its bytes (null when
 * they don't read) and its shape from their header. The row builder reads
 * each on the conversation's lane as it makes the row, so the row, on the
 * main thread, finds it read and lays the tile out in its own shape from
 * the first frame without decoding anything there. One the cache has let go
 * of is read again where it is asked for.
 */
class InlinePicture private constructor(val bytes: ByteArray?, val size: MediaFlow.Image) {
    companion object {
        /** The bytes kept read, about as many as a long chat's pictures on screen and around it. */
        private const val CACHE_BYTES = 24 * 1024 * 1024

        private val read = object : LruCache<Block.Image, InlinePicture>(CACHE_BYTES) {
            override fun sizeOf(key: Block.Image, value: InlinePicture) = (value.bytes?.size ?: 0) + key.data.length
        }

        fun of(image: Block.Image): InlinePicture = read.get(image) ?: run {
            val bytes = try {
                Base64.decode(image.data, Base64.DEFAULT)
            } catch (_: IllegalArgumentException) {
                null
            }
            InlinePicture(bytes, bytes?.let(::pictureSize) ?: MediaFlow.Image()).also { read.put(image, it) }
        }
    }
}

/**
 * A picture's upright pixel size, read from its header alone (iOS's
 * `ChatPlanner.pictureSize`): EXIF orientations 5 to 8 turn it on its side,
 * as the image loader will. An unreadable header knows nothing, and the
 * flow falls back to 4:3.
 */
internal fun pictureSize(bytes: ByteArray): MediaFlow.Image {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    val width = options.outWidth
    val height = options.outHeight
    if (width <= 0 || height <= 0) return MediaFlow.Image()
    val orientation = try {
        ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (_: Exception) {
        ExifInterface.ORIENTATION_NORMAL
    }
    val turned = orientation in ExifInterface.ORIENTATION_TRANSPOSE..ExifInterface.ORIENTATION_ROTATE_270
    return if (turned) MediaFlow.Image(height.toFloat(), width.toFloat()) else MediaFlow.Image(width.toFloat(), height.toFloat())
}
