package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.HappyApplication
import com.slopus.happy.R
import com.slopus.happy.call.CallActivity
import com.slopus.happy.call.CallState
import com.slopus.happy.ui.connect.QrScannerActivity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.regex.Pattern

/**
 * The QR scanner, an activity of its own, under the app's call bar. The app's
 * controller draws the bar from a fixture, with no call, microphone or
 * provider. The bar is on top and the scanner's close button sits below it.
 * The camera is granted first, so no system dialog shows. There is no
 * Compose rule here: one would take over the scanner's camera effects. The
 * shot goes to the app's external files under `call-bar/`.
 */
@RunWith(AndroidJUnit4::class)
class CallBarScannerShot {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val dir = File(app.getExternalFilesDir(null), "call-bar").apply { mkdirs() }

    @Test
    fun overScanner() {
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.CAMERA)
        val graph = runBlocking { (app.applicationContext as HappyApplication).graphReady.await() }
        instrumentation.runOnMainSync { graph.calls.showFixture(CallState.Active(CallActivity.Listening, false, SystemClock.elapsedRealtime() - 42_000), 0f) }
        try {
            ActivityScenario.launch(QrScannerActivity::class.java).use {
                val end = device.wait(Until.findObject(By.desc(app.getString(R.string.call_end))), 5_000)
                val close = device.wait(Until.findObject(By.desc(app.getString(R.string.scan_close))), 5_000)
                val summary = device.findObject(By.desc(Pattern.compile("Voice call.*")))
                SystemClock.sleep(1_000)
                device.takeScreenshot(File(dir, "light-over-scanner.png"))
                assertTrue("the scanner shows the bar's End", end != null)
                assertTrue("the bar's summary is read", summary != null)
                assertTrue("the scanner's close is there", close != null)
                android.util.Log.i("CallBarShots", "scanner: summary=${summary.visibleBounds} end=${end.visibleBounds} close=${close.visibleBounds}")
                assertTrue("close starts below the bar (${close.visibleBounds} vs ${end.visibleBounds})", close.visibleBounds.top >= end.visibleBounds.bottom)
            }
        } finally {
            instrumentation.runOnMainSync { graph.calls.close() }
        }
    }
}
