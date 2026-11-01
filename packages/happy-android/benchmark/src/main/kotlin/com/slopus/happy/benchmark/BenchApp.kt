package com.slopus.happy.benchmark

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until

/**
 * The app under test: the bench build (com.slopus.happy.bench, release code
 * beside the dev build), or whichever the baseline profile plugin built for
 * it (`targetAppId`).
 */
object BenchApp {
    val packageName: String = InstrumentationRegistry.getArguments().getString("targetAppId") ?: "com.slopus.happy.bench"

    /** What home's first card shows from the fixture's kept catalog. */
    const val HOME_ROW = "Chief of Staff"

    const val TIMEOUT = 10_000L

    /**
     * The fixture account (the app's src/bench BenchFixture): an agent
     * connection with a kept home, open. Seeding kills the app, so the next
     * start is cold.
     */
    fun MacrobenchmarkScope.seed() {
        val out = device.executeShellCommand(
            "am broadcast -f 0x20 -n $packageName/com.slopus.happy.bench.BenchFixture -a com.slopus.happy.bench.SEED",
        )
        check("result=1" in out) { "The bench fixture didn't seed: $out" }
        killProcess()
    }

    /** Home with its kept rows. */
    fun MacrobenchmarkScope.awaitHome() {
        check(device.wait(Until.hasObject(By.text(HOME_ROW)), TIMEOUT)) { "Home's rows never showed" }
        // The chat and agent page repeat HOME_ROW in their title. Require the
        // home-only control too, so a failed pop cannot seed the next sample.
        check(device.wait(Until.hasObject(By.desc("Settings")), TIMEOUT)) { "Navigation did not return home" }
    }
}
