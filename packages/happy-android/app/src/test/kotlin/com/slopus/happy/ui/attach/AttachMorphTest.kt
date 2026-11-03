package com.slopus.happy.ui.attach

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlin.math.abs

/**
 * The attach sheet growing out of the + and back into it (iOS 8eed293c9,
 * da11ed4af `morphIn`/`morphOut`): the + is taken at once (hidden, its glyph
 * drawn on the morph), the sheet's clip grows from the button to the sheet
 * and shrinks back, and the + alone lands on the button. Over a green
 * window, the sheet is what isn't green; the button is blue, its glyph magenta.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachMorphTest {
    @get:Rule val rule = createComposeRule()

    private val motion = AttachSheetMotion()
    private lateinit var plus: AttachButton
    private lateinit var scope: CoroutineScope

    private fun show(reduceMotion: Boolean = false) {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            plus = rememberAttachButton { Box(Modifier.size(24.dp).background(Color.Magenta)) }
            scope = rememberCoroutineScope()
            Box(Modifier.fillMaxSize().background(Color.Green)) {
                Box(
                    Modifier.align(Alignment.BottomStart).padding(16.dp).size(48.dp).attachButton(plus).background(Color.Blue).testTag("plus"),
                )
                SheetUnderTest(motion = motion)
            }
        }
        rule.mainClock.advanceTimeByFrame()
        scope.launch { motion.open(reduceMotion, plus) }
    }

    private fun frames(ms: Long) {
        Snapshot.sendApplyNotifications()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(ms)
    }

    private fun shot(name: String): Bitmap {
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    /** Where pixels that [match] are, or null. */
    private fun bounds(bitmap: Bitmap, match: (Int, Int, Int) -> Boolean): Rect? {
        var l = Int.MAX_VALUE; var t = Int.MAX_VALUE; var r = -1; var b = -1
        for (y in 0 until bitmap.height step 2) for (x in 0 until bitmap.width step 2) {
            val c = bitmap.getPixel(x, y)
            if (match(android.graphics.Color.red(c), android.graphics.Color.green(c), android.graphics.Color.blue(c))) {
                if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y
            }
        }
        return if (r < 0) null else Rect(l.toFloat(), t.toFloat(), r.toFloat(), b.toFloat())
    }

    /** The window is pure green, the scrim only darkens it: anything with red or blue in it is the sheet, the glyph aside. */
    private fun sheet(bitmap: Bitmap) = bounds(bitmap) { r, g, b -> (r > 40 || b > 40) && !(r > 150 && b > 150 && g < 100) }
    private fun glyph(bitmap: Bitmap) = bounds(bitmap) { r, g, b -> r > 150 && b > 150 && g < 100 }
    private fun blue(bitmap: Bitmap) = bounds(bitmap) { r, g, b -> b > 150 && r < 80 && g < 80 }
    private fun button() = rule.onNodeWithTag("plus").fetchSemanticsNode().boundsInRoot

    @Test
    fun theSheetGrowsOutOfThePlusAndGoesBackIntoIt() {
        show()
        frames(16)
        val home = button()
        assertTrue("the + is taken", plus.hidden)
        val taken = shot("attach-morph-taken")
        assertTrue("the button itself hidden", blue(taken) == null)
        val glyphAt = glyph(taken)
        assertTrue("its glyph drawn where it was: $glyphAt in $home", glyphAt != null && abs(glyphAt.center.x - home.center.x) < 4 && abs(glyphAt.center.y - home.center.y) < 4)

        frames(80)
        val growing = sheet(shot("attach-morph-growing"))!!
        frames(1_000)
        val grown = sheet(shot("attach-morph-grown"))!!
        assertTrue("grown to the sheet: $grown", grown.width > taken.width * 0.95f && grown.bottom > taken.height * 0.95f)
        assertTrue("growing out of the + on its way: $growing between $home and $grown", growing.width > home.width && growing.width < grown.width && growing.top > grown.top)
        assertTrue("still taken while open", plus.hidden)

        scope.launch { motion.close(0f, reduceMotion = false) }
        frames(80)
        val shrinking = sheet(shot("attach-morph-shrinking"))!!
        assertTrue("shrinking back: $shrinking", shrinking.width < grown.width && shrinking.top > grown.top)
        frames(1_000)
        val landed = shot("attach-morph-landed")
        val back = glyph(landed)
        assertTrue("the + alone lands on the button: $back on $home", back != null && abs(back.center.x - home.center.x) < 4 && abs(back.center.y - home.center.y) < 4)
        val rest = sheet(landed)
        assertTrue("nothing else of the sheet: $rest", rest == null || (rest.width < home.width * 1.5f && rest.height < home.height * 1.5f))
        motion.giveBack()
        assertFalse(plus.hidden)
    }

    @Test
    fun reduceMotionSlidesAndLeavesThePlusAlone() {
        show(reduceMotion = true)
        frames(16)
        assertFalse("not taken", plus.hidden)
        assertTrue("nothing drawn for it", glyph(shot("attach-morph-reduced")) == null)
    }
}
