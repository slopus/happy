import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// One application ID per build type, the same IDs the React Native app ships
// under (packages/happy-app/app.config.js):
//   debug   -> development variant
//   preview -> preview variant
//   release -> production variant
val applicationIds = mapOf(
    "debug" to "com.slopus.happy.dev",
    "preview" to "com.slopus.happy.preview",
    "release" to "com.ex3ndr.happy",
)

android {
    namespace = "com.slopus.happy"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        applicationId = applicationIds.getValue("release")
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://api.cluster-fluster.com\"")
    }

    buildTypes {
        debug {
            resValue("string", "app_name", "Happy (dev)")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            resValue("string", "app_name", "Happy")
        }
        create("preview") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            matchingFallbacks += "release"
            resValue("string", "app_name", "Happy (preview)")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "/META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
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

androidComponents {
    onVariants { variant ->
        variant.applicationId.set(applicationIds.getValue(requireNotNull(variant.buildType)))
    }
}

kotlin {
    jvmToolchain(libs.versions.java.toolchain.get().toInt())
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":crypto"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
