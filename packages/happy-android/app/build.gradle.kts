import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.androidx.baselineprofile)
}

// One application ID per build type, preserving the existing store identities:
//   debug   -> development variant
//   preview -> preview variant
//   release -> production variant
// and one of our own that never ships:
//   bench   -> release code, debug-signed, installed beside the others (research/cold-start.md)
val applicationIds = mapOf(
    "debug" to "com.slopus.happy.dev",
    "preview" to "com.slopus.happy.preview",
    "release" to "com.ex3ndr.happy",
    "bench" to "com.slopus.happy.bench",
)

// The commit the build is from, for Settings > Version: the environment's, else git's.
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

// Existing public SDK key. Supply it at build time; local builds
// without a key keep purchases unavailable, without configuring an anonymous user.
val revenueCatGoogleKey = providers.environmentVariable("EXPO_PUBLIC_REVENUE_CAT_GOOGLE").orNull
    ?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.revenueCatGoogleKey").orNull.orEmpty()

// Happy Cloud (the account menu's "Connect to Happy Cloud"): the one domain
// every server (<name>.BASE) lives under, compiled in. HAPPY_CLOUD_BASE or -Phappy.cloudBase points a build
// at another deployment.
val happyCloudBase = providers.environmentVariable("HAPPY_CLOUD_BASE").orNull?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.cloudBase").orNull?.takeIf { it.isNotBlank() }
    ?: "happy-clusters.com"

// Happy Cloud's accounts service, where the person signs in and their servers
// are listed: its own origin, apart from HAPPY_CLOUD_BASE. HAPPY_CLOUD_ACCOUNTS
// or -Phappy.cloudAccounts points a build at another one.
val happyCloudAccounts = providers.environmentVariable("HAPPY_CLOUD_ACCOUNTS").orNull?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.cloudAccounts").orNull?.takeIf { it.isNotBlank() }
    ?: "https://auth.happy.engineering"

// Happy Cloud's web app, where a server's settings the phone has no page for
// are (<name>.WEB/#/settings/<page>). HAPPY_CLOUD_WEB or -Phappy.cloudWeb points
// a build at another one.
val happyCloudWeb = providers.environmentVariable("HAPPY_CLOUD_WEB").orNull?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.cloudWeb").orNull?.takeIf { it.isNotBlank() }
    ?: "happybases.com"

// Happy Cloud's invite links (https://INVITE/#<token>), which open the app in
// the builds that offer Happy Cloud (src/debug and src/preview's intent filter).
// HAPPY_CLOUD_INVITE or -Phappy.cloudInvite points a build at another host.
val happyCloudInvite = providers.environmentVariable("HAPPY_CLOUD_INVITE").orNull?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.cloudInvite").orNull?.takeIf { it.isNotBlank() }
    ?: "join.happy.engineering"

// Sign in with Google for the Happy Cloud account: the accounts service's web
// OAuth client (project happy-coder-9fe36), which Google's ID tokens are issued
// to and the service checks as their audience. Public, the same for every
// variant; Google tells the variants apart by package and signing SHA-1.
// HAPPY_CLOUD_GOOGLE_CLIENT_ID or -Phappy.cloudGoogleClientId points a build at
// another accounts deployment's client.
val happyCloudGoogleClientId = providers.environmentVariable("HAPPY_CLOUD_GOOGLE_CLIENT_ID").orNull?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.cloudGoogleClientId").orNull?.takeIf { it.isNotBlank() }
    ?: "902947412706-bem666be0cu3ju6lnic2go91hsl256co.apps.googleusercontent.com"

// The agent connection voice call's public ElevenLabs agent
// (docs/agent-voice-call.md): never in the repository, so from the
// environment, -Phappy.callAgentV3Id or the ignored local.properties. Named
// for the tools this code calls (v3), so an older agent's ID, set under the
// old HAPPY_CALL_AGENT_ID or happy.callAgentId, never reaches it. Without it
// the voice button says voice isn't set up.
val callAgentId = providers.environmentVariable("HAPPY_CALL_AGENT_V3_ID").orNull?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.callAgentV3Id").orNull?.takeIf { it.isNotBlank() }
    ?: Properties().apply {
        providers.fileContents(rootProject.layout.projectDirectory.file("local.properties")).asText.orNull?.let { load(it.reader()) }
    }.getProperty("happy.callAgentV3Id")?.takeIf { it.isNotBlank() }

// PostHog's public project key (the existing environment variable is retained):
// :analytics sends its events and asks this install's feature flags with it,
// from release and preview builds. Without one nothing is sent and every flag is off.
val postHogKey = providers.environmentVariable("EXPO_PUBLIC_POSTHOG_API_KEY").orNull
    ?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("happy.postHogKey").orNull.orEmpty()

// Native version ownership. versionName is CalVer YYYY.M.C, written here at
// release time by scripts/native-version.cjs (see AGENTS.md, "Versions and
// signing"). Store builds must provide a versionCode above the last published
// build; local builds default to 1.
val defaultVersionName = "2026.11.1"
val versionNameValue = providers.environmentVariable("HAPPY_VERSION_NAME").orNull
    ?: providers.gradleProperty("happy.versionName").orNull
    ?: defaultVersionName
val calVer = Regex("""[1-9]\d{3}\.([1-9]|1[0-2])\.[1-9]\d*""")
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
        // Instrumented device checks only (src/androidTest); nothing of it reaches an APK we ship.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://api.cluster-fluster.com\"")
        buildConfigField("String", "HAPPY_CLOUD_BASE", groovy.json.JsonOutput.toJson(happyCloudBase))
        buildConfigField("String", "HAPPY_CLOUD_ACCOUNTS", groovy.json.JsonOutput.toJson(happyCloudAccounts))
        buildConfigField("String", "HAPPY_CLOUD_WEB", groovy.json.JsonOutput.toJson(happyCloudWeb))
        buildConfigField("String", "HAPPY_CLOUD_INVITE", groovy.json.JsonOutput.toJson(happyCloudInvite))
        manifestPlaceholders["happyCloudInviteHost"] = happyCloudInvite
        manifestPlaceholders["happyCloudWebHost"] = happyCloudWeb
        buildConfigField("String", "GOOGLE_SERVER_CLIENT_ID", groovy.json.JsonOutput.toJson(happyCloudGoogleClientId))
        buildConfigField("String", "REVENUE_CAT_GOOGLE_KEY", groovy.json.JsonOutput.toJson(revenueCatGoogleKey))
        buildConfigField("String", "POSTHOG_KEY", groovy.json.JsonOutput.toJson(postHogKey))
        // Existing relay voice agent, retained for compatibility with installed clients.
        val voiceAgentId = "agent_6701k211syvvegba4kt7m68nxjmw"
        buildConfigField("String", "ELEVENLABS_AGENT_ID", "\"$voiceAgentId\"")
        buildConfigField("String", "CALL_AGENT_ID", callAgentId?.let { groovy.json.JsonOutput.toJson(it.trim()) } ?: "null")
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
            // -Phappy.debuggable=false: a debug build ART compiles ahead of time, for
            // frame measurements (research/telegram-chat.md). A debuggable app runs
            // interpreted and reads two to three times slower than it ships.
            isDebuggable = providers.gradleProperty("happy.debuggable").orNull != "false"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            // Embed native symbols in the bundle when the libraries supply them.
            ndk { debugSymbolLevel = "FULL" }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            resValue("string", "app_name", "Happy")
            signingConfig = signingConfigs.findByName("release")
        }
        create("preview") {
            isMinifyEnabled = true
            isShrinkResources = true
            // Preview does not inherit release's native symbol configuration.
            ndk { debugSymbolLevel = "FULL" }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            matchingFallbacks += "release"
            resValue("string", "app_name", "Happy (preview)")
            signingConfig = signingConfigs.findByName("preview") ?: signingConfigs.getByName("debug")
        }
        // Release code after R8, installable beside the dev build: what cold start is
        // measured on (benchmark/, research/cold-start.md). Its manifest adds the
        // fixture account (src/bench).
        create("bench") {
            initWith(getByName("release"))
            matchingFallbacks += "release"
            isProfileable = true
            resValue("string", "app_name", "Happy (bench)")
            signingConfig = signingConfigs.getByName("debug")
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
// file is app/google-services.json. Each variant gets the resources
// the plugin would generate for the client whose package name is its
// application id; push/FirebaseStart.kt reads them where push first needs Firebase.
val googleServices: Map<*, *>? = file("google-services.json")
    .takeIf { it.exists() }
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
// earlier upload, and one whose versionName isn't CalVer breaks the scheme:
// refuse it rather than find out at the Play console.
// The checks run first in the variant's build (pre<Variant>Build), not after R8.
tasks.configureEach {
    if (name == "preReleaseBuild" || name == "prePreviewBuild") {
        val taskName = if (name == "preReleaseBuild") "release build" else "preview build"
        val signed = if (name == "preReleaseBuild") releaseKey != null else previewKey != null
        val versionCodeSet = versionCodeValue != null
        val versionName = versionNameValue
        val versionNameCalVer = calVer.matches(versionName)
        doFirst {
            check(!signed || versionCodeSet) {
                "A signed $taskName needs a versionCode above the last store upload: set HAPPY_VERSION_CODE or -Phappy.versionCode"
            }
            check(!signed || versionNameCalVer) {
                "A signed $taskName needs a CalVer versionName (YYYY.M.C, e.g. 2026.11.1), got '$versionName': see scripts/native-version.cjs"
            }
        }
    }
}

// A store build without the voice agent ships a voice button that only says
// voice isn't set up: every release and preview build, signed or not, needs
// HAPPY_CALL_AGENT_V3_ID (an ElevenLabs agent ID, as CallAgent.id reads it).
// CI, which has no secrets, says so with HAPPY_RELEASE_WITHOUT_CALL_AGENT=1.
// Debug, bench and tests never need it.
tasks.configureEach {
    if (name == "preReleaseBuild" || name == "prePreviewBuild") {
        val taskName = if (name == "preReleaseBuild") "release build" else "preview build"
        val agentId = callAgentId?.trim()
        val agentIdValid = agentId != null && Regex("agent_[A-Za-z0-9_]+").matches(agentId)
        val waived = providers.environmentVariable("HAPPY_RELEASE_WITHOUT_CALL_AGENT").orNull == "1"
        doFirst {
            if (waived && !agentIdValid) {
                logger.warn("HAPPY_RELEASE_WITHOUT_CALL_AGENT=1: this $taskName has no voice agent; voice says it isn't set up.")
            }
            check(waived || agentIdValid) {
                if (agentId == null) {
                    "A $taskName needs the voice agent: set HAPPY_CALL_AGENT_V3_ID (or -Phappy.callAgentV3Id) to the v3 agent's ID. The old HAPPY_CALL_AGENT_ID is ignored. See docs/agent-voice-call.md"
                } else {
                    "A $taskName needs the voice agent, and HAPPY_CALL_AGENT_V3_ID isn't an ElevenLabs agent ID (agent_…)."
                }
            }
        }
    }
}

androidComponents {
    onVariants { variant ->
        // -Phappy.applicationId=com.slopus.happy.chatbench: a measuring build installed beside the
        // signed-in dev app, never over it (research/telegram-chat.md).
        // The baseline profile plugin's build types (nonMinified*, benchmark*) are the bench app's.
        val applicationId = providers.gradleProperty("happy.applicationId").orNull
            ?: applicationIds[variant.buildType] ?: applicationIds.getValue("bench")
        variant.applicationId.set(applicationId)
        // The system doesn't compile a debuggable app on install: it runs from the APK, and with
        // the dex deflated, every cold start first inflated all of it, about 200 ms on the Fold.
        // Stored, it is mapped from the APK as it is (research/cold-start.md).
        if (variant.debuggable) variant.packaging.dex.useLegacyPackaging.set(false)
        firebaseResources(applicationId).forEach { (name, value) ->
            variant.resValues.put(variant.makeResValueKey("string", name), com.android.build.api.variant.ResValue(value))
        }
    }
}

/**
 * The release APK can't be run here, so after R8 this reads what it kept:
 * every `@Serializable` type in the sources keeps a `serializer()` by rule
 * (Navigation's routes and reified decoding look it up reflectively), serialized
 * enums keep their class names and values() for Navigation's EnumNavType, the
 * manifest's own components survive, and the merged manifest still has the
 * Play Store `<queries>` entry, the App Link, the FCM service and the
 * default notification channel. assembleRelease runs it.
 */
abstract class VerifyReleaseKeeps : DefaultTask() {
    @get:InputFile abstract val seeds: RegularFileProperty
    @get:InputFile abstract val mapping: RegularFileProperty
    @get:InputFile abstract val manifest: RegularFileProperty
    @get:InputFiles abstract val sources: ConfigurableFileCollection
    @get:OutputFile abstract val report: RegularFileProperty

    @TaskAction
    fun verify() {
        val problems = mutableListOf<String>()
        val seedLines = seeds.get().asFile.readLines()
        val serializerOwners = seedLines
            .filter { it.endsWith("kotlinx.serialization.KSerializer serializer()") }
            .map { it.substringBefore(':').removeSuffix("\$Companion") }
            .toSet()
        val withSerializer = serializerOwners.map { it.split('.', '$').last() }.toSet()
        val declaration = Regex("""@Serializable\b(?:\([^)]*\))?(?:\s|@\w+(?:\([^)]*\))?)*(?:(?:public|internal|private|data|sealed|enum|value|abstract|open)\s+)*(?:class|object|interface)\s+(\w+)""")
        val sourceTexts = sources.files.filter { it.extension == "kt" }.map { it.readText() }
        val serializable = sourceTexts
            .flatMap { text -> declaration.findAll(text).map { it.groupValues[1] }.toList() }
            .toSortedSet()
        if (serializable.isEmpty()) problems += "no @Serializable types found in the sources"
        (serializable - withSerializer).forEach { problems += "R8 kept no serializer() for @Serializable $it" }

        // Seeds use original names, even when R8 renames the class. Check the
        // mapping too: EnumNavType resolves the serial descriptor's class name,
        // then calls getEnumConstants() (which requires values()). Recover binary
        // nested names from the serializer owners, rather than assuming every
        // enum is top-level or hard-coding today's route argument types.
        val classMapping = mapping.get().asFile.useLines { lines ->
            val entry = Regex("""^(\S+) -> (\S+):$""")
            lines.mapNotNull { entry.matchEntire(it)?.destructured?.let { (from, to) -> from to to } }.toMap()
        }
        val enumDeclaration = Regex("""\benum\s+class\s+(\w+)$""")
        val serializedEnums = sourceTexts.flatMap { text ->
            val packageName = Regex("""(?m)^package\s+([\w.]+)""").find(text)?.groupValues?.get(1)
            declaration.findAll(text).mapNotNull { enumDeclaration.find(it.value)?.groupValues?.get(1) }
                .flatMap { name ->
                    val owners = serializerOwners.filter { owner ->
                        owner.substringBeforeLast('.') == packageName && owner.split('.', '$').last() == name
                    }
                    if (owners.isEmpty()) problems += "R8 kept no serializer owner for enum $packageName.$name"
                    owners.asSequence()
                }.toList()
        }.toSortedSet()
        serializedEnums.forEach { name ->
            if (classMapping[name] != name) problems += "Navigation enum $name was removed or renamed to ${classMapping[name]}"
            if ("$name: $name[] values()" !in seedLines) problems += "Navigation enum $name lost values() for getEnumConstants()"
        }

        // Gson reads the public agent's token by this field's name; renamed, every call connects with none.
        if ("io.elevenlabs.network.TokenResponse: java.lang.String token" !in seedLines) {
            problems += "ElevenLabs TokenResponse.token is not kept for Gson"
        }

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
            problems += "<queries> lost com.android.vending (ReviewPrompt looks for the Play Store)"
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
            if (problems.isEmpty()) "ok: ${serializable.size} serializable types, ${serializedEnums.size} enum names and values(), manifest checked\n" else problems.joinToString("\n"),
        )
        check(problems.isEmpty()) { "Release build safety:\n" + problems.joinToString("\n") { "- $it" } }
    }
}

val verifyReleaseKeeps = tasks.register<VerifyReleaseKeeps>("verifyReleaseKeeps") {
    dependsOn("minifyReleaseWithR8", "mergeReleaseComposeMapping", "processReleaseMainManifest")
    seeds.set(layout.buildDirectory.file("outputs/mapping/release/seeds.txt"))
    mapping.set(layout.buildDirectory.file("outputs/mapping/release/mapping.txt"))
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

// The Baseline and startup profiles (research/cold-start.md), generated on a device by
// :benchmark's BaselineProfileGenerator into src/main/generated/baselineProfiles, which
// every variant ships. Generated by hand (generateBaselineProfile), never by a build.
baselineProfile {
    mergeIntoMain = true
    saveInSrc = true
    automaticGenerationDuringBuild = false
    // Classes the startup profile names go first in the dex: a cold start pages in less of it.
    dexLayoutOptimization = true
    // Generated against the bench build, the one with the fixture account; merged into main.
    variants {
        create("bench") { from(project(":benchmark")) }
    }
}

// The plugin's copies of the bench build (benchmarkBench measures, nonMinifiedBench
// generates) seed the same fixture account as the bench build itself.
android.sourceSets.matching { it.name == "benchmarkBench" || it.name == "nonMinifiedBench" }.configureEach {
    kotlin.srcDir("src/bench/kotlin")
    manifest.srcFile("src/bench/AndroidManifest.xml")
}

dependencies {
    implementation(project(":crypto"))
    // Product analytics behind one facade; removable with its call sites (AGENTS.md "Analytics").
    implementation(project(":analytics"))
    // Installs the Baseline Profile on sideloaded and pre-Play-cloud-profile installs.
    implementation(libs.androidx.profileinstaller)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.exifinterface)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    implementation(libs.googleid)
    implementation(libs.androidx.swiperefreshlayout)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    // Destination composition/measure attribution in navigation macrobenchmark traces.
    "benchImplementation"(libs.compose.runtime.tracing)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(project(":elevenlabs"))

    // QR codes (AGENTS.md "QR codes"): our own CameraX scanner reads them with
    // ZXing's decoder, so no Play services; ZXing's encoder draws them.
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.compose)
    implementation(libs.zxing.core)
    implementation(libs.tailcat)

    // The review ask (utils/requestReview.ts): expo-store-review's Play in-app review.
    implementation(libs.play.review)

    // Push (AGENTS.md "Push"): FCM, configured from google-services.json when it is there.
    implementation(libs.firebase.messaging)
    implementation(libs.coil.compose)
    implementation(libs.lottie.compose)
    implementation(libs.coil.network.okhttp)
    // Animated covers in Feed posts (AnimatedImageDecoder, API 28+), asked for per request.
    implementation(libs.coil.gif)
    implementation(libs.play.billing)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    // Ephemeral trusted/untrusted TLS fixtures, without changing system trust.
    testImplementation(libs.okhttp.tls)
    testImplementation(libs.coil.test)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.uiautomator)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    // ChatListBenchmark's Telegram-style RecyclerView cell; not in the app.
    androidTestImplementation(libs.androidx.recyclerview)
}
