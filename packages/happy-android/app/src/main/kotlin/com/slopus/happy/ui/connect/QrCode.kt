package com.slopus.happy.ui.connect

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

/**
 * A QR code's modules (qrMatrix.ts): true is dark. The three 7x7 finder
 * patterns read as light, since [QrCode] draws them separately.
 */
class QrMatrix(private val bits: Array<BooleanArray>) {
    val size: Int get() = bits.size

    fun isFinder(x: Int, y: Int): Boolean =
        (x < FINDER && y < FINDER) || (x >= size - FINDER && y < FINDER) || (x < FINDER && y >= size - FINDER)

    /** getPixel: false outside the matrix and inside the finder patterns. */
    fun dark(x: Int, y: Int): Boolean {
        if (x < 0 || y < 0 || x >= size || y >= size || isFinder(x, y)) return false
        return bits[y][x]
    }

    /** The raw module, finder patterns included. */
    fun module(x: Int, y: Int): Boolean = bits[y][x]

    companion object {
        private const val FINDER = 7

        /** createQRMatrix: byte mode, the smallest version that fits, at [level]. */
        fun encode(data: String, level: ErrorCorrectionLevel = ErrorCorrectionLevel.M): QrMatrix {
            val matrix = Encoder.encode(data, level, mapOf(EncodeHintType.CHARACTER_SET to "UTF-8")).matrix
            return QrMatrix(Array(matrix.height) { y -> BooleanArray(matrix.width) { x -> matrix.get(x, y).toInt() == 1 } })
        }
    }
}

/**
 * QRCode.tsx: a [size] square with two modules of quiet zone, on a
 * background rounded by 1.5 modules. A module's corner is rounded (by
 * min(module / 3, 1% of the size)) where neither neighbouring side has a
 * dark module; modules overlap by half a dp so no seams show. The finder
 * patterns are rounded squares: a 7-module ring (outer radius 1.5, inner
 * 0.5 modules) around a 3-module eye (radius 1).
 */
@Composable
fun QrCode(
    data: String,
    size: Dp,
    modifier: Modifier = Modifier,
    foreground: Color = Color.Black,
    background: Color = Color.White,
) {
    val matrix = remember(data) { QrMatrix.encode(data) }
    Canvas(modifier = modifier.size(size).semantics { contentDescription = data }) {
        drawQr(matrix, foreground, background)
    }
}

private fun DrawScope.drawQr(matrix: QrMatrix, foreground: Color, background: Color) {
    val side = this.size.width
    val n = matrix.size
    val m = side / (n + 4)
    val half = 0.5f * density
    val cornerRadius = minOf(m / 3, side * 0.01f)

    drawPath(Path().apply { addRoundRect(RoundRect(0f, 0f, side, side, CornerRadius(m * 1.5f))) }, background)

    translate(left = m * 2, top = m * 2) {
        val modules = Path()
        for (y in 0 until n) {
            for (x in 0 until n) {
                if (!matrix.dark(x, y)) continue
                val left = !matrix.dark(x - 1, y)
                val right = !matrix.dark(x + 1, y)
                val above = !matrix.dark(x, y - 1)
                val below = !matrix.dark(x, y + 1)
                fun r(round: Boolean) = CornerRadius(if (round) cornerRadius else 0f)
                modules.addRoundRect(
                    RoundRect(
                        left = x * m - half,
                        top = y * m - half,
                        right = x * m + m + half,
                        bottom = y * m + m + half,
                        topLeftCornerRadius = r(left && above),
                        topRightCornerRadius = r(right && above),
                        bottomRightCornerRadius = r(right && below),
                        bottomLeftCornerRadius = r(left && below),
                    ),
                )
            }
        }
        drawPath(modules, foreground)

        for ((fx, fy) in listOf(0 to 0, (n - 7) to 0, 0 to (n - 7))) {
            val ox = fx * m
            val oy = fy * m
            val ring = Path().apply {
                fillType = PathFillType.EvenOdd
                addRoundRect(RoundRect(ox, oy, ox + 7 * m, oy + 7 * m, CornerRadius(m * 1.5f)))
                addRoundRect(RoundRect(ox + m, oy + m, ox + 6 * m, oy + 6 * m, CornerRadius(m * 0.5f)))
            }
            drawPath(ring, foreground)
            drawPath(Path().apply { addRoundRect(RoundRect(ox + 2 * m, oy + 2 * m, ox + 5 * m, oy + 5 * m, CornerRadius(m))) }, foreground)
        }
    }
}
