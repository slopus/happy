package com.slopus.happy.ui.connect

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.BitMatrix
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.decoder.Decoder
import com.slopus.happy.crypto.AccountLink
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class QrCodeTest {
    @get:Rule
    val rule = createComposeRule()

    private val url = AccountLink.linkUrl(AccountLink.generateKeyPair().publicKey)

    @Test
    fun theMatrixDecodesToTheLink() {
        val matrix = QrMatrix.encode(url)
        val bits = BitMatrix(matrix.size).apply {
            for (y in 0 until matrix.size) for (x in 0 until matrix.size) if (matrix.module(x, y)) set(x, y)
        }
        assertEquals(url, Decoder().decode(bits).text)
        // The finder patterns are drawn on their own, so they read as light here.
        assertFalse(matrix.dark(0, 0))
        assertFalse(matrix.dark(matrix.size - 1, 0))
        assertFalse(matrix.dark(0, matrix.size - 1))
        assertFalse(matrix.dark(-1, 3))
    }

    /** What the other phone's camera sees: the drawn code, rounded corners and all, scans back to the link. */
    @Test
    fun theDrawnCodeScans() {
        rule.setHappyContent {
            // The restore screen's white frame, so the reader has a quiet zone around the code.
            Box(Modifier.background(Color.White).padding(12.dp)) {
                QrCode(data = url, size = 260.dp, modifier = Modifier.testTag("qr"))
            }
        }
        val qr = rule.node("qr")
        assertBox("code", qr.bounds, 12.dp, 12.dp, 260.dp, 260.dp)
        val image = qr.captureToImage().toPixelMap()
        val pixels = IntArray(image.width * image.height) { i ->
            val c = image[i % image.width, i / image.width]
            (0xFF shl 24) or ((c.red * 255).toInt() shl 16) or ((c.green * 255).toInt() shl 8) or (c.blue * 255).toInt()
        }
        val bitmap = BinaryBitmap(HybridBinarizer(RGBLuminanceSource(image.width, image.height, pixels)))
        val result = QRCodeReader().decode(bitmap, mapOf(DecodeHintType.TRY_HARDER to true))
        assertEquals(url, result.text)
    }
}
