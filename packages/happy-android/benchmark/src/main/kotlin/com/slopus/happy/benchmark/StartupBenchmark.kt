package com.slopus.happy.benchmark

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.benchmark.BenchApp.awaitHome
import com.slopus.happy.benchmark.BenchApp.seed
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Cold start to home on the bench build, with the fixture account
 * (research/cold-start.md). timeToInitialDisplay is the first frame: home's
 * bar over its kept rows, or its loader while the disk is read.
 * timeToFullDisplay is home with its rows (MainActivity's `ReportDrawnWhen`).
 *
 * `./gradlew :benchmark:connectedBenchBenchmarkAndroidTest`; results in
 * benchmark/build/outputs/connected_android_test_additional_output.
 */
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule
    val rule = MacrobenchmarkRule()

    /** As installed from the Play Store: the Baseline Profile applied. */
    @Test
    fun coldWithBaselineProfile() = start(CompilationMode.Partial(BaselineProfileMode.Require))

    /** Without any: what the profile is worth. */
    @Test
    fun coldWithoutProfile() = start(CompilationMode.None())

    private fun start(compilation: CompilationMode) = rule.measureRepeated(
        packageName = BenchApp.packageName,
        metrics = listOf(StartupTimingMetric()),
        compilationMode = compilation,
        startupMode = StartupMode.COLD,
        iterations = 15,
        setupBlock = { seed() },
    ) {
        startActivityAndWait()
        awaitHome()
    }
}
