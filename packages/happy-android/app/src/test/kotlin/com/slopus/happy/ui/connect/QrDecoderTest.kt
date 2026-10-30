package com.slopus.happy.ui.connect

import android.graphics.Rect
import android.media.Image
import androidx.camera.core.ImageInfo
import androidx.camera.core.ImageProxy
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The scanner's decoding: camera luminance in, the code's text out. */
@RunWith(AndroidJUnit4::class)
class QrDecoderTest {
    private val link = "happy://terminal?bm9wZS1ub3QtYS1yZWFsLWtleS1qdXN0LWEtdGVzdA"

    /** A [width] × [height] Y plane, rows [rowStride] apart, with [text]'s code drawn at (left, top). */
    private fun frame(
        text: String?,
        width: Int = 640,
        height: Int = 480,
        rowStride: Int = width,
        left: Int = 170,
        top: Int = 90,
        inverted: Boolean = false,
    ): ByteArray {
        val light = (if (inverted) 25 else 210).toByte()
        val dark = (if (inverted) 225 else 30).toByte()
        // A camera's Y plane: the last row stops at the image's width.
        val bytes = ByteArray(rowStride * (height - 1) + width) { if (it % rowStride < width) light else 0 }
        if (text != null) {
            val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 300, 300, mapOf(EncodeHintType.MARGIN to 1))
            for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
                if (matrix[x, y]) bytes[(top + y) * rowStride + left + x] = dark
            }
        }
        return bytes
    }

    @Test
    fun aFrameWithACodeDecodesToItsText() {
        assertEquals(link, QrDecoder().decode(frame(link), 640, 640, 480))
    }

    @Test
    fun paddedRowsDecode() {
        assertEquals(link, QrDecoder().decode(frame(link, rowStride = 704), 704, 640, 480))
    }

    @Test
    fun aLightOnDarkCodeDecodes() {
        assertEquals(link, QrDecoder().decode(frame(link, inverted = true), 640, 640, 480))
    }

    @Test
    fun aFrameWithoutACodeIsNull() {
        val decoder = QrDecoder()
        assertNull(decoder.decode(frame(null), 640, 640, 480))
        // The reader is reset between frames.
        assertEquals(link, decoder.decode(frame(link), 640, 640, 480))
    }

    @Test
    fun theAnalyzerHandsOverTheFirstCodeOnceAndClosesEveryFrame() {
        val decoded = mutableListOf<String>()
        val analyzer = QrAnalyzer { decoded += it }
        val frames = listOf(
            FakeImage(frame(null), 640, 640, 480),
            FakeImage(frame(link, rowStride = 768), 768, 640, 480),
            FakeImage(frame("happy://direct?other"), 640, 640, 480),
        )
        frames.forEach(analyzer::analyze)
        assertEquals(listOf(link), decoded)
        assertTrue(frames.all { it.closed })
    }

    private class FakeImage(bytes: ByteArray, private val stride: Int, private val w: Int, private val h: Int) : ImageProxy {
        var closed = false
        private val plane = object : ImageProxy.PlaneProxy {
            private val buffer = ByteBuffer.wrap(bytes)
            override fun getRowStride() = stride
            override fun getPixelStride() = 1
            override fun getBuffer(): ByteBuffer = buffer
        }

        override fun close() {
            closed = true
        }

        override fun getCropRect() = Rect(0, 0, w, h)
        override fun setCropRect(rect: Rect?) = Unit
        override fun getFormat() = android.graphics.ImageFormat.YUV_420_888
        override fun getHeight() = h
        override fun getWidth() = w
        override fun getPlanes(): Array<ImageProxy.PlaneProxy> = arrayOf(plane)
        override fun getImageInfo(): ImageInfo = throw UnsupportedOperationException()
        override fun getImage(): Image? = null
    }
}
