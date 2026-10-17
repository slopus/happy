import java.util.Properties
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

// Same public SDK key as happy-app. Supply it at build time; local builds
// without a key keep purchases unavailable, without configuring an anonymous user.
val revenueCatGoogleKey = providers.environmentVariable("EXPO_PUBLIC_REVENUE_CAT_GOOGLE").orNull
    ?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.revenueCatGoogleKey").orNull.orEmpty()

// Versions follow happy-app (app.config.js, eas.json): versionName is the
// app's `version`, read from app.config.js so the two never drift; versionCode
// is EAS's remote, auto-incremented build number, which a store build must
// pass in (HAPPY_VERSION_CODE or -Phappy.versionCode) so it lands above the
// React Native build it replaces. Local builds default to 1.
val happyAppVersion = Regex("""\bversion:\s*"([^"]+)"""")
    .find(providers.fileContents(layout.projectDirectory.file("../../happy-app/app.config.js")).asText.orNull.orEmpty())
    ?.groupValues?.get(1)
val versionNameValue = providers.environmentVariable("HAPPY_VERSION_NAME").orNull
    ?: providers.gradleProperty("happy.versionName").orNull
    ?: happyAppVersion
    ?: "0.0.0"
val versionCodeValue = (providers.environmentVariable("HAPPY_VERSION_CODE").orNull
    ?: providers.gradleProperty("happy.versionCode").orNull)
    ?.let { requireNotNull(it.toIntOrNull()?.takeIf { code -> code > 0 }) { "versionCode must be a positive integer, got '$it'" } }

// Signing for the store variants, from the environment or a gitignored
// keystore.properties beside settings.gradle.kts (keystore.properties.example
// lists the keys). Nothing is checked in. Without them release builds
// unsigned and preview debug-signed, so local builds keep working.
val keystoreProperties = Properties().apply {
    providers.fileContents(rootProject.layout.projectDirectory.file("keystore.properties")).asText.orNull?.let { load(it.reader()) }
}

class SigningKey(val storeFile: File, val storePassword: String, val keyAlias: String, val keyPassword: String)

fun signingKey(variant: String): SigningKey? {
    val env = "HAPPY_${variant.uppercase()}"
    fun value(envName: String, property: String): String? =
        providers.environmentVariable("${env}_$envName").orNull?.ifEmpty { null } ?: keystoreProperties.getProperty("$variant.$property")?.ifEmpty { null }
    val store = value("KEYSTORE", "storeFile") ?: return null
    return SigningKey(
        storeFile = rootProject.file(store),
        storePassword = requireNotNull(value("KEYSTORE_PASSWORD", "storePassword")) { "$variant signing: storePassword is missing" },
        keyAlias = requireNotNull(value("KEY_ALIAS", "keyAlias")) { "$variant signing: keyAlias is missing" },
        keyPassword = requireNotNull(value("KEY_PASSWORD", "keyPassword")) { "$variant signing: keyPassword is missing" },
    )
}
val releaseKey = signingKey("release")
val previewKey = signingKey("preview")

android {
    namespace = "com.slopus.happy"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        applicationId = applicationIds.getValue("release")
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = versionCodeValue ?: 1
        versionName = versionNameValue

        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://api.cluster-fluster.com\"")
        buildConfigField("String", "REVENUE_CAT_GOOGLE_KEY", groovy.json.JsonOutput.toJson(revenueCatGoogleKey))
        // All three RN variants currently use productionElevenLabsAgentId.
        val voiceAgentId = Regex("""const productionElevenLabsAgentId = ['"]([^'"]+)['"]""")
            .find(providers.fileContents(layout.projectDirectory.file("../../happy-app/app.config.js")).asText.get())
            ?.groupValues?.get(1) ?: error("app.config.js has no elevenLabsAgentId")
        buildConfigField("String", "ELEVENLABS_AGENT_ID", "\"$voiceAgentId\"")
        buildConfigField("String", "BUILD_COMMIT_SHA", buildCommitSha?.let { "\"$it\"" } ?: "null")
        buildConfigField("String", "BUILD_COMMIT_TIMESTAMP", buildCommitTimestamp?.let { "\"$it\"" } ?: "null")
    }

    signingConfigs {
        releaseKey?.let { key ->
            create("release") {
                storeFile = key.storeFile
                storePassword = key.storePassword
                keyAlias = key.keyAlias
                keyPassword = key.keyPassword
            }
        }
        previewKey?.let { key ->
            create("preview") {
                storeFile = key.storeFile
                storePassword = key.storePassword
                keyAlias = key.keyAlias
                keyPassword = key.keyPassword
            }
        }
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
            signingConfig = signingConfigs.findByName("release")
        }
        create("preview") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            matchingFallbacks += "release"
            resValue("string", "app_name", "Happy (preview)")
            signingConfig = signingConfigs.findByName("preview") ?: signingConfigs.getByName("debug")
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

    // The language picker switches locale in the app (ui/settings/LocalizedContent.kt),
    // so a Play bundle must keep every language rather than only the device's.
    bundle {
        language {
            enableSplit = false
        }
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

// A signed store build with the default versionCode would collide with every
// earlier upload: refuse it rather than find out at the Play console.
// The check runs first in the variant's build (pre<Variant>Build), not after R8.
tasks.configureEach {
    if (name == "preReleaseBuild" || name == "prePreviewBuild") {
        val taskName = if (name == "preReleaseBuild") "release build" else "preview build"
        val signed = if (name == "preReleaseBuild") releaseKey != null else previewKey != null
        val versionCodeSet = versionCodeValue != null
        doFirst {
            check(!signed || versionCodeSet) {
                "A signed $taskName needs a versionCode above the last store upload: set HAPPY_VERSION_CODE or -Phappy.versionCode"
            }
        }
    }
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

/**
 * The release APK can't be run here, so after R8 this reads what it kept:
 * every `@Serializable` type in the sources keeps a `serializer()` by rule
 * (Navigation's routes and reified decoding look it up reflectively), the
 * manifest's own components survive, and the merged manifest still has the
 * Play Store `<queries>` entry, the App Link, the FCM service and the
 * default notification channel. assembleRelease runs it.
 */
abstract class VerifyReleaseKeeps : DefaultTask() {
    @get:InputFile abstract val seeds: RegularFileProperty
    @get:InputFile abstract val manifest: RegularFileProperty
    @get:InputFiles abstract val sources: ConfigurableFileCollection
    @get:OutputFile abstract val report: RegularFileProperty

    @TaskAction
    fun verify() {
        val problems = mutableListOf<String>()
        val seedLines = seeds.get().asFile.readLines()
        val withSerializer = seedLines
            .filter { it.endsWith("kotlinx.serialization.KSerializer serializer()") }
            .map { it.substringBefore(':').removeSuffix("\$Companion").split('.', '$').last() }
            .toSet()
        val declaration = Regex("""@Serializable\b(?:\([^)]*\))?(?:\s|@\w+(?:\([^)]*\))?)*(?:(?:public|internal|private|data|sealed|enum|value|abstract|open)\s+)*(?:class|object|interface)\s+(\w+)""")
        val serializable = sources.files.filter { it.extension == "kt" }
            .flatMap { file -> declaration.findAll(file.readText()).map { it.groupValues[1] }.toList() }
            .toSortedSet()
        if (serializable.isEmpty()) problems += "no @Serializable types found in the sources"
        (serializable - withSerializer).forEach { problems += "R8 kept no serializer() for @Serializable $it" }

        val xml = manifest.get().asFile.readText()
        val kept = seedLines.filter { ':' !in it }.toSet()
        Regex("""android:name="(com\.slopus\.happy\.[\w.]+)"""").findAll(xml).map { it.groupValues[1] }.toSet()
            .filter { it !in kept }
            .forEach { problems += "manifest component $it is not kept by R8" }
        // The element: its opening tag alone when self-closed, else up to its closing tag.
        fun component(tag: String, name: String): String? {
            val open = Regex("""<$tag\s[^>]*?android:name="$name"[^>]*>""").find(xml) ?: return null
            if (open.value.endsWith("/>")) return open.value
            val end = xml.indexOf("</$tag>", open.range.last)
            return if (end < 0) null else xml.substring(open.range.first, end)
        }
        if (!Regex("""<queries>[\s\S]*?<package android:name="com\.android\.vending"""").containsMatchIn(xml)) {
            problems += "<queries> lost com.android.vending (QrScanner, ReviewPrompt look for the Play Store)"
        }
        val activity = component("activity", "com.slopus.happy.MainActivity")
        if (activity == null || "android:exported=\"true\"" !in activity) problems += "MainActivity is not exported"
        if (activity == null || !Regex("""autoVerify="true"[\s\S]*?android:host="app\.happy\.engineering"""").containsMatchIn(activity)) {
            problems += "MainActivity lost the verified App Link for app.happy.engineering"
        }
        val messaging = component("service", "com.slopus.happy.push.HappyMessagingService")
        if (messaging == null || "com.google.firebase.MESSAGING_EVENT" !in messaging || "android:exported=\"false\"" !in messaging) {
            problems += "HappyMessagingService is missing, not on MESSAGING_EVENT, or exported"
        }
        val receiver = component("receiver", "com.slopus.happy.push.BackgroundSendReceiver")
        if (receiver == null || "android:exported=\"false\"" !in receiver) problems += "BackgroundSendReceiver is missing or exported"
        val channel = Regex("""const val DEFAULT = "([^"]+)"""").find(
            sources.files.firstOrNull { it.name == "PushNotifications.kt" }?.readText().orEmpty(),
        )?.groupValues?.get(1)
        if (channel == null || !Regex("""default_notification_channel_id"\s+android:value="$channel"""").containsMatchIn(xml)) {
            problems += "FCM's default_notification_channel_id is not NotificationChannels.DEFAULT ($channel)"
        }

        report.get().asFile.writeText(
            if (problems.isEmpty()) "ok: ${serializable.size} serializable types, manifest checked\n" else problems.joinToString("\n"),
        )
        check(problems.isEmpty()) { "Release build safety:\n" + problems.joinToString("\n") { "- $it" } }
    }
}

val verifyReleaseKeeps = tasks.register<VerifyReleaseKeeps>("verifyReleaseKeeps") {
    dependsOn("minifyReleaseWithR8", "processReleaseMainManifest")
    seeds.set(layout.buildDirectory.file("outputs/mapping/release/seeds.txt"))
    manifest.set(layout.buildDirectory.file("intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml"))
    sources.from(fileTree("src/main/kotlin"))
    report.set(layout.buildDirectory.file("reports/verifyReleaseKeeps.txt"))
}
tasks.matching { it.name == "assembleRelease" }.configureEach { dependsOn(verifyReleaseKeeps) }

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
    implementation(libs.androidx.exifinterface)
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
    implementation(project(":elevenlabs"))

    // QR codes (AGENTS.md "QR codes"): Google Code Scanner reads them, as
    // expo-camera's launchScanner does on Android; ZXing's encoder draws them.
    implementation(libs.play.services.code.scanner)
    implementation(libs.zxing.core)

    // The review ask (utils/requestReview.ts): expo-store-review's Play in-app review.
    implementation(libs.play.review)

    // Push (AGENTS.md "Push"): FCM, configured from google-services.json when it is there.
    implementation(libs.firebase.messaging)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.revenuecat.purchases)
    implementation(libs.revenuecat.ui)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.coil.test)
}
