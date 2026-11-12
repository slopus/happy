package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.setHappyContent
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Create your profile, written only when HAPPY_SHOTS_DIR is set: the Fold's
 * cover and inner screens and a phone light and dark, each empty, with the
 * suggested name, and with a photo chosen.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CloudProfileShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    /** A stand-in for a picked photo: a sunset in a square. */
    private fun photo() = Bitmap.createBitmap(240, 240, Bitmap.Config.ARGB_8888).also { bitmap ->
        val canvas = Canvas(bitmap)
        canvas.drawPaint(Paint().apply { shader = LinearGradient(0f, 0f, 0f, 240f, 0xFFFF8A65.toInt(), 0xFF5C6BC0.toInt(), Shader.TileMode.CLAMP) })
        canvas.drawCircle(120f, 150f, 52f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFE082.toInt() })
        canvas.drawRect(0f, 170f, 240f, 240f, Paint().apply { color = 0xFF263238.toInt() })
    }.asImageBitmap()

    private fun shots(device: String, dark: Boolean = false) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        var state by androidx.compose.runtime.mutableStateOf(0)
        val picture = photo()
        rule.setHappyContent(dark) {
            androidx.compose.runtime.key(state) {
                CloudProfileScreen(
                    handle = "@acme",
                    seed = "acme",
                    suggested = if (state == 0) null else "Steve Korshakov",
                    photo = if (state == 2) picture else null,
                    saving = false,
                    failed = false,
                    onChoosePhoto = {},
                    onSubmit = {},
                    onBack = {},
                )
            }
        }
        for ((index, name) in listOf("empty", "prefilled", "photo").withIndex()) {
            state = index
            rule.waitForIdle()
            val page = rule.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap()
            File(dir, "profile-android-$device-$name.png").outputStream().use { page.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun foldCover() = shots("cover")

    @Test @Config(qualifiers = "w673dp-h841dp-xhdpi")
    fun foldInner() = shots("inner")

    @Test @Config(qualifiers = "w393dp-h852dp-xxhdpi")
    fun phoneLight() = shots("phone-light")

    @Test @Config(qualifiers = "w393dp-h852dp-xxhdpi")
    fun phoneDark() = shots("phone-dark", dark = true)
}
