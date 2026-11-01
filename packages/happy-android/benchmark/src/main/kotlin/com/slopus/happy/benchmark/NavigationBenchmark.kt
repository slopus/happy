package com.slopus.happy.benchmark

import android.os.SystemClock
import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import com.slopus.happy.benchmark.BenchApp.awaitHome
import com.slopus.happy.benchmark.BenchApp.seed
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real home navigation against the isolated, R8-optimized bench app. Run with
 * ANDROID_SERIAL=<device> ./gradlew :benchmark:connectedBenchmarkBenchAndroidTest
 * -Pandroid.testInstrumentationRunnerArguments.class=com.slopus.happy.benchmark.NavigationBenchmark
 *
 * Includes the destination's first frame, the entire 450 ms motion (plus its
 * first-frame allowance), and the pop. Each iteration starts on the same home.
 * No credentials, network account, display settings or production app are touched.
 */
@RunWith(AndroidJUnit4::class)
class NavigationBenchmark {
    @get:Rule val rule = MacrobenchmarkRule()

    @Test fun settings() = navigation { openSettings() }
    /** First Settings visit in each process: class verification must not hide in warm samples. */
    @Test fun settingsCold() = navigation(cold = true) { openSettings() }
    @Test fun chat() = navigation { device.findObject(By.text(BenchApp.HOME_ROW)).click() }
    @Test fun artifacts() = navigation { device.findObject(By.text("Artifacts")).click() }
    @Test fun agentPage() = navigation(
        prepare = {
            device.findObject(By.text(BenchApp.HOME_ROW)).click()
            check(device.wait(Until.gone(By.text("Release Notes")), BenchApp.TIMEOUT))
            SystemClock.sleep(750)
        },
        finish = {
            device.pressBack()
            awaitHome()
        },
    ) {
        checkNotNull(device.wait(Until.findObject(By.text(BenchApp.HOME_ROW)), BenchApp.TIMEOUT)).click()
        check(device.wait(Until.hasObject(By.text("Model")), BenchApp.TIMEOUT)) { "Agent page did not open" }
    }

    private fun navigation(
        cold: Boolean = false,
        prepare: MacrobenchmarkScope.() -> Unit = {},
        finish: MacrobenchmarkScope.() -> Unit = {},
        open: MacrobenchmarkScope.() -> Unit,
    ) = rule.measureRepeated(
        packageName = BenchApp.packageName,
        metrics = listOf(FrameTimingMetric()),
        compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
        iterations = 12,
        setupBlock = {
            if (iteration == 0) seed()
            if (cold) killProcess()
            startActivityAndWait()
            awaitHome()
            device.waitForIdle()
            prepare()
        },
    ) {
        open()
        check(device.wait(Until.gone(By.text("Release Notes")), BenchApp.TIMEOUT)) {
            "The destination did not replace home"
        }
        // Accessibility can see the destination before its enter motion finishes.
        SystemClock.sleep(750)
        device.pressBack()
        SystemClock.sleep(750)
        finish()
        awaitHome()
    }
}

internal fun MacrobenchmarkScope.openSettings() {
    checkNotNull(device.findObject(By.desc("Settings"))) { "Home has no Settings button" }.click()
}