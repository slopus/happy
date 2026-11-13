package com.slopus.happy.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.IOException
import java.io.InputStream
import kotlin.math.max
import kotlin.math.floor
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
    fun normalize(open: () -> InputStream, fileName: String?, outputDir: File, now: Long = System.currentTimeMillis(), cropRatio: Double? = null): NormalizedImage {
        val output = decode(open, cropRatio)
        val width = output.width
        val height = output.height
        val file = File(outputDir, "attachment_${now}_${(Math.random() * 1e9).toLong()}.jpg")
        try {
            file.outputStream().use { if (!output.compress(Bitmap.CompressFormat.JPEG, ATTACHMENT_JPEG_QUALITY, it)) throw IOException("JPEG encode failed") }
        } finally {
            output.recycle()
        }
        val size = file.length()
        if (size <= 0) throw IOException("Could not determine normalized image size")
        return NormalizedImage(file, width, height, size, withJpegExtension(fileName, now))
    }

    /** The upload-sized, upright pixels, also used by the editor before its final JPEG encode. Caller owns the bitmap. */
    fun decode(open: () -> InputStream, cropRatio: Double? = null): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("Not an image")
        val orientation = try {
            open().use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        } catch (_: IOException) {
            ExifInterface.ORIENTATION_NORMAL
        }

        // Cut before downsizing: a4032×3024 square keeps3024px, not2304px.
        val boundsCrop = cropRect(bounds.outWidth, bounds.outHeight, cropRatio)
        val longEdge = max(boundsCrop.width(), boundsCrop.height())
        var sample = 1
        while (longEdge / (sample * 2) >= ATTACHMENT_MAX_DIMENSION) sample *= 2
        val decoded = open().use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
            ?: throw IOException("Not an image")

        val crop = cropRect(decoded.width, decoded.height, cropRatio)
        val (width, height) = targetSize(crop.width(), crop.height())
        val matrix = Matrix().apply {
            postScale(width.toFloat() / crop.width(), height.toFloat() / crop.height())
            applyOrientation(orientation)
        }
        val output = if (matrix.isIdentity && crop.width() == decoded.width && crop.height() == decoded.height) {
            decoded
        } else {
            Bitmap.createBitmap(decoded, crop.left, crop.top, crop.width(), crop.height(), matrix, true)
        }
        if (output !== decoded) decoded.recycle()
        return output
    }

    /** CameraCrop.rect: centred, ratio=long/short, independent of EXIF orientation. */
    internal fun cropRect(width: Int, height: Int, ratio: Double?): Rect {
        if (ratio == null || !ratio.isFinite() || ratio < 1 || width <= 0 || height <= 0) return Rect(0, 0, width, height)
        val long = max(width, height)
        val short = minOf(width, height)
        val cutLong = minOf(long, floor(short * ratio).toInt()).coerceAtLeast(1)
        val cutShort = minOf(short, floor(long / ratio).toInt()).coerceAtLeast(1)
        val w = if (width >= height) cutLong else cutShort
        val h = if (width >= height) cutShort else cutLong
        val x = (width - w) / 2
        val y = (height - h) / 2
        return Rect(x, y, x + w, y + h)
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

    internal fun Matrix.applyOrientation(orientation: Int) {
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
