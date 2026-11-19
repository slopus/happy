package com.slopus.happy.analytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** A JVM crash's class names and frames: what is taken from it, kept until the next start, and told with its own exit only. */
class CrashSignatureTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun frame(className: String, method: String, line: Int, file: String? = "SourceFile") = StackTraceElement(className, method, file, line)

    private fun <T : Throwable> T.at(vararg frames: StackTraceElement): T = apply { stackTrace = arrayOf(*frames) }

    /** 2026.11.1's no-browser crash as the store build threw it (R8: renamed classes, its map id for a file, offsets for lines). */
    private fun storeCrash(): Throwable {
        val file = "r8-map-id-632f9fbb0a315258a2831586c1c0acd7aa3d79e944114c6bf045764d162c7147"
        val cause = IllegalStateException("No Activity found to handle Intent { act=android.intent.action.VIEW dat=https://happy.engineering/... }").at(
            frame("android.app.Instrumentation", "checkStartActivityResult", 2200, "Instrumentation.java"),
            frame("wp2", "startActivityForResult", 8, file),
        )
        return IllegalArgumentException("Can't open https://happy.engineering.", cause).at(
            frame("g80", "a", 29, file),
            frame("yk6", "invoke", 1214, file),
            frame("vl6", "a", 11, file),
            frame("fm5", "invoke", 12, file),
            frame("h0", "A1", 16, file),
            frame("je2", "F", 133, file),
            frame("android.view.ViewGroup", "dispatchTouchEvent", 2802, "ViewGroup.java"),
        )
    }

    @Test
    fun aStoreBuildsCrashIsItsClassesAndFiveFramesFromTheFirstOfItsOwnCode() {
        val signature = CrashSignature.of(storeCrash())
        assertEquals("java.lang.IllegalArgumentException", signature.exceptionClass)
        assertEquals("java.lang.IllegalStateException", signature.causeClass)
        assertEquals("g80.a:29 yk6.invoke:1214 vl6.a:11 fm5.invoke:12 h0.A1:16", signature.frames)
        // Never the message, the URL in it or the map id.
        assertFalse(signature.toString().contains("happy.engineering"))
        assertFalse(signature.toString().contains("r8-map-id"))
    }

    @Test
    fun theFramesSkipThePlatformAndTheLibraries() {
        val error = IllegalArgumentException("Can't open https://example.com.").at(
            frame("androidx.compose.ui.platform.AndroidUriHandler", "openUri", 36),
            frame("kotlin.collections.CollectionsKt", "forEach", 1),
            frame("com.slopus.happy.ui.browser.LinkOpener\$Companion", "legacy\$lambda\$1", 148),
            frame("com.slopus.happy.ui.start.StartRoutesKt", "InstallDesktop\$lambda\$2\$0", 54),
            frame("androidx.compose.foundation.AbstractClickableNode", "performClick", 1701),
        )
        assertEquals(
            "com.slopus.happy.ui.browser.LinkOpener\$Companion.legacy\$lambda\$1:148 com.slopus.happy.ui.start.StartRoutesKt.InstallDesktop\$lambda\$2\$0:54 " +
                "androidx.compose.foundation.AbstractClickableNode.performClick:1701",
            CrashSignature.of(error).frames,
        )
        assertNull("no cause", CrashSignature.of(error).causeClass)
    }

    @Test
    fun aWrapperFromThePlatformAloneTakesItsCausesFrames() {
        val cause = IllegalStateException().at(frame("com.slopus.happy.Thing", "<init>", -1), frame("com.slopus.happy.Other", "run-AbC12", -2))
        val error = RuntimeException(cause).at(frame("android.os.Looper", "loop", 288))
        val signature = CrashSignature.of(error)
        assertEquals("java.lang.RuntimeException", signature.exceptionClass)
        assertEquals("java.lang.IllegalStateException", signature.causeClass)
        // An unknown or native line is 0.
        assertEquals("com.slopus.happy.Thing.<init>:0 com.slopus.happy.Other.run-AbC12:0", signature.frames)
    }

    /** ActivityThread's wrapper for a crash as an activity launches, as Android 15 throws it. */
    private fun launchFailure(cause: Throwable) = RuntimeException("Unable to start activity ComponentInfo{com.ex3ndr.happy/com.slopus.happy.MainActivity}: $cause", cause).at(
        frame("android.app.ActivityThread", "performLaunchActivity", 3782),
        frame("android.app.ActivityThread", "handleLaunchActivity", 4235),
        frame("android.app.servertransaction.LaunchActivityItem", "execute", 112),
        frame("android.app.servertransaction.TransactionExecutor", "executeNonLifecycleItem", 174),
        frame("android.app.servertransaction.TransactionExecutor", "execute", 81),
        frame("android.app.ActivityThread\$H", "handleMessage", 2636),
        frame("android.os.Looper", "loop", 317),
        frame("android.app.ActivityThread", "main", 8705),
        frame("java.lang.reflect.Method", "invoke", -2),
        frame("com.android.internal.os.ZygoteInit", "main", 886),
    )

    @Test
    fun aCrashThePlatformThrewAndWrappedAloneIsItsInnermostCausesTopFrames() {
        // 2026.11.1's first v6 report: exception_class and cause_class, and no frame of this build anywhere.
        val npe = NullPointerException("Attempt to invoke virtual method on a null object reference").at(
            frame("android.app.Activity", "performCreate", 8990),
            frame("android.app.Activity", "performCreate", 8968),
            frame("android.app.Instrumentation", "callActivityOnCreate", 1526),
            frame("android.app.ActivityThread", "performLaunchActivity", 3755),
            frame("android.app.ActivityThread", "handleLaunchActivity", 4235),
            frame("android.app.servertransaction.LaunchActivityItem", "execute", 112),
        )
        val signature = CrashSignature.of(launchFailure(npe))
        assertEquals("java.lang.RuntimeException", signature.exceptionClass)
        assertEquals("java.lang.NullPointerException", signature.causeClass)
        assertEquals(
            "android.app.Activity.performCreate:8990 android.app.Activity.performCreate:8968 android.app.Instrumentation.callActivityOnCreate:1526 " +
                "android.app.ActivityThread.performLaunchActivity:3755 android.app.ActivityThread.handleLaunchActivity:4235",
            signature.frames,
        )
        val event = AnalyticsEvent.AppCrashed(CrashProcess.App, CrashReason.Crash, "2026.11.1", signature)
        assertEquals(signature.frames, AnalyticsSchema.check(event.name, event.properties)?.get("crash_frames"))
        // A library class R8 keeps by name, alone, the same.
        val camera = IllegalStateException().at(frame("androidx.camera.core.ImageProxy", "getPlanes", 42), frame("android.os.Handler", "dispatchMessage", 107))
        assertEquals("androidx.camera.core.ImageProxy.getPlanes:42 android.os.Handler.dispatchMessage:107", CrashSignature.of(launchFailure(camera)).frames)
    }

    @Test
    fun aCrashWithOnlyThePlatformAndNoCauseIsItsOwnTopFrames() {
        assertEquals("dalvik.system.VMRuntime.newNonMovableArray:0", CrashSignature.of(OutOfMemoryError().at(frame("dalvik.system.VMRuntime", "newNonMovableArray", 0))).frames)
        // An innermost cause without a stack: the next one out that has one.
        val inner = NullPointerException().at()
        assertEquals("android.app.ActivityThread.performLaunchActivity:3782", CrashSignature.of(launchFailure(inner)).frames?.substringBefore(' '))
        assertNull(CrashSignature.of(OutOfMemoryError().at()).frames)
    }

    @Test
    fun aBundledLibraryUnderComAndroidIsThisBuildsCode() {
        // Play's pre-launch crawler starting Play Billing 8.3.0's ProxyBillingActivity with no extras, 2026-11-19.
        val npe = NullPointerException("Attempt to invoke virtual method 'android.content.IntentSender android.app.PendingIntent.getIntentSender()' on a null object reference").at(
            frame("android.app.PendingIntent", "getIntentSender", 1366),
            frame("com.android.billingclient.api.ProxyBillingActivity", "onCreate", 97),
            frame("android.app.Activity", "performCreate", 8990),
            frame("android.app.Activity", "performCreate", 8968),
            frame("android.app.Instrumentation", "callActivityOnCreate", 1526),
            frame("android.app.ActivityThread", "performLaunchActivity", 3755),
        )
        val launch = RuntimeException("Unable to start activity ComponentInfo{com.ex3ndr.happy/com.android.billingclient.api.ProxyBillingActivity}: $npe", npe)
            .at(*launchFailure(npe).stackTrace)
        val signature = CrashSignature.of(launch)
        assertEquals("java.lang.RuntimeException", signature.exceptionClass)
        assertEquals("java.lang.NullPointerException", signature.causeClass)
        assertEquals(
            "com.android.billingclient.api.ProxyBillingActivity.onCreate:97 android.app.Activity.performCreate:8990 android.app.Activity.performCreate:8968 " +
                "android.app.Instrumentation.callActivityOnCreate:1526 android.app.ActivityThread.performLaunchActivity:3755",
            signature.frames,
        )
        // The boot classpath's com.android packages are still the platform.
        for (platform in listOf("com.android.internal.os.ZygoteInit", "com.android.org.conscrypt.ConscryptEngine", "com.android.okhttp.internal.http.HttpEngine", "com.android.icu.util.Calendar", "com.android.server.am.ActivityManagerService")) {
            assertTrue(platform, CrashSignature.isPlatform(platform))
        }
        assertFalse(CrashSignature.isPlatform("com.android.billingclient.api.BillingClientImpl"))
        assertFalse(CrashSignature.isPlatform("com.android.installreferrer.api.InstallReferrerClientImpl"))
    }

    @Test
    fun anAppFrameStillWinsOverThePlatformFallback() {
        val npe = NullPointerException().at(
            frame("android.app.Activity", "performCreate", 8990),
            frame("ng0", "b", 41),
            frame("com.slopus.happy.MainActivity", "onCreate", 77),
        )
        assertEquals("ng0.b:41 com.slopus.happy.MainActivity.onCreate:77", CrashSignature.of(launchFailure(npe)).frames)
    }

    @Test
    fun longPlatformFramesAreFewerNotNone() {
        val long = "android.app.servertransaction.SomeVeryLongPlatformClassNameThatKeepsGoingOnAndOn"
        val stack = (1..5).map { frame("$long$it", "executeNonLifecycleItemWithAVeryLongName", 1000 + it) }.toTypedArray()
        val frames = CrashSignature.of(IllegalStateException().at(*stack)).frames!!
        assertTrue(frames.length <= AnalyticsSchema.MAX_FRAMES_LENGTH)
        assertTrue(AnalyticsSchema.isFrameList(frames))
        assertEquals(3, frames.split(' ').size)
    }

    @Test
    fun theRootCauseIsTheDeepestAndACycleEnds() {
        val root = UnsupportedOperationException()
        val middle = IllegalStateException(root)
        assertEquals("java.lang.UnsupportedOperationException", CrashSignature.of(RuntimeException(middle)).causeClass)
        val a = IllegalStateException()
        val b = IllegalArgumentException(a)
        a.initCause(b)
        assertEquals("java.lang.IllegalStateException", CrashSignature.of(b).causeClass)
    }

    @Test
    fun aFrameOrListTheCatalogWouldntTakeIsLeftOut() {
        val long = "com.slopus.happy." + "a".repeat(120)
        val stack = arrayOf(frame(long, "run", 1)) + (1..6).map { frame("com.slopus.happy.ui.SomeRatherLongClassNameForTestingTheLengthLimit$it", "invokeSuspend", it) }
        val frames = CrashSignature.frames(stack)!!
        assertFalse(frames.contains(long))
        assertTrue(frames.length <= AnalyticsSchema.MAX_FRAMES_LENGTH)
        assertTrue(AnalyticsSchema.isFrameList(frames))
        // Five of these would be 424 characters: the fifth is left out.
        assertEquals(4, frames.split(' ').size)
        // A Kotlin test name with spaces isn't a frame.
        assertNull(CrashSignature.frames(arrayOf(frame("com.slopus.happy.FooTest", "a crash happens", 3))))
    }

    @Test
    fun theCatalogsRulesHoldNamesAndFramesAndNothingElse() {
        assertTrue(AnalyticsSchema.isClassName("java.lang.IllegalArgumentException"))
        assertTrue(AnalyticsSchema.isClassName("com.slopus.happy.ui.start.GrainGradientKt\$ShaderGrainGradient\$1"))
        assertFalse(AnalyticsSchema.isClassName("Can't open https://happy.engineering."))
        assertFalse(AnalyticsSchema.isClassName("a".repeat(129)))
        assertTrue(AnalyticsSchema.isFrameList("g80.a:29 yk6.invoke:1214"))
        assertTrue("iOS's form", AnalyticsSchema.isFrameList("HappyApp+0x1a2b3c Foundation+0x44"))
        assertFalse("a double space", AnalyticsSchema.isFrameList("g80.a:29  yk6.invoke:1214"))
        assertFalse("six frames", AnalyticsSchema.isFrameList(List(6) { "a.b:$it" }.joinToString(" ")))
        assertFalse("a file name", AnalyticsSchema.isFrameList("g80.a(SourceFile:29)"))
        assertFalse("a path", AnalyticsSchema.isFrameList("/data/app/com.ex3ndr.happy/base.apk:1"))
        assertFalse(AnalyticsSchema.isFrameList(""))
        val crashed = mapOf("process" to "app", "reason" to "crash", "crashed_version" to "2026.11.1")
        assertNull(AnalyticsSchema.check("app_crashed", crashed + ("exception_class" to "java.lang.Exception: secret")))
        assertNull(AnalyticsSchema.check("app_crashed", crashed + ("signal" to 0)))
        assertNull(AnalyticsSchema.check("app_crashed", crashed + ("signal" to 65)))
        assertEquals(crashed + ("signal" to 11), AnalyticsSchema.check("app_crashed", crashed + ("signal" to 11)))
        assertEquals("the new ones are optional", crashed, AnalyticsSchema.check("app_crashed", crashed))
    }

    @Test
    fun aSignatureIsKeptUntilTheNextStartReadsIt() {
        val file = folder.root.resolve(CrashSignatures.FILE)
        val signatures = CrashSignatures(file)
        signatures.write(4242, storeCrash())
        val text = file.readText()
        assertFalse(text.contains("happy.engineering"))
        assertEquals(CrashSignatures.Kept(4242, CrashSignature.of(storeCrash())), signatures.take())
        assertFalse("deleted as it is read", file.exists())
        assertNull(signatures.take())
    }

    @Test
    fun aFileThatIsntOneIsDroppedAndAnythingOutsideTheRulesInItTooIsLeftOut() {
        val file = folder.root.resolve(CrashSignatures.FILE)
        val signatures = CrashSignatures(file)
        file.writeText("garbage")
        assertNull(signatures.take())
        assertFalse(file.exists())
        file.writeText("crash-signature-1\n7\nCan't open https://happy.engineering.\njava.lang.IllegalStateException\ng80.a(SourceFile:29)")
        assertEquals(CrashSignatures.Kept(7, CrashSignature(null, "java.lang.IllegalStateException", null)), signatures.take())
    }

    @Test
    fun onlyAnArmedProcessWritesAndTurningAnalyticsOffDeletesIt() {
        val file = folder.root.resolve(CrashSignatures.FILE)
        val signatures = CrashSignatures(file) { 4242 }
        val seen = mutableListOf<Throwable>()
        val before = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, error -> seen += error }
        try {
            signatures.install()
            val handler = Thread.getDefaultUncaughtExceptionHandler()!!
            val crash = storeCrash()
            handler.uncaughtException(Thread.currentThread(), crash)
            assertFalse("analytics off: nothing written", file.exists())
            signatures.arm(true)
            handler.uncaughtException(Thread.currentThread(), crash)
            assertEquals(4242, signatures.take()?.pid)
            handler.uncaughtException(Thread.currentThread(), crash)
            assertTrue(file.exists())
            // The handler before it still runs, every time: it is what ends the process.
            assertEquals(listOf(crash, crash, crash), seen)
            signatures.arm(false)
            assertFalse(file.exists())
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(before)
        }
    }

    @Test
    fun aSignatureGoesOnlyWithItsOwnProcesssCrash() {
        val kept = CrashSignatures.Kept(100, CrashSignature("java.lang.IllegalStateException", null, "a.b:1"))
        assertEquals(kept.signature, AppExits.signature(CrashReason.Crash, 100, kept))
        assertNull("an older crash's", AppExits.signature(CrashReason.Crash, 101, kept))
        assertNull("a native crash has none", AppExits.signature(CrashReason.NativeCrash, 100, kept))
        assertNull(AppExits.signature(CrashReason.Crash, 100, null))
        assertEquals(11, AppExits.signal(CrashReason.NativeCrash, 11))
        assertNull("a JVM crash's status isn't a signal", AppExits.signal(CrashReason.Crash, 11))
        assertNull(AppExits.signal(CrashReason.NativeCrash, 0))
        val event = AnalyticsEvent.AppCrashed(CrashProcess.App, CrashReason.Crash, "2026.11.1", kept.signature)
        assertEquals(
            mapOf("process" to "app", "reason" to "crash", "crashed_version" to "2026.11.1", "exception_class" to "java.lang.IllegalStateException", "crash_frames" to "a.b:1"),
            AnalyticsSchema.check(event.name, event.properties),
        )
    }
}
