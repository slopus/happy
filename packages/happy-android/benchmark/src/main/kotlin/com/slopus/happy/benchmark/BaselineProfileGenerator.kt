package com.slopus.happy.benchmark

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import com.slopus.happy.benchmark.BenchApp.awaitHome
import com.slopus.happy.benchmark.BenchApp.seed
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The app's Baseline and startup profiles (research/cold-start.md): a cold
 * start to home with the fixture account, a chat opened from it and back.
 *
 * `./gradlew :app:generateBaselineProfile` with the Fold attached writes
 * app/src/main/generated/baselineProfiles; commit what it writes.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun startToHomeAndChat() = rule.collect(
        packageName = BenchApp.packageName,
        includeInStartupProfile = true,
    ) {
        seed()
        startActivityAndWait()
        awaitHome()
        device.findObject(By.text(BenchApp.HOME_ROW)).click()
        // The chat's composer: the page has come up.
        device.wait(Until.gone(By.text("Release Notes")), BenchApp.TIMEOUT)
        device.waitForIdle()
        device.pressBack()
        awaitHome()
    }
}
