package com.slopus.happy.attachments

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** The actual bitmap/EXIF pipeline must crop before3072 scaling, with the selected centre kept. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CameraCropTest {
    private val directory get() = ApplicationProvider.getApplicationContext<Context>().cacheDir

    private fun image(width: Int, height: Int, orientation: Int = ExifInterface.ORIENTATION_NORMAL, centre: (Canvas, Paint) -> Unit): File {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.RED)
        centre(canvas, Paint().apply { color = Color.BLUE })
        val file = File(directory, "crop-${System.nanoTime()}.jpg")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 100, it) }
        bitmap.recycle()
        ExifInterface(file).apply { setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString()); saveAttributes() }
        return file
    }

    private fun blue(image: NormalizedImage) {
        val decoded = BitmapFactory.decodeFile(image.file.path)
        assertEquals(image.width to image.height, decoded.width to decoded.height)
        for ((x, y) in listOf(20 to 20, decoded.width / 2 to decoded.height / 2, decoded.width - 21 to decoded.height - 21)) {
            val pixel = decoded.getPixel(x, y)
            assertTrue("centre crop excludes the red bands", Color.blue(pixel) > 200 && Color.red(pixel) < 60)
        }
        decoded.recycle()
    }

    @Test fun squareKeepsTheSensorsShortEdgeRatherThanCroppingAnAlreadyDownsizedImage() {
        val file = image(4032, 3024) { canvas, paint -> canvas.drawRect(504f, 0f, 3528f, 3024f, paint) }
        val output = ImageNormalizer.normalize(file::inputStream, "photo.jpg", directory, cropRatio = 1.0)
        assertEquals(3024 to 3024, output.width to output.height)
        blue(output)
        file.delete(); output.file.delete()
    }

    @Test fun wideCropIsScaledThenRotatedUprightAndWrittenWithoutAnOrientationTag() {
        val file = image(4032, 3024, ExifInterface.ORIENTATION_ROTATE_90) { canvas, paint -> canvas.drawRect(0f, 378f, 4032f, 2646f, paint) }
        val output = ImageNormalizer.normalize(file::inputStream, "photo.jpg", directory, cropRatio = 16.0 / 9)
        assertEquals(1728 to 3072, output.width to output.height)
        val orientation = ExifInterface(output.file).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED)
        assertTrue("upright pixels carry no rotation", orientation == ExifInterface.ORIENTATION_UNDEFINED || orientation == ExifInterface.ORIENTATION_NORMAL)
        blue(output)
        file.delete(); output.file.delete()
    }

    @Test fun aSmallSquareIsCentredWithoutUpscaling() {
        val file = image(100, 60) { canvas, paint -> canvas.drawRect(20f, 0f, 80f, 60f, paint) }
        val output = ImageNormalizer.normalize(file::inputStream, "photo.jpg", directory, cropRatio = 1.0)
        assertEquals(60 to 60, output.width to output.height)
        blue(output)
        file.delete(); output.file.delete()
    }

    @Test fun aMirroredFrontPhotoKeepsTheCentreAndMirrorsItsUprightPixels() {
        val file = image(100, 60, ExifInterface.ORIENTATION_FLIP_HORIZONTAL) { canvas, paint -> canvas.drawRect(50f, 0f, 80f, 60f, paint) }
        val output = ImageNormalizer.normalize(file::inputStream, "front.jpg", directory, cropRatio = 1.0)
        assertEquals(60 to 60, output.width to output.height)
        val bitmap = BitmapFactory.decodeFile(output.file.path)
        assertTrue(Color.blue(bitmap.getPixel(10, 30)) > 200)
        assertTrue(Color.red(bitmap.getPixel(50, 30)) > 200)
        bitmap.recycle()
        file.delete(); output.file.delete()
    }
}