package com.slopus.happy.ui.genui

import android.graphics.Bitmap
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.util.Log
import com.slopus.happy.genui.GenUi
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Debug builds only: one Gen UI render document as an answer block on the
 * chat's ground, nothing else on screen (bars hidden), for screenshots.
 * Actions and image taps are only logged (tag `GenUiGym`).
 *
 * A bundled fixture by name:
 * ```
 * adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.genui.GenUiGymActivity \
 *     -e genui.fixture 01-stats [-e genui.theme dark]
 * ```
 * Or any document, read at launch with no rebuild: a path in the app's files
 * dir (`run-as com.slopus.happy.dev` copies it there; tools/genui/shoot.sh
 * does this for a directory), or relative to it:
 * ```
 *     -e genui.path genui/my-doc.json
 * ```
 * Image files (`assets/coast.jpg`) are the debug assets under `genui/`,
 * whichever way the document came.
 *
 * `--ez genui.capture true` also writes the whole block, however tall, as
 * `files/genui-shot.png` once its pictures have had time to load; the
 * screen alone would cut a long document off.
 */
class GenUiGymActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val dark = intent.getStringExtra("genui.theme") == "dark"
        val document = GenUi.parse(readDocument())
        val capture = intent.getBooleanExtra("genui.capture", false)
        val shot = File(filesDir, "genui-shot.png").apply { delete() }
        val host = GenUiHost(
            onAction = { key, action -> Log.i("GenUiGym", "action $key $action") },
            onView = { key, viewer -> Log.i("GenUiGym", "view $key ${viewer.group}[${viewer.index}]") },
            cached = { file -> "file:///android_asset/genui/$file" },
        )
        setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                val layer = rememberGraphicsLayer()
                if (capture) {
                    LaunchedEffect(Unit) {
                        delay(2500)
                        val bitmap = layer.toImageBitmap().asAndroidBitmap()
                        withContext(Dispatchers.IO) {
                            File(filesDir, "genui-shot.tmp").apply {
                                outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                                renameTo(shot)
                            }
                        }
                    }
                }
                Box(Modifier.fillMaxSize().background(HappyTheme.colors.surface).verticalScroll(rememberScrollState())) {
                    GenUiView(
                        document,
                        Modifier
                            .drawWithContent {
                                layer.record { this@drawWithContent.drawContent() }
                                drawLayer(layer)
                            }
                            .background(HappyTheme.colors.surface)
                            .padding(vertical = 24.dp),
                        host = host,
                    )
                }
            }
        }
    }

    /** The document's text, or "" (which shows nothing) when it can't be read. */
    private fun readDocument(): String = runCatching {
        val path = intent.getStringExtra("genui.path")
        if (path != null) {
            val file = File(path).takeIf { it.isAbsolute } ?: File(filesDir, path)
            file.readText()
        } else {
            val name = intent.getStringExtra("genui.fixture") ?: "01-stats"
            assets.open("genui/fixtures/$name.json").bufferedReader().use { it.readText() }
        }
    }.getOrDefault("")
}
