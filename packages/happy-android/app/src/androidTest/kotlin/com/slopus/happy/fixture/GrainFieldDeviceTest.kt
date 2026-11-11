package com.slopus.happy.fixture

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.Picture
import android.graphics.RuntimeShader
import android.os.Build
import android.util.Log
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.IntSize
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.start.GRAIN_CORNERS_AGSL
import com.slopus.happy.ui.start.GRAIN_GRADIENT_AGSL
import com.slopus.happy.ui.start.GrainPalette
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.start.grainField
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.max

/**
 * Grain Gradient on this device's GPU: a frame drawn from the grain field
 * is the frame that works the grain out itself, pixel for pixel within a
 * level or two of 8-bit colour, at the cover and inner screens' sizes, at
 * a few times, in both palettes.
 */
@RunWith(AndroidJUnit4::class)
class GrainFieldDeviceTest {
    @Test
    fun theFieldDrawsTheSameFrame() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        for (size in listOf(IntSize(1080, 2520), IntSize(1968, 2184))) {
            val field = grainField(size)
            assertNotNull("the field builds at $size", field)
            run {
                val bits = field!!.bitmap.copy(Bitmap.Config.ARGB_8888, false)
                val px = IntArray(size.width * size.height).also { bits.getPixels(it, 0, size.width, 0, 0, size.width, size.height) }
                var gMin = Int.MAX_VALUE; var gMax = 0; var aMax = 0
                for (p in px) {
                    val g = (p shr 16 and 0xFF) * 16 + (p shr 12 and 0xF)
                    val a = (p shr 8 and 0xF) * 256 + (p and 0xFF)
                    gMin = minOf(gMin, g); gMax = maxOf(gMax, g); aMax = maxOf(aMax, a)
                }
                Log.i("GrainField", "range $size grain=[${gMin / 4095.0 * 1.5 - .5}, ${gMax / 4095.0 * 1.5 - .5}] aaMax=${aMax / 4095.0 * 2}")
                // Nothing at the packing's ends, where it would be clamped.
                assertTrue("the grain fits its packing at $size", gMin > 0 && gMax < 4095 && aMax < 4095)
            }
            for (palette in listOf(StartSpec.darkPalette, StartSpec.lightPalette)) {
                for (time in listOf(0f, 3.7f, 41.2f)) {
                    val whole = frame(RuntimeShader(GRAIN_GRADIENT_AGSL), size, palette, time)
                    val corners = frame(RuntimeShader(GRAIN_CORNERS_AGSL).also { it.setInputBuffer("u_field", field!!.shader) }, size, palette, time)
                    var worst = 0
                    var off = 0
                    val a = IntArray(size.width * size.height).also { whole.getPixels(it, 0, size.width, 0, 0, size.width, size.height) }
                    val b = IntArray(size.width * size.height).also { corners.getPixels(it, 0, size.width, 0, 0, size.width, size.height) }
                    for (i in a.indices) {
                        val d = max(abs((a[i] shr 16 and 0xFF) - (b[i] shr 16 and 0xFF)), max(abs((a[i] shr 8 and 0xFF) - (b[i] shr 8 and 0xFF)), abs((a[i] and 0xFF) - (b[i] and 0xFF))))
                        worst = max(worst, d)
                        if (d > 1) off++
                    }
                    Log.i("GrainField", "size=$size time=$time worst=$worst over1=$off of ${a.size}")
                    assertTrue("$size at $time: worst $worst, $off pixels off by more than 1", worst <= 2 && off * 1000 < a.size)
                }
            }
        }
    }

    private fun frame(shader: RuntimeShader, size: IntSize, palette: GrainPalette, time: Float): Bitmap {
        shader.setFloatUniform("u_resolution", size.width.toFloat(), size.height.toFloat())
        shader.setFloatUniform("u_time", time)
        shader.setColorUniform("u_colorBack", palette.back.toArgb())
        palette.colors.forEachIndexed { i, color -> shader.setColorUniform("u_color$i", color.toArgb()) }
        val picture = Picture()
        picture.beginRecording(size.width, size.height).drawRect(0f, 0f, size.width.toFloat(), size.height.toFloat(), Paint().also { it.shader = shader })
        picture.endRecording()
        return Bitmap.createBitmap(picture, size.width, size.height, Bitmap.Config.ARGB_8888)
    }
}
