package com.slopus.happy.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.IOException
import java.io.InputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** useImagePicker.ts limits. */
const val MAX_IMAGES_PER_MESSAGE = 20
const val MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024
const val ATTACHMENT_MAX_DIMENSION = 3072
const val ATTACHMENT_JPEG_QUALITY = 92

/** encryptBlob adds a 24-byte nonce and a 16-byte tag; the encrypted blob must fit the server's 10 MB. */
const val MAX_NORMALIZED_FILE_SIZE = MAX_IMAGE_FILE_SIZE - 40

/** A picked or pasted image, re-encoded for upload. */
data class NormalizedImage(val file: File, val width: Int, val height: Int, val size: Long, val name: String) {
    val mimeType: String get() = "image/jpeg"
}

/**
 * useImagePicker.ts normalizePickedAssetForUpload (its iOS path, which this
 * app uses everywhere): upright, the long edge at most 3072 with the aspect
 * kept, JPEG at quality 0.92, named `<stem>.jpg`, measured on disk.
 * Orientation is read with androidx's ExifInterface, as expo-image-picker
 * and expo-image-manipulator read it: JPEG, PNG, WebP, HEIF and raw
 * formats alike.
 */
object ImageNormalizer {
    /**
     * [open] is called more than once (bounds, orientation, pixels). Throws
     * [IOException] when the bytes aren't an image.
     */
    fun normalize(open: () -> InputStream, fileName: String?, outputDir: File, now: Long = System.currentTimeMillis()): NormalizedImage {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("Not an image")
        val orientation = try {
            open().use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        } catch (_: IOException) {
            ExifInterface.ORIENTATION_NORMAL
        }

        val longEdge = max(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (longEdge / (sample * 2) >= ATTACHMENT_MAX_DIMENSION) sample *= 2
        val decoded = open().use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
            ?: throw IOException("Not an image")

        val (width, height) = targetSize(decoded.width, decoded.height)
        val matrix = Matrix().apply {
            postScale(width.toFloat() / decoded.width, height.toFloat() / decoded.height)
            applyOrientation(orientation)
        }
        val output = if (matrix.isIdentity) {
            decoded
        } else {
            Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
        }
        val file = File(outputDir, "attachment_${now}_${(Math.random() * 1e9).toLong()}.jpg")
        file.outputStream().use { if (!output.compress(Bitmap.CompressFormat.JPEG, ATTACHMENT_JPEG_QUALITY, it)) throw IOException("JPEG encode failed") }
        if (output !== decoded) output.recycle()
        decoded.recycle()
        val size = file.length()
        if (size <= 0) throw IOException("Could not determine normalized image size")
        return NormalizedImage(file, outputWidth(width, height, orientation), outputHeight(width, height, orientation), size, withJpegExtension(fileName, now))
    }

    /** manipulateAsync's resize by the long edge alone: aspect kept, rounded; nothing when already within 3072. */
    fun targetSize(width: Int, height: Int): Pair<Int, Int> {
        if (max(width, height) <= ATTACHMENT_MAX_DIMENSION) return width to height
        return if (width >= height) {
            ATTACHMENT_MAX_DIMENSION to (height.toDouble() * ATTACHMENT_MAX_DIMENSION / width).roundToInt()
        } else {
            (width.toDouble() * ATTACHMENT_MAX_DIMENSION / height).roundToInt() to ATTACHMENT_MAX_DIMENSION
        }
    }

    /** withJpegExtension: the name's stem with `.jpg`, or `image_<ms>.jpg`. */
    fun withJpegExtension(fileName: String?, now: Long = System.currentTimeMillis()): String {
        val name = fileName?.trim()?.ifEmpty { null } ?: "image_$now.jpg"
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        return "$stem.jpg"
    }

    private fun swaps(orientation: Int) = orientation in setOf(
        ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_ROTATE_270,
        ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_TRANSVERSE,
    )

    private fun outputWidth(width: Int, height: Int, orientation: Int) = if (swaps(orientation)) height else width
    private fun outputHeight(width: Int, height: Int, orientation: Int) = if (swaps(orientation)) width else height

    private fun Matrix.applyOrientation(orientation: Int) {
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { postRotate(90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { postRotate(-90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(-90f)
        }
    }
}
