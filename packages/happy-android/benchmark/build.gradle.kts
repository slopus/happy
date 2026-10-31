import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Cold start on a device (research/cold-start.md): StartupBenchmark measures it,
// BaselineProfileGenerator writes the app's Baseline and startup profiles. Both
// run against the bench build (com.slopus.happy.bench: release code, beside the
// dev build), never the dev or store apps.
plugins {
    alias(libs.plugins.android.test)
    alias(libs.plugins.androidx.baselineprofile)
}

android {
    namespace = "com.slopus.happy.benchmark"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        // Macrobenchmark needs 23; the generator without root, 33.
        minSdk = 28
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // The app's bench build type; the plugin adds its benchmarkBench and nonMinifiedBench.
    buildTypes {
        create("bench") {
            matchingFallbacks += "release"
        }
    }

    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(libs.versions.java.toolchain.get().toInt())
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// Only the bench app has the fixture account: no variants against release.
androidComponents {
    beforeVariants { it.enable = it.buildType.orEmpty().endsWith("Bench") || it.buildType == "bench" }
}

baselineProfile {
    // The Fold or whatever is attached; no managed device.
    useConnectedDevices = true
}

dependencies {
    implementation(libs.androidx.test.ext.junit)
    implementation(libs.androidx.test.uiautomator)
    implementation(libs.benchmark.macro.junit4)
}
