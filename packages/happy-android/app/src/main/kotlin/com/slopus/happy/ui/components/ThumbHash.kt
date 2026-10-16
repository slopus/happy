package com.slopus.happy.ui.components

import android.graphics.Bitmap
import android.util.Base64
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A decoded ThumbHash: [width] × [height] pixels, row by row, RGBA not premultiplied. */
class ThumbHashImage(val width: Int, val height: Int, val rgba: ByteArray)

/**
 * The ThumbHash decoder happy-app draws placeholders with on Android:
 * expo-image's `ThumbhashDecoder.thumbHashToRGBA` (evanw/thumbhash's Java
 * port), in Float and rounding each channel. The JS reference
 * (thumbhash.js, which only web uses) computes in Double and truncates, so
 * its bytes can be one lower.
 */
object ThumbHash {
    /** The image a hash describes, at most 32 on its long side. Throws on a hash too short for its own header. */
    fun decode(hash: ByteArray): ThumbHashImage {
        val header24 = (hash[0].toInt() and 255) or ((hash[1].toInt() and 255) shl 8) or ((hash[2].toInt() and 255) shl 16)
        val header16 = (hash[3].toInt() and 255) or ((hash[4].toInt() and 255) shl 8)
        val lDc = (header24 and 63).toFloat() / 63.0f
        val pDc = (header24 shr 6 and 63).toFloat() / 31.5f - 1.0f
        val qDc = (header24 shr 12 and 63).toFloat() / 31.5f - 1.0f
        val lScale = (header24 shr 18 and 31).toFloat() / 31.0f
        val hasAlpha = header24 shr 23 != 0
        val pScale = (header16 shr 3 and 63).toFloat() / 63.0f
        val qScale = (header16 shr 9 and 63).toFloat() / 63.0f
        val isLandscape = header16 shr 15 != 0
        val lx = max(3, if (isLandscape) (if (hasAlpha) 5 else 7) else header16 and 7)
        val ly = max(3, if (isLandscape) header16 and 7 else if (hasAlpha) 5 else 7)
        val aDc = if (hasAlpha) (hash[5].toInt() and 15).toFloat() / 15.0f else 1.0f
        val aScale = (hash[5].toInt() shr 4 and 15).toFloat() / 15.0f

        // The varying factors; colour boosted 1.25x to make up for quantization.
        val acStart = if (hasAlpha) 6 else 5
        var acIndex = 0
        fun channel(nx: Int, ny: Int, scale: Float): FloatArray {
            val ac = ArrayList<Float>()
            for (cy in 0 until ny) {
                var cx = if (cy > 0) 0 else 1
                while (cx * ny < nx * (ny - cy)) {
                    val data = hash[acStart + (acIndex shr 1)].toInt() shr ((acIndex and 1) shl 2)
                    ac.add(((data and 15).toFloat() / 7.5f - 1.0f) * scale)
                    acIndex++
                    cx++
                }
            }
            return ac.toFloatArray()
        }
        val lAc = channel(lx, ly, lScale)
        val pAc = channel(3, 3, pScale * 1.25f)
        val qAc = channel(3, 3, qScale * 1.25f)
        val aAc = if (hasAlpha) channel(5, 5, aScale) else null

        val ratio = approximateAspectRatio(hash)
        val w = (if (ratio > 1.0f) 32.0f else 32.0f * ratio).roundToInt()
        val h = (if (ratio > 1.0f) 32.0f / ratio else 32.0f).roundToInt()
        val rgba = ByteArray(w * h * 4)
        val fx = FloatArray(max(lx, if (hasAlpha) 5 else 3))
        val fy = FloatArray(max(ly, if (hasAlpha) 5 else 3))
        var i = 0
        for (y in 0 until h) {
            for (x in 0 until w) {
                var l = lDc
                var p = pDc
                var q = qDc
                var a = aDc
                for (cx in fx.indices) fx[cx] = cos(Math.PI / w * (x + 0.5f) * cx).toFloat()
                for (cy in fy.indices) fy[cy] = cos(Math.PI / h * (y + 0.5f) * cy).toFloat()

                var j = 0
                for (cy in 0 until ly) {
                    val fy2 = fy[cy] * 2.0f
                    var cx = if (cy > 0) 0 else 1
                    while (cx * ly < lx * (ly - cy)) {
                        l += lAc[j] * fx[cx] * fy2
                        cx++
                        j++
                    }
                }
                j = 0
                for (cy in 0 until 3) {
                    val fy2 = fy[cy] * 2.0f
                    for (cx in (if (cy > 0) 0 else 1) until 3 - cy) {
                        val f = fx[cx] * fy2
                        p += pAc[j] * f
                        q += qAc[j] * f
                        j++
                    }
                }
                if (aAc != null) {
                    j = 0
                    for (cy in 0 until 5) {
                        val fy2 = fy[cy] * 2.0f
                        for (cx in (if (cy > 0) 0 else 1) until 5 - cy) {
                            a += aAc[j] * fx[cx] * fy2
                            j++
                        }
                    }
                }

                val b = l - 2.0f / 3.0f * p
                val r = (3.0f * l - b + q) / 2.0f
                val g = r - q
                rgba[i] = channelByte(r)
                rgba[i + 1] = channelByte(g)
                rgba[i + 2] = channelByte(b)
                rgba[i + 3] = channelByte(a)
                i += 4
            }
        }
        return ThumbHashImage(w, h, rgba)
    }

    /** A base64 hash (as the server stores it) decoded, or null when it isn't one or describes no pixels. */
    fun decode(base64: String): ThumbHashImage? = try {
        decode(Base64.decode(base64, Base64.DEFAULT)).takeIf { it.width > 0 && it.height > 0 }
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: IndexOutOfBoundsException) {
        null
    }

    /** Width over height of the hashed image, from the counts of its luminance factors. */
    fun approximateAspectRatio(hash: ByteArray): Float {
        val header = hash[3].toInt()
        val hasAlpha = hash[2].toInt() and 0x80 != 0
        val isLandscape = hash[4].toInt() and 0x80 != 0
        val lx = if (isLandscape) (if (hasAlpha) 5 else 7) else header and 7
        val ly = if (isLandscape) header and 7 else if (hasAlpha) 5 else 7
        return lx.toFloat() / ly.toFloat()
    }

    /** Math.round, as expo's decoder stores each channel. */
    private fun channelByte(value: Float): Byte = max(0, Math.round(255.0f * min(1f, value))).toByte()

    fun toBitmap(image: ThumbHashImage): Bitmap {
        val pixels = IntArray(image.width * image.height) { n ->
            val o = n * 4
            val rgba = image.rgba
            ((rgba[o + 3].toInt() and 255) shl 24) or ((rgba[o].toInt() and 255) shl 16) or
                ((rgba[o + 1].toInt() and 255) shl 8) or (rgba[o + 2].toInt() and 255)
        }
        return Bitmap.createBitmap(pixels, image.width, image.height, Bitmap.Config.ARGB_8888)
    }
}

private val thumbHashCache = LruCache<String, ImageBitmap>(128)

/**
 * The placeholder a picture's [hash] describes, decoded off the main thread
 * and kept by hash; null for no hash, one that doesn't decode, and until
 * it lands.
 */
@Composable
fun rememberThumbHash(hash: String?): ImageBitmap? {
    if (hash.isNullOrEmpty()) return null
    var image by remember(hash) { mutableStateOf(thumbHashCache.get(hash)) }
    if (image == null) {
        LaunchedEffect(hash) {
            image = withContext(Dispatchers.Default) {
                ThumbHash.decode(hash)?.let { ThumbHash.toBitmap(it).asImageBitmap() }?.also { thumbHashCache.put(hash, it) }
            }
        }
    }
    return image
}
