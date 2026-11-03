package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.call.CallActivity
import com.slopus.happy.call.CallSession
import com.slopus.happy.call.CallState
import com.slopus.happy.call.CallToolResult
import com.slopus.happy.call.UnconfiguredCallGrants
import com.slopus.happy.ui.call.CallFrame
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.sin

/**
 * The voice call's button and bar on a device, over a synthetic agent home.
 * `realTap` presses the voice button with the only grant source there is
 * ([UnconfiguredCallGrants]): no microphone is asked for and no provider is
 * reached. The `fixture*` shots draw the bar from a script, with no call at
 * all. Shots go to the app's external files under `call-bar/`; `cycle`
 * runs the fixture states through for a screen recording.
 * Run on an assigned emulator, not someone's phone.
 */
@RunWith(AndroidJUnit4::class)
class CallBarDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val dir = File(app.getExternalFilesDir(null), "call-bar").apply { mkdirs() }
    private val dark = InstrumentationRegistry.getArguments().getString("dark") == "1"

    private val state = MutableStateFlow<CallState>(CallState.Idle)
    private val level = MutableStateFlow(0f)

    private fun feed(): AgentFeed {
        val rows = ArrayList<AgentFeedRow>()
        fun conversation(id: String, kind: ConversationKind, title: String, working: Boolean = false) =
            AgentFeedRow.Conversation(agentId = id, title = title, kind = kind, depth = 0, working = working, activityAt = 1_755_400_000_000L)
        rows += AgentFeedRow.Section(AgentFeedSection.Bots)
        listOf("Chief of Staff", "Release captain", "Inbox triage").forEachIndexed { i, t -> rows += conversation("bot-$i", ConversationKind.Bot, t) }
        rows += AgentFeedRow.Section(AgentFeedSection.Tasks)
        listOf("Fix login redirect", "Write release notes", "Plan the sprint", "Ship the cache", "iPad split view").forEachIndexed { i, t ->
            rows += conversation("task-$i", ConversationKind.Task, t, working = i == 0)
        }
        return AgentFeed(loaded = true, rows = rows)
    }

    private fun show(onVoice: () -> Unit, calls: MutableStateFlow<CallState> = state) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                CallFrame(calls, level, onMute = {}, onEnd = { calls.value = CallState.Idle }) {
                    val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
                    AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = onVoice))
                }
            }
        }
        rule.waitForIdle()
    }

    /**
     * The test's frame clock, moved on in step with the real one: the waves
     * never stop while a call is live, so it is never idle to wait for.
     */
    private fun run(millis: Long) {
        rule.mainClock.autoAdvance = false
        val start = SystemClock.elapsedRealtime()
        var last = start
        while (true) {
            val now = SystemClock.elapsedRealtime()
            if (now - start >= millis) break
            // However slowly the emulator draws, the frames keep the wall clock's time.
            rule.mainClock.advanceTimeBy(maxOf(16L, now - last))
            last = now
        }
    }

    private fun capture(name: String) {
        // The bar's slide (0.3 s) over, then a moment of waves.
        rule.mainClock.autoAdvance = false
        rule.mainClock.advanceTimeBy(600)
        run(400)
        device.takeScreenshot(File(dir, "${if (dark) "dark" else "light"}-$name.png"))
        android.util.Log.i("CallBarShots", "captured $name")
    }

    @Test
    fun home() {
        show(onVoice = {})
        capture("home")
    }

    /** The voice button pressed for real, with no grant to be had: the bar says so at once. */
    @Test
    fun realTap() {
        lateinit var session: CallSession
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            val scope = rememberCoroutineScope()
            session = remember {
                CallSession(scope, UnconfiguredCallGrants, permission = { error("no microphone without a grant") }, now = SystemClock::elapsedRealtime) { _, _, _ ->
                    error("no provider without a grant")
                }
            }
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                CallFrame(session.state, level, onMute = session::toggleMute, onEnd = session::stop) {
                    val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
                    AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {
                        session.start(null, { "" }, { CallToolResult("") })
                    }))
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithTag(AgentHomeTags.VOICE, useUnmergedTree = true).performClick()
        capture("real-tap")
    }

    @Test
    fun fixtures() {
        show(onVoice = {})
        val since = SystemClock.elapsedRealtime() - 42_000
        for ((name, value) in listOf(
            "connecting" to CallState.Connecting,
            "listening" to CallState.Active(CallActivity.Listening, false, since),
            "speaking" to CallState.Active(CallActivity.AgentSpeaking, false, since),
            "muted" to CallState.Active(CallActivity.Listening, true, since),
        )) {
            state.value = value
            level.value = if (name == "speaking") 1.2f else 0f
            capture("fixture-$name")
        }
    }

    /** The fixture states one after another, for `screenrecord`: about 20 s. */
    @Test
    fun cycle() {
        show(onVoice = {})
        val since = SystemClock.elapsedRealtime()
        val script = listOf(
            CallState.Idle to 2_000L, CallState.Connecting to 2_000L, CallState.Active(CallActivity.Listening, false, since) to 2_000L,
            CallState.Active(CallActivity.AgentSpeaking, false, since) to 4_000L, CallState.Active(CallActivity.UserSpeaking, false, since) to 3_000L,
            CallState.Active(CallActivity.Listening, true, since) to 2_000L, CallState.Idle to 2_000L,
            CallState.Active(CallActivity.AgentSpeaking, false, since) to 3_000L, CallState.Idle to 1_500L,
        )
        var phase = 0.0
        for ((value, millis) in script) {
            state.value = value
            val speaking = value is CallState.Active && value.activity != CallActivity.Listening && !value.muted
            val until = SystemClock.elapsedRealtime() + millis
            while (SystemClock.elapsedRealtime() < until) {
                phase += 0.12
                level.value = if (speaking) (0.7 + 0.6 * sin(phase) * sin(phase * 0.37)).toFloat() else 0f
                run(100)
            }
        }
    }
}
