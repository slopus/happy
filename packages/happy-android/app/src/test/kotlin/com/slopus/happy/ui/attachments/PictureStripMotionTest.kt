package com.slopus.happy.ui.attachments

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.conversation.ConversationComposer
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlin.math.abs

/**
 * Composer pictures coming and going (iOS 8eed293c9 `AttachmentStripView`):
 * one added grows in, one taken out shrinks where it was while the rest
 * slide, the last one stays until it has gone, and those already there
 * when the strip is made arrive whole.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PictureStripMotionTest {
    @get:Rule val rule = createComposeRule()

    private fun file(id: String) = AttachmentPreview(id, "file:///$id.pdf", 0, 0, "application/pdf", 1, "$id.pdf")

    private var images by mutableStateOf(listOf(file("a")))

    private fun showStrip() = rule.setHappyContent {
        Box(Modifier.fillMaxWidth().height(120.dp)) { AttachmentStrip(images, onRemove = {}) }
    }

    private fun thumbs(tag: String = AttachmentStripTags.THUMB): List<Rect> =
        rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().map { it.boundsInRoot }.sortedBy { it.left }

    private fun frames(ms: Long) {
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(ms)
    }

    private fun change(to: List<AttachmentPreview>) {
        images = to
        Snapshot.sendApplyNotifications()
    }

    private fun shot(name: String): Bitmap {
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    /** Pixels in [r] unlike the background just left of it: how much of a thumbnail is drawn. */
    private fun ink(bitmap: Bitmap, r: Rect, background: Int = bitmap.getPixel((r.left - 2).toInt().coerceAtLeast(0), r.center.y.toInt())): Int {
        var n = 0
        for (y in r.top.toInt() until r.bottom.toInt()) for (x in r.left.toInt() until r.right.toInt()) {
            val c = bitmap.getPixel(x, y)
            val d = abs(android.graphics.Color.red(c) - android.graphics.Color.red(background)) +
                abs(android.graphics.Color.green(c) - android.graphics.Color.green(background)) +
                abs(android.graphics.Color.blue(c) - android.graphics.Color.blue(background))
            if (d > 24) n++
        }
        return n
    }

    @Test
    fun aPictureAddedGrowsInAndOneTakenOutShrinksWhileTheRestSlide() {
        showStrip()
        rule.waitForIdle()
        val first = thumbs().single()
        // There when the strip was made: whole at once.
        val whole = ink(shot("pictures-start"), first)
        assertTrue("the first picture is drawn: $whole", whole > 0)

        rule.mainClock.autoAdvance = false
        change(listOf(file("a"), file("b")))
        frames(PictureStripMotion.DURATION_MS / 8L)
        val small = thumbs()[1]
        val early = shot("pictures-growing")
        frames(PictureStripMotion.DURATION_MS.toLong())
        val b = thumbs()[1]
        val grown = ink(shot("pictures-grown"), b)
        assertTrue("small early, from the middle of its place: $small in $b", small.width < b.width * 0.5 && abs(small.center.x - b.center.x) < 2f)
        assertTrue("faint early: ${ink(early, b)} vs $grown", ink(early, b) < grown * 0.5)
        assertTrue("whole at the end: $grown vs $whole", abs(grown - whole) < whole * 0.1)

        change(listOf(file("b")))
        frames(PictureStripMotion.DURATION_MS / 4L)
        // The one going is drawn over the row, untouchable; the lazy row may keep a node for it but draws none.
        val sliding = thumbs().maxBy { it.left }
        val shrinking = ink(shot("pictures-shrinking"), first.copy(right = minOf(first.right, sliding.left - 1)))
        assertTrue("shrinking where it was: $shrinking", shrinking in 1 until (whole * 0.6).toInt())
        assertTrue("the other slides on its way: ${sliding.left} between ${first.left} and ${b.left}", sliding.left > first.left && sliding.left < b.left)
        frames(PictureStripMotion.DURATION_MS.toLong())
        val after = thumbs().maxBy { it.left }
        assertEquals("in the first place once settled", first.left, after.left, 1f)
        rule.mainClock.autoAdvance = true
    }

    @Test
    fun theLastPictureStaysUntilItHasGone() {
        showStrip()
        rule.waitForIdle()
        val strip = rule.node(AttachmentStripTags.STRIP).fetchSemanticsNode().boundsInRoot
        val thumb = thumbs().single()
        val whole = ink(shot("pictures-last"), thumb)
        rule.mainClock.autoAdvance = false
        change(emptyList())
        rule.mainClock.advanceTimeByFrame()
        // Drawn in the very frame the row lets it go: no blink.
        val first = ink(shot("pictures-last-first"), thumb)
        assertTrue("whole the first frame: $first vs $whole", first > whole * 0.8)
        frames(PictureStripMotion.DURATION_MS / 4L)
        val going = ink(shot("pictures-last-going"), thumb)
        assertTrue("still drawn as it goes, smaller: $going vs $whole", going in 1 until (whole * 0.8).toInt())
        rule.node(AttachmentStripTags.STRIP).assertExists()
        assertTrue("the room closing", rule.node(AttachmentStripTags.STRIP).fetchSemanticsNode().boundsInRoot.height <= strip.height)
        frames(PictureStripMotion.DURATION_MS.toLong())
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.node(AttachmentStripTags.STRIP).assertDoesNotExist()
        assertEquals(0, thumbs().size)
    }

    @Test
    fun theHappyAgentComposersPicturesComeAndGoTheSameWay() {
        lateinit var picker: ImagePicker
        rule.setHappyContent {
            picker = rememberImagePicker()
            Box(Modifier.fillMaxWidth()) {
                ConversationComposer(ConversationState(created = true, loaded = true), "", {}, { _, _ -> false }, {}, {}, {}, pictures = picker)
            }
        }
        rule.waitForIdle()
        rule.node(ConversationComposerTags.PICTURES).assertDoesNotExist()
        rule.mainClock.autoAdvance = false
        picker.state.images.add(file("a"))
        Snapshot.sendApplyNotifications()
        frames(PictureStripMotion.DURATION_MS / 8L)
        val early = thumbs(ConversationComposerTags.PICTURE_REMOVE).single()
        rule.node(ConversationComposerTags.PICTURES).assertExists()
        frames(PictureStripMotion.DURATION_MS.toLong())
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val landed = thumbs(ConversationComposerTags.PICTURE_REMOVE).single()
        assertTrue("its remove button grows with it: $early then $landed", early.width < landed.width * 0.5)

        // The picker's own list changes in place: the strip still sees one go, and draws it shrinking.
        picker.state.images.add(file("b"))
        rule.waitForIdle()
        val b = thumbs(ConversationComposerTags.PICTURE_REMOVE)[1]
        val before = rule.node(ConversationComposerTags.PICTURES).captureToImage().asAndroidBitmap()
        val strip = rule.node(ConversationComposerTags.PICTURES).fetchSemanticsNode().boundsInRoot
        // The picture under its remove button: 64 square, the button 2 in from its top right.
        val side = b.width / 24f * 64f
        val inset = b.width / 24f * 2f
        val place = Rect(b.right + inset - side, b.top - inset, b.right + inset, b.top - inset + side).translate(-strip.left, -strip.top)
        val glass = before.getPixel(before.width - 2, place.center.y.toInt())
        rule.mainClock.autoAdvance = false
        picker.remove("b")
        Snapshot.sendApplyNotifications()
        frames(PictureStripMotion.DURATION_MS / 4L)
        val going = rule.node(ConversationComposerTags.PICTURES).captureToImage().asAndroidBitmap()
        assertTrue("the one taken out still drawn: ${ink(going, place, glass)} of ${ink(before, place, glass)}", ink(going, place, glass) > ink(before, place, glass) / 10)
        frames(PictureStripMotion.DURATION_MS.toLong())
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        picker.remove("a")
        Snapshot.sendApplyNotifications()
        frames(PictureStripMotion.DURATION_MS / 4L)
        rule.node(ConversationComposerTags.PICTURES).assertExists()
        frames(PictureStripMotion.DURATION_MS.toLong())
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.node(ConversationComposerTags.PICTURES).assertDoesNotExist()
    }
}
