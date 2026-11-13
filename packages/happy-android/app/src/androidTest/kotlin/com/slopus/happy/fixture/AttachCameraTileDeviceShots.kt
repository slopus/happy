package com.slopus.happy.fixture

import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.attachments.GalleryAccess
import com.slopus.happy.R
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The attach sheet with its live camera tile, over the fixture agent, a long
 * caption typed over the keyboard: the tile stops at the caption bar's top.
 * No Compose rule, which would run the camera's effects off the main thread.
 * Shots go to `device-evidence/attach-camera/`.
 */
@RunWith(AndroidJUnit4::class)
class AttachCameraTileDeviceShots {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val dark = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private val evidence = File(app.filesDir, "device-evidence/attach-camera").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val seeded = ArrayList<Uri>()

    @After fun clean() {
        seeded.forEach { runCatching { app.contentResolver.delete(it, null, null) } }
        scope.cancel()
    }

    private fun insertPicture(index: Int): Uri {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "attach_camera_$index.jpg")
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/HappyAttachFixture")
        }
        val uri = app.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        val bitmap = Bitmap.createBitmap(600, 800, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.HSVToColor(floatArrayOf(index * 40f, 0.6f, 0.9f))) }
        app.contentResolver.openOutputStream(uri)!!.use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        return uri
    }

    @OptIn(ExperimentalComposeUiApi::class)
    @Test fun theLiveTileStopsAtTheCaptionBar() {
        val automation = instrumentation.uiAutomation
        for (permission in GalleryAccess.permissions() + android.Manifest.permission.CAMERA) {
            runCatching { automation.grantRuntimePermission(app.packageName, permission) }
        }
        repeat(9) { seeded += insertPicture(it) }
        val transport = FixtureTransport()
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.enableEdgeToEdge()
                activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
                activity.setContent {
                    HappyTheme(preference = if (dark) ThemePreference.Dark else ThemePreference.Light) {
                        Box(Modifier.semantics { testTagsAsResourceId = true }) {
                            FixtureScreens(transport, scope) { it.start() }
                        }
                    }
                }
            }
            device.wait(Until.findObject(By.res(ConversationComposerTags.MORE)), 15_000)!!.click()
            // The sheet is a window of its own, outside the tags-as-ids root: found by what TalkBack reads.
            assertNotNull(device.wait(Until.findObject(By.desc(app.getString(R.string.components_empty_main_screen_open_camera))), 15_000))
            val pick = app.getString(R.string.attach_pick)
            device.wait(Until.findObjects(By.desc(pick)), 30_000)
            SystemClock.sleep(2_000)
            device.findObjects(By.desc(pick)).take(2).map { it.visibleCenter }.forEach { device.click(it.x, it.y); SystemClock.sleep(400) }
            SystemClock.sleep(800)
            device.takeScreenshot(File(evidence, "01-picked-live-${if (dark) "dark" else "light"}.png"))
            // The caption bar wears the composer's placeholder; the composer under the sheet does too, but the sheet takes the tap.
            device.wait(Until.findObject(By.text(app.getString(R.string.session_input_placeholder))), 5_000)
            device.findObjects(By.text(app.getString(R.string.session_input_placeholder))).maxBy { it.visibleBounds.bottom }.visibleCenter.let { device.click(it.x, it.y) }
            SystemClock.sleep(1_200)
            listOf("A_long_caption", "line_two", "line_three", "line_four", "line_five", "line_six", "line_seven").forEachIndexed { index, line ->
                if (index > 0) device.pressEnter()
                device.executeShellCommand("input text $line")
            }
            SystemClock.sleep(1_500)
            device.takeScreenshot(File(evidence, "02-long-caption-live-${if (dark) "dark" else "light"}.png"))
            device.pressBack()
            SystemClock.sleep(1_200)
            device.takeScreenshot(File(evidence, "03-long-caption-keyboard-down-live-${if (dark) "dark" else "light"}.png"))
        }
    }
}
