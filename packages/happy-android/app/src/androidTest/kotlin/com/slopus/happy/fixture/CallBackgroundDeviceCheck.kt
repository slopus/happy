package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.call.CallAgent
import com.slopus.happy.call.CallContext
import com.slopus.happy.call.CallEnding
import com.slopus.happy.call.CallKeeper
import com.slopus.happy.call.CallModeChange
import com.slopus.happy.call.CallProbe
import com.slopus.happy.call.CallScreenMove
import com.slopus.happy.call.CallSendOutcome
import com.slopus.happy.call.CallSession
import com.slopus.happy.call.CallState
import com.slopus.happy.call.CallTarget
import com.slopus.happy.call.CallTargetState
import com.slopus.happy.call.CallTargets
import com.slopus.happy.call.ElevenLabsCallConnection
import com.slopus.happy.call.PublicAgentCallGrants
import com.slopus.happy.ui.call.CallFrame
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * A real call with the build's hosted agent behind other apps, with music
 * playing in another app: a stand-in music app if one is installed
 * (`dev.check.player`'s PlayerService: media focus, paused on a transient
 * loss and played on at the gain, as Spotify does), or Chrome playing the
 * `music` argument's address. The call is kept as CallController keeps it ([CallKeeper] once
 * the microphone is granted, [CallService]), over disposable conversations.
 * `dumpsys audio`, the services and notifications are written at each step
 * to the app's external files under `call-background/`, beside `steps.txt`.
 * The person's side is typed. With Chrome, `adb reverse` the address's port
 * to a server of the sound first. Each run is a billed conversation; keep it short.
 */
@RunWith(AndroidJUnit4::class)
class CallBackgroundDeviceCheck {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val dir = File(app.getExternalFilesDir(null), "call-background").apply { mkdirs() }
    private val music = InstrumentationRegistry.getArguments().getString("music")
    private val steps = StringBuilder()
    private val scope = MainScope()
    private val keeper = CallKeeper(app)
    private var connection: ElevenLabsCallConnection? = null
    private val endings = ArrayList<CallEnding>()

    private companion object {
        const val PLAYER = "dev.check.player"
    }

    private val conversations = listOf(CallTarget("task-0", "Ship the cache", CallTarget.Kind.Task, status = CallTarget.Status.Idle))

    private val targets = object : CallTargets {
        override suspend fun directory() = conversations
        override suspend fun state(agentId: String): CallTargetState? = null
        override suspend fun focused(): String? = null
        override suspend fun open(agentId: String) = false
        override suspend fun send(agentId: String, text: String, id: String, change: CallModeChange?) = CallSendOutcome.Queued
        override suspend fun follow(agentId: String, following: Boolean) {}
        override suspend fun draft(kind: CallTarget.Kind, name: String): CallTarget? = null
        override suspend fun discard(agentId: String) {}
        override suspend fun unlisted(agentId: String): CallTarget? = null
        override suspend fun back(): CallScreenMove = CallScreenMove.Refused("No screens here.")
        override suspend fun home(): CallScreenMove = CallScreenMove.Moved(true)
    }

    @After
    fun tearDown() {
        instrumentation.runOnMainSync { keeper.release() }
        scope.cancel()
        shell("am force-stop com.android.chrome")
        shell("am force-stop $PLAYER")
    }

    private fun shell(command: String): String =
        instrumentation.uiAutomation.executeShellCommand(command).let { fd ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().decodeToString() }
        }

    private fun step(name: String, session: CallSession?) {
        val line = "${SystemClock.elapsedRealtime()} $name: call ${session?.state?.value}, kept ${keeper.isKept}, endings $endings"
        steps.append(line).append('\n')
        android.util.Log.i("CallBackground", line)
        File(dir, "$name-audio.txt").writeText(shell("dumpsys audio"))
        File(dir, "$name-services.txt").writeText(shell("dumpsys activity services ${app.packageName}"))
        File(dir, "$name-notifications.txt").writeText(shell("dumpsys notification --noredact").lineSequence().filter { "com.slopus" in it || "CallStyle" in it || "android.title" in it }.joinToString("\n"))
        device.takeScreenshot(File(dir, "$name.png"))
    }

    private fun until(millis: Long, condition: () -> Boolean): Boolean {
        val end = SystemClock.elapsedRealtime() + millis
        while (SystemClock.elapsedRealtime() < end) {
            if (condition()) return true
            Thread.sleep(200)
        }
        return condition()
    }

    private fun pause(millis: Long) = Thread.sleep(millis)

    /** A session wired as CallController wires one: kept once the microphone is granted, let go once it isn't live. */
    private fun session(agentId: String): CallSession {
        lateinit var session: CallSession
        val context = CallContext(targets)
        instrumentation.runOnMainSync {
            session = CallSession(scope, PublicAgentCallGrants(agentId), permission = { true.also { keeper.keep(session.state) { session.stop() } } }, now = SystemClock::elapsedRealtime) { grant, request, events ->
                ElevenLabsCallConnection.connect(app, scope, grant, request, events).also { connection = it }
            }
            session.onEnded = { endings += it }
            session.onHangUp = { session.stop() }
            scope.launch { session.state.collect { if (it == CallState.Idle) keeper.release() } }
        }
        rule.setContent {
            HappyTheme(ThemePreference.Light) {
                CallFrame(session.state, MutableStateFlow(0f), onMute = session::toggleMute, onEnd = session::stop) { Box(Modifier.fillMaxSize()) }
            }
        }
        instrumentation.runOnMainSync { session.start(null, { context.initial() }, { call -> context.handle(call) }) }
        return session
    }

    private fun playMusic() {
        if (music != null) shell("am start -a android.intent.action.VIEW -d $music -n com.android.chrome/com.google.android.apps.chrome.Main")
        else shell("am start-foreground-service -n $PLAYER/.PlayerService")
    }

    private fun prepare(): String {
        val agentId = CallAgent.hostedAgentId
        assumeTrue("no agent ID in this build", agentId != null)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        CallProbe.reset()
        return agentId!!
    }

    /**
     * Music plays, the call starts in front and pauses it, then goes on at
     * home and with the screen off; the notification's Hang up ends it, and
     * the music plays on.
     */
    @Test
    fun aCallGoesOnBehindOtherAppsAndTheMusicPlaysOnAfter() {
        assumeTrue("no music app", music != null || "package:$PLAYER" in shell("pm list packages $PLAYER"))
        val agentId = prepare()
        try {
            playMusic()
            pause(6_000)
            step("0-music", null)
            // Back to the test's window, in front, where the call starts.
            shell("am start -n ${app.packageName}/${ComponentActivity::class.java.name} --activity-reorder-to-front")
            pause(1_500)
            val session = session(agentId)
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { CallProbe.lines.value.any { it.role == "agent" } }
            pause(2_000)
            step("1-call-in-front", session)
            instrumentation.runOnMainSync { connection?.type("Please tell me a long, slow story about a lighthouse keeper. Take at least a minute.") }
            pause(3_000)
            device.pressHome()
            pause(15_000)
            step("2-call-at-home", session)
            assertTrue("hung up at home: ${session.state.value}", session.state.value is CallState.Active)
            device.sleep()
            pause(20_000)
            step("3-call-screen-off", session)
            assertTrue("hung up with the screen off: ${session.state.value}", session.state.value is CallState.Active)
            device.wakeUp()
            shell("wm dismiss-keyguard")
            pause(1_500)
            device.openNotification()
            step("4-shade", session)
            hangUp().click()
            assertTrue("Hang up didn't end the call: ${session.state.value}", until(10_000) { session.state.value == CallState.Idle })
            device.pressBack()
            pause(4_000)
            step("5-after", session)
            assertEquals(listOf(CallEnding.HungUp), endings)
        } finally {
            File(dir, "steps.txt").writeText(steps.toString() + CallProbe.lines.value.joinToString("\n") { "${it.role}: ${it.text}" })
        }
    }

    /** The notification's Hang up, found in the shade; the hierarchy is written if it isn't. */
    private fun hangUp(): androidx.test.uiautomator.UiObject2 {
        val found = device.wait(Until.findObject(By.desc(java.util.regex.Pattern.compile("Hang up", java.util.regex.Pattern.CASE_INSENSITIVE))), 5_000)
        if (found == null) File(dir, "shade.xml").outputStream().use { device.dumpWindowHierarchy(it) }
        assertTrue("no Hang up in the shade", found != null)
        return found!!
    }

    /**
     * The service alone, with no provider: a live call it keeps shows the
     * ongoing notification as a microphone foreground service; Hang up ends
     * it, and once it isn't live the service and notification go.
     */
    @Test
    fun theNotificationsHangUpEndsTheCall() {
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        val state = MutableStateFlow<CallState>(CallState.Connecting)
        var ends = 0
        instrumentation.runOnMainSync { keeper.keep(state) { ends += 1; state.value = CallState.Idle } }
        pause(2_000)
        val connecting = shell("dumpsys activity services ${app.packageName}")
        assertTrue(connecting, "CallService" in connecting && "isForeground=true" in connecting && "types=0x00000080" in connecting)
        instrumentation.runOnMainSync { state.value = CallState.Active(com.slopus.happy.call.CallActivity.Listening, muted = true, since = SystemClock.elapsedRealtime() - 65_000) }
        device.pressHome()
        device.openNotification()
        pause(1_500)
        device.takeScreenshot(File(dir, "8-notification.png"))
        hangUp().click()
        assertTrue("Hang up never ended it", until(5_000) { ends == 1 })
        instrumentation.runOnMainSync { keeper.release() }
        pause(1_500)
        val after = shell("dumpsys activity services ${app.packageName}")
        assertTrue(after, "CallService" !in after)
        device.pressBack()
    }

    /** Another app takes the audio mid-call: the call ends as interrupted, and its focus goes. */
    @Test
    fun anotherAppTakingTheAudioEndsTheCall() {
        assumeTrue("no music app", music != null || "package:$PLAYER" in shell("pm list packages $PLAYER"))
        val agentId = prepare()
        try {
            val session = session(agentId)
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { CallProbe.lines.value.any { it.role == "agent" } }
            step("6-call", session)
            playMusic()
            assertTrue("music didn't end the call: ${session.state.value}", until(15_000) { session.state.value == CallState.Idle })
            pause(4_000)
            step("7-music-took-it", session)
            assertEquals(listOf(CallEnding.Interrupted), endings)
        } finally {
            File(dir, "steps.txt").writeText(steps.toString() + CallProbe.lines.value.joinToString("\n") { "${it.role}: ${it.text}" })
        }
    }
}
