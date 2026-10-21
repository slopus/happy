package com.slopus.happy.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * ImageNormalizer turns a picture upright by its EXIF orientation before
 * re-encoding, as manipulateAsync does: a 40×20 picture, red on the left
 * and blue on the right, written with an orientation tag.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ImageOrientationTest {
    private val dir: File get() = ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir

    private fun picture(format: Bitmap.CompressFormat, extension: String, orientation: Int): File {
        val bitmap = Bitmap.createBitmap(40, 20, Bitmap.Config.ARGB_8888)
        for (x in 0 until 40) for (y in 0 until 20) bitmap.setPixel(x, y, if (x < 20) Color.RED else Color.BLUE)
        val file = File(dir, "oriented_${System.nanoTime()}.$extension")
        file.outputStream().use { bitmap.compress(format, 100, it) }
        ExifInterface(file).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
            saveAttributes()
        }
        assertEquals(orientation, ExifInterface(file).getAttributeInt(ExifInterface.TAG_ORIENTATION, 0))
        return file
    }

    private fun decoded(image: NormalizedImage): Bitmap = BitmapFactory.decodeFile(image.file.path)

    private fun isRed(pixel: Int) = Color.red(pixel) > 200 && Color.blue(pixel) < 60
    private fun isBlue(pixel: Int) = Color.blue(pixel) > 200 && Color.red(pixel) < 60

    @Test
    fun aJpegRotatedNinetyComesOutUpright() {
        val file = picture(Bitmap.CompressFormat.JPEG, "jpg", ExifInterface.ORIENTATION_ROTATE_90)
        val image = ImageNormalizer.normalize({ file.inputStream() }, file.name, dir)
        assertEquals(20 to 40, image.width to image.height)
        val bitmap = decoded(image)
        assertEquals(20 to 40, bitmap.width to bitmap.height)
        // A quarter turn clockwise puts the left (red) half on top.
        assertEquals(true, isRed(bitmap.getPixel(10, 5)))
        assertEquals(true, isBlue(bitmap.getPixel(10, 35)))
    }

    @Test
    fun aJpegUpsideDownIsTurnedOver() {
        val file = picture(Bitmap.CompressFormat.JPEG, "jpg", ExifInterface.ORIENTATION_ROTATE_180)
        val image = ImageNormalizer.normalize({ file.inputStream() }, file.name, dir)
        assertEquals(40 to 20, image.width to image.height)
        val bitmap = decoded(image)
        assertEquals(true, isBlue(bitmap.getPixel(5, 10)))
        assertEquals(true, isRed(bitmap.getPixel(35, 10)))
    }

    @Test
    fun anUntaggedJpegIsLeftAlone() {
        val file = picture(Bitmap.CompressFormat.JPEG, "jpg", ExifInterface.ORIENTATION_NORMAL)
        val image = ImageNormalizer.normalize({ file.inputStream() }, file.name, dir)
        assertEquals(40 to 20, image.width to image.height)
        assertEquals(true, isRed(decoded(image).getPixel(5, 10)))
    }

    /** The platform reader before API 28 doesn't read WebP's EXIF; androidx's does. */
    @Test
    fun aWebpRotatedTwoSeventyComesOutUpright() {
        val file = picture(Bitmap.CompressFormat.WEBP_LOSSLESS, "webp", ExifInterface.ORIENTATION_ROTATE_270)
        assumeTrue("Robolectric decodes WebP", BitmapFactory.decodeFile(file.path) != null)
        val image = ImageNormalizer.normalize({ file.inputStream() }, file.name, dir)
        assertEquals(20 to 40, image.width to image.height)
        assertEquals("${file.nameWithoutExtension}.jpg", image.name)
        val bitmap = decoded(image)
        // A quarter turn counter-clockwise puts the right (blue) half on top.
        assertEquals(true, isBlue(bitmap.getPixel(10, 5)))
        assertEquals(true, isRed(bitmap.getPixel(10, 35)))
    }
}
