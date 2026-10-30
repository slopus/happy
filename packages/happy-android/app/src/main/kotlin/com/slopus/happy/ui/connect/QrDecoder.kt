package com.slopus.happy.ui.connect

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer

/**
 * ZXing's QR reader over a camera frame's luminance (the Y plane of
 * YUV_420_888, one byte per pixel, rows [rowStride] apart). QR codes only;
 * light-on-dark codes are read too. Not thread-safe: one per analyzer.
 */
class QrDecoder {
    private val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.ALSO_INVERTED to true,
            ),
        )
    }

    /** The code's text, or null when the frame holds no readable QR code. */
    fun decode(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? {
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
        return try {
            reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: ReaderException) {
            null
        } finally {
            reader.reset()
        }
    }
}

/**
 * Decodes each camera frame until one holds a QR code, then hands its text
 * to [onDecoded] once (on the analysis thread) and ignores later frames.
 */
class QrAnalyzer(private val onDecoded: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val decoder = QrDecoder()
    private var luminance = ByteArray(0)

    @Volatile
    private var decoded = false

    override fun analyze(image: ImageProxy) {
        image.use {
            if (decoded) return
            val plane = image.planes[0]
            val buffer = plane.buffer.duplicate().apply { rewind() }
            if (luminance.size != buffer.remaining()) luminance = ByteArray(buffer.remaining())
            buffer.get(luminance)
            val text = decoder.decode(luminance, plane.rowStride, image.width, image.height) ?: return
            decoded = true
            onDecoded(text)
        }
    }
}
