import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Product analytics (docs/analytics-catalog.json), apart from the app so it
// can be taken out whole: the app calls only the `Analytics` facade and the
// typed events. Nothing here knows the app's own types; it is told what to
// send, the build it is in, and whether it may.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.slopus.happy.analytics"
    compileSdk = libs.versions.android.compileSdk.get().toInt()
    defaultConfig {
        minSdk = libs.versions.android.minSdk.get().toInt()
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests {
            all {
                // Robolectric's SDK 36 runtime reaches into JDK internals.
                it.jvmArgs(
                    "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED",
                    "--add-opens=java.base/java.io=ALL-UNNAMED",
                )
            }
        }
    }
}

kotlin {
    jvmToolchain(libs.versions.java.toolchain.get().toInt())
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    // The facade takes the app's flows and HTTP client.
    api(libs.kotlinx.coroutines.android)
    api(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
