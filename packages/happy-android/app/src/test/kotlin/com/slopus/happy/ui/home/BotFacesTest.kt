package com.slopus.happy.ui.home

import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.BOT_FACE_PAINT_SIZE
import com.slopus.happy.model.BOT_FACE_STYLE_ASSET
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BotFacesTest {
    private val faces = BotFaces { File("src/main/assets/$BOT_FACE_STYLE_ASSET").readText() }

    /** An arc's flags are one digit each, even run together with what follows. */
    @Test
    fun arcFlagsAreReadOneDigitEach() {
        assertEquals("M 1 2 a 3 3 0 0 1 -4.5 .5 Z", normalizePathData("M1 2a3 3 0 01-4.5.5Z"))
        assertEquals("M -1e-3 2 l 3 -4 c 1 2 3 4 5 6", normalizePathData("M-1e-3,2l3-4c1 2 3 4 5 6"))
        assertEquals("a 1 1 0 1 1 2 2", normalizePathData("a1 1 0 112 2"))
    }

    @Test
    fun theStylesColoursAreRead() {
        assertEquals(Color(0xFF9E5622), parseFaceColor("#9e5622"))
        assertEquals(Color.White, parseFaceColor("white"))
        assertEquals(Color(0xFFFFFFFF), parseFaceColor("#fff"))
    }

    /** botFacePaint.ts: a 256 PNG over the face's background, its ink black and its sclera white. */
    @Test
    fun aFaceIsPaintedAsA256Png() = runTest {
        val bytes = faces.paint("happy")
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(BOT_FACE_PAINT_SIZE, bitmap.width)
        assertEquals(BOT_FACE_PAINT_SIZE, bitmap.height)
        assertEquals(0xFF9E5622.toInt(), bitmap.getPixel(2, 2))
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        // "happy" squints: its eyes are mostly ink, with a glint of sclera.
        assertTrue("the sclera is drawn", pixels.count { it == 0xFFFFFFFF.toInt() } > 100)
        assertTrue("the ink is drawn", pixels.count { it == 0xFF000000.toInt() } > 500)
    }
}
