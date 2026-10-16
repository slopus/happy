package com.slopus.happy.ui.components

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest
import java.util.Base64

/**
 * The decoder byte for byte. The digests are what expo-image 55.0.6's
 * `ThumbhashDecoder.thumbHashToRGBA` (happy-app's decoder on Android)
 * produces for these hashes; the JS reference (thumbhash 0.1.1, in
 * resources/thumbhash/js-reference.txt) truncates where expo rounds, so
 * against it every byte is equal or one higher.
 */
@RunWith(AndroidJUnit4::class)
class ThumbHashTest {
    private class Vector(val hash: String, val width: Int, val height: Int, val sha256: String)

    private val vectors = listOf(
        // Landscape, opaque.
        Vector("nvgJPJpwd3eAh4d3d4eAcAj4eA==", 32, 18, EXPO_SHA_1),
        // Portrait, with alpha.
        Vector("nviFGgxXgIWIzXeAhQioeGd3h4iAiIg=", 13, 32, EXPO_SHA_2),
        // Square, opaque.
        Vector("nggKNxpwd4eAh4d3d3d4eHeHCAiHgI8H", 32, 32, EXPO_SHA_3),
    )

    private val js: Map<String, Triple<Int, Int, ByteArray>> =
        javaClass.getResourceAsStream("/thumbhash/js-reference.txt")!!.bufferedReader().readLines().filter { it.isNotBlank() }.associate { line ->
            val (hash, w, h, rgba) = line.split(' ')
            hash to Triple(w.toInt(), h.toInt(), Base64.getDecoder().decode(rgba))
        }

    @Test
    fun matchesExpoImageByteForByte() {
        for (v in vectors) {
            val image = ThumbHash.decode(Base64.getDecoder().decode(v.hash))
            assertEquals(v.hash, v.width, image.width)
            assertEquals(v.hash, v.height, image.height)
            assertEquals(v.hash, v.sha256, sha256(image.rgba))
        }
    }

    @Test
    fun matchesTheExpoDecoderItself() {
        for (v in vectors) {
            val bytes = Base64.getDecoder().decode(v.hash)
            val expo = ExpoThumbhashOracle.thumbHashToRGBA(bytes)
            assertArrayEquals(v.hash, expo.rgba, ThumbHash.decode(bytes).rgba)
        }
    }

    @Test
    fun isTheJsReferenceRoundedInsteadOfTruncated() {
        for (v in vectors) {
            val image = ThumbHash.decode(Base64.getDecoder().decode(v.hash))
            val (w, h, rgba) = js.getValue(v.hash)
            assertEquals(w, image.width)
            assertEquals(h, image.height)
            assertEquals(rgba.size, image.rgba.size)
            var rounded = 0
            for (i in rgba.indices) {
                val diff = (image.rgba[i].toInt() and 255) - (rgba[i].toInt() and 255)
                assertTrue("${v.hash} byte $i differs by $diff", diff == 0 || diff == 1)
                if (diff != 0) rounded++
            }
            assertTrue("${v.hash}: rounding should move some bytes", rounded > 0)
        }
    }

    @Test
    fun theStoredBase64FormDecodes() {
        val image = ThumbHash.decode(vectors[0].hash)!!
        assertEquals(EXPO_SHA_1, sha256(image.rgba))
    }

    @Test
    fun garbageIsNotAHash() {
        assertNull(ThumbHash.decode("not base64!!"))
        assertNull(ThumbHash.decode("AAAA"))
        // A header with no luminance rows describes no pixels.
        assertNull(ThumbHash.decode(Base64.getEncoder().encodeToString(byteArrayOf(0, 0, 0, 0, 0x80.toByte(), 0, 0, 0))))
    }

    @Test
    fun theBitmapCarriesThePixelsUnpremultiplied() {
        val image = ThumbHash.decode(Base64.getDecoder().decode(vectors[0].hash))
        val bitmap = ThumbHash.toBitmap(image)
        assertEquals(image.width, bitmap.width)
        assertEquals(image.height, bitmap.height)
        val pixel = bitmap.getPixel(0, 0)
        val rgba = image.rgba
        assertEquals(rgba[0].toInt() and 255, pixel shr 16 and 255)
        assertEquals(rgba[1].toInt() and 255, pixel shr 8 and 255)
        assertEquals(rgba[2].toInt() and 255, pixel and 255)
        assertEquals(rgba[3].toInt() and 255, pixel ushr 24)
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private companion object {
        const val EXPO_SHA_1 = "c84b099a8794cb9ee4b37538ce0613d49d3c9b9b51ebfa2b1386201232673cec"
        const val EXPO_SHA_2 = "9efb063dfa59e77963e845628bed3f08e020bd31b104ad19e4b2817637de745b"
        const val EXPO_SHA_3 = "9a305790ef70cd4129e2e74185dfdfe5443515ff524eb09ff3c7ef61b7c0f491"
    }
}
