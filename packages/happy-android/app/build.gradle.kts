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

// The commit the build is from, for Settings > Version (happy-app
// app.config.js loadBuildMetadata): the environment's, else git's.
fun git(vararg args: String): String? = runCatching {
    providers.exec {
        commandLine("git", *args)
        isIgnoreExitValue = true
    }.standardOutput.asText.get().trim().ifEmpty { null }
}.getOrNull()
val buildCommitSha = providers.environmentVariable("HAPPY_BUILD_COMMIT_SHA").orNull
    ?: providers.environmentVariable("GITHUB_SHA").orNull
    ?: git("rev-parse", "HEAD")
val buildCommitTimestamp = providers.environmentVariable("HAPPY_BUILD_COMMIT_TIMESTAMP").orNull
    ?: git("show", "-s", "--format=%cI", buildCommitSha ?: "HEAD")

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
        buildConfigField("String", "BUILD_COMMIT_SHA", buildCommitSha?.let { "\"$it\"" } ?: "null")
        buildConfigField("String", "BUILD_COMMIT_TIMESTAMP", buildCommitTimestamp?.let { "\"$it\"" } ?: "null")
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

// Firebase without the google-services plugin, so a build without a
// google-services.json still works (push then reports unsupported). The
// file is app/google-services.json, else happy-app's committed one (same
// Firebase project and application ids). Each variant gets the resources
// the plugin would generate for the client whose package name is its
// application id; FirebaseInitProvider reads them at startup.
val googleServices: Map<*, *>? = listOf(file("google-services.json"), file("../../happy-app/google-services.json"))
    .firstOrNull { it.exists() }
    ?.let { groovy.json.JsonSlurper().parse(it) as Map<*, *> }

fun firebaseResources(applicationId: String): Map<String, String> {
    val json = googleServices ?: return emptyMap()
    val project = json["project_info"] as Map<*, *>
    val client = (json["client"] as List<*>).map { it as Map<*, *> }.firstOrNull {
        ((it["client_info"] as Map<*, *>)["android_client_info"] as Map<*, *>)["package_name"] == applicationId
    } ?: return emptyMap()
    val apiKey = ((client["api_key"] as List<*>).firstOrNull() as Map<*, *>?)?.get("current_key") as String?
    return listOfNotNull(
        "google_app_id" to (client["client_info"] as Map<*, *>)["mobilesdk_app_id"] as String,
        "gcm_defaultSenderId" to project["project_number"] as String,
        (project["project_id"] as String?)?.let { "project_id" to it },
        (project["storage_bucket"] as String?)?.let { "google_storage_bucket" to it },
        apiKey?.let { "google_api_key" to it },
        apiKey?.let { "google_crash_reporting_api_key" to it },
    ).toMap()
}

androidComponents {
    onVariants { variant ->
        val applicationId = applicationIds.getValue(requireNotNull(variant.buildType))
        variant.applicationId.set(applicationId)
        firebaseResources(applicationId).forEach { (name, value) ->
            variant.resValues.put(variant.makeResValueKey("string", name), com.android.build.api.variant.ResValue(value))
        }
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

    // QR codes (AGENTS.md "QR codes"): Google Code Scanner reads them, as
    // expo-camera's launchScanner does on Android; ZXing's encoder draws them.
    implementation(libs.play.services.code.scanner)
    implementation(libs.zxing.core)

    // Push (AGENTS.md "Push"): FCM, configured from google-services.json when it is there.
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
