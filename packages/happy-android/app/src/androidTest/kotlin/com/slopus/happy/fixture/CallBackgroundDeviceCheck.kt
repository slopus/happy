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

    /** A session wired as CallController wires one: kept once the microphone is granted, let go once it isn't live, waiting out a phone call to be made again. */
    private fun session(agentId: String): CallSession {
        lateinit var session: CallSession
        val context = CallContext(targets)
        instrumentation.runOnMainSync {
            val audio = app.getSystemService(android.media.AudioManager::class.java)
            val busy = { audio.mode == android.media.AudioManager.MODE_RINGTONE || audio.mode == android.media.AudioManager.MODE_IN_CALL || audio.mode == android.media.AudioManager.MODE_CALL_SCREENING }
            session = CallSession(scope, PublicAgentCallGrants(agentId), permission = { true.also { keeper.keep(session.state) { session.stop() } } }, now = SystemClock::elapsedRealtime, phoneBusy = busy) { grant, request, events ->
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

    /** Music started mid-call: as a phone call refuses it, the call takes the audio back and goes on; the music plays after. */
    @Test
    fun anotherAppsMusicDoesNotEndTheCall() {
        assumeTrue("no music app", music != null || "package:$PLAYER" in shell("pm list packages $PLAYER"))
        val agentId = prepare()
        try {
            val session = session(agentId)
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { CallProbe.lines.value.any { it.role == "agent" } }
            step("6-call", session)
            playMusic()
            pause(10_000)
            step("7-music-started", session)
            assertTrue("music ended the call: ${session.state.value}", session.state.value is CallState.Active)
            assertEquals(emptyList<CallEnding>(), endings)
            instrumentation.runOnMainSync { session.stop() }
            pause(4_000)
            step("8-after", session)
        } finally {
            File(dir, "steps.txt").writeText(steps.toString() + CallProbe.lines.value.joinToString("\n") { "${it.role}: ${it.text}" })
        }
    }

    /**
     * A phone call while the call is live, the call kept as in the
     * background. The host rings the emulator once this logs
     * `ready for a phone call` (`adb emu gsm call`), and either cancels it
     * after 8 s, or ([answered]) accepts it and hangs up 150 s later, past
     * the provider's 120 s silence timeout. Either way the call is held
     * meanwhile and goes on after, made again with this one carried over if
     * its connection went. Each state change is in `steps.txt`.
     */
    private fun phoneCall(name: String, answered: Boolean) {
        val agentId = prepare()
        try {
            val session = session(agentId)
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { CallProbe.lines.value.any { it.role == "agent" } }
            device.pressHome()
            pause(2_000)
            step("$name-0-before", session)
            android.util.Log.i("CallBackground", "ready for a phone call")
            assertTrue("never held: ${session.state.value}", until(30_000) { (session.state.value as? CallState.Active)?.held == true })
            step("$name-1-held", session)
            if (answered) {
                pause(60_000)
                step("$name-2-on-the-phone", session)
                assertTrue("ended on hold: ${session.state.value}", session.state.value.isLive)
            }
            assertTrue("never back: ${session.state.value}", until(if (answered) 150_000 else 30_000) { (session.state.value as? CallState.Active)?.held == false })
            pause(3_000)
            step("$name-3-back", session)
            assertTrue("ended unasked: $endings", endings.all { it == CallEnding.Interrupted })
            if (!answered) assertEquals(emptyList<CallEnding>(), endings)
            instrumentation.runOnMainSync { connection?.type("Are you still there? Answer in a few words.") }
            val before = CallProbe.lines.value.count { it.role == "agent" }
            assertTrue("no answer after the hold", until(30_000) { CallProbe.lines.value.count { it.role == "agent" } > before })
            step("$name-4-answered", session)
            instrumentation.runOnMainSync { session.stop() }
        } finally {
            File(dir, "steps.txt").writeText(steps.toString() + CallProbe.lines.value.joinToString("\n") { "${it.role}: ${it.text}" })
        }
    }

    @Test
    fun aRingingPhoneCallHoldsTheCallUntilItStops() = phoneCall("ring", answered = false)

    @Test
    fun aLongAnsweredPhoneCallHoldsTheCallUntilItEnds() = phoneCall("answer", answered = true)

    /** The phone in Doze with the screen off: the call still hears and answers, through its foreground service. */
    @Test
    fun aCallGoesOnInDoze() {
        val agentId = prepare()
        try {
            val session = session(agentId)
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { CallProbe.lines.value.any { it.role == "agent" } }
            device.pressHome()
            device.sleep()
            pause(2_000)
            shell("dumpsys battery unplug")
            val idle = shell("dumpsys deviceidle force-idle")
            pause(40_000)
            step("doze-0-idle", session)
            File(dir, "doze-deviceidle.txt").writeText(idle + "\n" + shell("dumpsys deviceidle"))
            assertTrue("ended in Doze: ${session.state.value}", session.state.value is CallState.Active)
            val before = CallProbe.lines.value.count { it.role == "agent" }
            instrumentation.runOnMainSync { connection?.type("Say the word banana.") }
            assertTrue("no answer in Doze", until(30_000) { CallProbe.lines.value.count { it.role == "agent" } > before })
            step("doze-1-answered", session)
            instrumentation.runOnMainSync { session.stop() }
        } finally {
            shell("dumpsys deviceidle unforce")
            shell("dumpsys battery reset")
            device.wakeUp()
            File(dir, "steps.txt").writeText(steps.toString() + CallProbe.lines.value.joinToString("\n") { "${it.role}: ${it.text}" })
        }
    }

    /**
     * Notifications switched off (the host revokes POST_NOTIFICATIONS first):
     * the service still keeps the call, with no notification in the shade.
     */
    @Test
    fun withoutNotificationsTheServiceStillKeepsTheCall() {
        assumeTrue("notifications allowed", androidx.core.app.NotificationManagerCompat.from(app).areNotificationsEnabled().not())
        val state = MutableStateFlow<CallState>(CallState.Active(com.slopus.happy.call.CallActivity.Listening, muted = false, since = SystemClock.elapsedRealtime()))
        instrumentation.runOnMainSync { keeper.keep(state) { state.value = CallState.Idle } }
        device.pressHome()
        pause(5_000)
        val services = shell("dumpsys activity services ${app.packageName}")
        File(dir, "no-notifications-services.txt").writeText(services)
        assertTrue(services, "CallService" in services && "isForeground=true" in services)
        instrumentation.runOnMainSync { state.value = CallState.Idle }
    }
}
