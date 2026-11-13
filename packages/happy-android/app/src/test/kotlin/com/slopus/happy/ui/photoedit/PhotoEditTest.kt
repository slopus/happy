package com.slopus.happy.ui.photoedit

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotoEditTest {
    private val whole = PhotoCrop.whole(400, 300)

    private fun near(expected: Float, actual: Float, what: String, within: Float = 0.5f) =
        assertTrue("$what: $expected, was $actual", abs(expected - actual) <= within)

    private fun near(expected: Offset, actual: Offset, what: String) {
        near(expected.x, actual.x, "$what x")
        near(expected.y, actual.y, "$what y")
    }

    @Test fun `the whole photo is no edit, and its frame maps its corners to the result's`() {
        assertTrue(whole.isIdentity(400, 300))
        assertTrue(PhotoEdit(whole).isEmpty(400, 300))
        near(Offset(0f, 0f), whole.toImage(Offset(0f, 0f)), "top left")
        near(Offset(400f, 300f), whole.toImage(Offset(400f, 300f)), "bottom right")
    }

    @Test fun `a quarter turn turns the photo anticlockwise, swaps the frame and the ratio, and four come back`() {
        val turned = whole.locked(4f / 3).turned()
        assertEquals(1, turned.turns)
        near(300f, turned.width, "width")
        near(400f, turned.height, "height")
        near(3f / 4, turned.ratio, "ratio", 0.001f)
        // The result's top left is the photo's top right: turned anticlockwise.
        near(Offset(400f, 0f), turned.toImage(Offset(0f, 0f)), "top left")
        val back = turned.turned().turned().turned()
        assertEquals(0, back.turns % 4)
        near(400f, back.width, "width again")
    }

    @Test fun `mirrored, the turn still goes anticlockwise on the screen`() {
        val turned = whole.copy(mirrored = true).turned()
        // Under a mirror the result's top left is the photo's top left turned the other way: still its top edge's far end on screen.
        near(Offset(0f, 0f), turned.toImage(Offset(0f, 0f)), "top left")
    }

    @Test fun `a move on the result is the same move over the photo, turned and mirrored as it is`() {
        near(Offset(10f, 0f), whole.toImageDelta(Offset(10f, 0f)), "straight")
        near(Offset(-10f, 0f), whole.copy(mirrored = true).toImageDelta(Offset(10f, 0f)), "mirrored")
        near(Offset(0f, 10f), whole.turned().toImageDelta(Offset(10f, 0f)), "turned: the result's across is the photo's down")
    }

    @Test fun `straightened, the frame shrinks until its turned box is inside the photo`() {
        val tilted = whole.copy(straighten = 10f).inside(400, 300)
        assertTrue(tilted.width < 400f)
        near(4f / 3, tilted.width / tilted.height, "shape kept", 0.01f)
        assertTrue(PhotoCropping.fits(tilted, 400, 300))
        assertFalse(PhotoCropping.fits(whole.copy(straighten = 10f), 400, 300))
    }

    @Test fun `a locked ratio is the largest inside the frame, about its middle`() {
        val square = whole.locked(1f)
        near(300f, square.width, "width")
        near(300f, square.height, "height")
        near(200f, square.centerX, "middle")
        near(1f, square.ratio, "ratio", 0.001f)
        assertEquals(0f, square.locked(0f).ratio)
    }

    @Test fun `a corner is taken before a side, and the middle of the frame is neither`() {
        val frame = Rect(100f, 100f, 300f, 250f)
        assertEquals(CropHandle.TopLeft, PhotoCropping.handle(frame, Offset(105f, 95f), 24f))
        assertEquals(CropHandle.Right, PhotoCropping.handle(frame, Offset(310f, 170f), 24f))
        assertEquals(CropHandle.Bottom, PhotoCropping.handle(frame, Offset(200f, 260f), 24f))
        assertNull(PhotoCropping.handle(frame, Offset(200f, 170f), 24f))
        assertNull(PhotoCropping.handle(frame, Offset(400f, 170f), 24f))
    }

    @Test fun `a side moves alone when free, the frame stays at least its least and inside its area`() {
        val frame = Rect(100f, 100f, 300f, 250f)
        val area = Rect(50f, 50f, 350f, 350f)
        assertEquals(Rect(100f, 100f, 280f, 250f), PhotoCropping.resize(frame, CropHandle.Right, Offset(-20f, 5f), 0f, 64f, area))
        assertEquals(Rect(100f, 100f, 164f, 250f), PhotoCropping.resize(frame, CropHandle.Right, Offset(-500f, 0f), 0f, 64f, area))
        assertEquals(Rect(50f, 100f, 300f, 250f), PhotoCropping.resize(frame, CropHandle.Left, Offset(-500f, 0f), 0f, 64f, area))
    }

    @Test fun `locked, a corner keeps the shape about the corner across from it`() {
        val frame = Rect(100f, 100f, 300f, 200f)
        val area = Rect(0f, 0f, 400f, 400f)
        val next = PhotoCropping.resize(frame, CropHandle.BottomRight, Offset(40f, 5f), 2f, 64f, area)
        near(100f, next.left, "left")
        near(100f, next.top, "top")
        near(240f, next.width, "width")
        near(120f, next.height, "height")
        // Too big for the area: kept inside it, still 2:1.
        val big = PhotoCropping.resize(frame, CropHandle.BottomRight, Offset(1000f, 0f), 2f, 64f, area)
        near(300f, big.width, "width in the area")
        near(150f, big.height, "height in the area")
    }

    @Test fun `a frame resized past the photo stops at its edge`() {
        // The whole photo shown at 1:1; the right side can't go further right.
        val frame = Rect(0f, 0f, 400f, 300f)
        val wanted = Rect(0f, 0f, 450f, 300f)
        val reached = PhotoCropping.furthest(whole, frame, wanted, 1f, 400, 300)
        near(400f, reached.right, "right", 1f)
        // Shrunk from the right, the photo stays put under the frame.
        val smaller = PhotoCropping.reframed(whole, frame, Rect(0f, 0f, 200f, 300f), 1f)
        near(100f, smaller.centerX, "middle over the photo's left half")
        near(200f, smaller.width, "width")
    }

    @Test fun `panned, the photo moves under the frame no further than its edge, and a pinch zooms to ten times at most`() {
        val half = whole.copy(width = 200f, height = 150f)
        val moved = PhotoCropping.panned(half, Offset(50f, 0f), 1f, 400, 300)
        near(150f, moved.centerX, "moved left over the photo as it is dragged right")
        val far = PhotoCropping.panned(half, Offset(1000f, 0f), 1f, 400, 300)
        near(100f, far.centerX, "stopped at the photo's left edge")
        val zoomed = PhotoCropping.zoomed(whole, 100f, 400, 300)
        near(40f, zoomed.width, "ten times")
        val out = PhotoCropping.zoomed(half, 0.1f, 400, 300)
        near(400f, out.width, "no more than all of it")
    }

    @Test fun `Telegram's weight, colours and brushes`() {
        near(4f, PhotoPainting.weight(0f, 1024f), "the least: 8/2048 of the width", 0.01f)
        near(49f, PhotoPainting.weight(1f, 1024f), "the most: 98/2048", 0.01f)
        assertEquals(PhotoColors.ORANGE, PaintTool.Arrow.defaultColor)
        assertEquals(0.25f, PaintTool.Arrow.defaultSize)
        assertFalse(PaintTool.Eraser.coloured)
        assertEquals(9, PhotoColors.PRESETS.size)
        assertEquals(PhotoColors.WHITE, PhotoColors.grid(0, 0))
        assertEquals(PhotoColors.BLACK, PhotoColors.grid(PhotoColors.GRID_COLUMNS - 1, 0))
        // The hue row in the middle is the hue itself; above it darker, below it lighter.
        val middle = PhotoColors.GRID_ROWS / 2 + 1
        assertEquals(PhotoColors.GRID_HUES[3], PhotoColors.grid(3, middle - 1))
        assertTrue(brightness(PhotoColors.grid(3, 1)) < brightness(PhotoColors.GRID_HUES[3]))
        assertTrue(brightness(PhotoColors.grid(3, PhotoColors.GRID_ROWS - 1)) > brightness(PhotoColors.GRID_HUES[3]))
        assertEquals(0xffff0000.toInt(), PhotoColors.spectrum(0.5f, 0f))
        assertEquals(PhotoColors.WHITE, PhotoColors.spectrum(0f, 0.3f))
        assertEquals(PhotoColors.BLACK, PhotoColors.spectrum(1f, 0.3f))
    }

    @Test fun `the result is the frame's size, drawn on, cut and turned`() {
        val photo = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply {
            eraseColor(android.graphics.Color.BLUE)
            for (y in 0 until 30) for (x in 0 until 10) setPixel(x, y, android.graphics.Color.RED)
        }
        val crop = PhotoCrop.whole(40, 30).turned()
        val stroke = PaintStroke(PaintTool.Pen, PhotoColors.WHITE, 4f, listOf(Offset(20f, 25f), Offset(30f, 25f)))
        val out = PhotoPainting.render(photo, PhotoEdit(crop, listOf(stroke)))
        assertEquals(30, out.width)
        assertEquals(40, out.height)
        // Turned anticlockwise, the photo's red left side is the result's foot.
        assertEquals(android.graphics.Color.RED, out.getPixel(15, 37))
        assertEquals(android.graphics.Color.BLUE, out.getPixel(15, 2))
    }

    @Test fun `display ink maps photo coordinates and its eraser keeps the photo`() {
        val photo = Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.BLUE) }
        val pen = PaintStroke(PaintTool.Pen, PhotoColors.WHITE, 40f, listOf(Offset(40f, 150f), Offset(360f, 150f)))
        val eraser = PaintStroke(PaintTool.Eraser, 0, 40f, listOf(Offset(200f, 120f), Offset(200f, 180f)))
        val preview = PhotoDrawPreview(photo, 200, 150, Rect(0f, 0f, 200f, 150f), Matrix().apply { setScale(0.5f, 0.5f) }, listOf(pen))
        val ink = PhotoColors.withAlpha(PhotoColors.WHITE, PaintTool.Pen.alpha)
        assertEquals(ink, preview.ink.getPixel(40, 75))
        preview.commit(eraser)
        assertEquals(0, preview.ink.getPixel(100, 75))
        assertEquals(android.graphics.Color.BLUE, preview.background.getPixel(100, 75))
        preview.redraw(listOf(pen))
        assertEquals(ink, preview.ink.getPixel(100, 75))
        val cropped = PhotoPainting.preview(photo, listOf(pen, eraser), 200)
        assertEquals(200, cropped.width)
        assertEquals(150, cropped.height)
        assertEquals(android.graphics.Color.BLUE, cropped.getPixel(100, 75))
    }

    @Test fun `incrementally smoothed strokes match their exported paths for every brush`() {
        val points = listOf(Offset(20f, 40f), Offset(40f, 80f), Offset(80f, 20f), Offset(120f, 90f))
        for (tool in PaintTool.entries) {
            val live = LivePaintStroke(tool, PhotoColors.ORANGE, 8f, points.first())
            points.drop(1).forEach { live.append(it) }
            val interactive = Bitmap.createBitmap(160, 120, Bitmap.Config.ARGB_8888)
            val exported = Bitmap.createBitmap(160, 120, Bitmap.Config.ARGB_8888)
            val source = Bitmap.createBitmap(160, 120, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.BLUE) }
            val blur = PhotoPainting.blurShader(source)
            PhotoPainting.draw(Canvas(interactive), live.stroke, blur, 160f, live.path())
            PhotoPainting.draw(Canvas(exported), live.finish(), blur, 160f)
            assertTrue("$tool preview and export", interactive.sameAs(exported))
        }
    }

    private fun brightness(color: Int) = ((color shr 16) and 0xff) + ((color shr 8) and 0xff) + (color and 0xff)
}
