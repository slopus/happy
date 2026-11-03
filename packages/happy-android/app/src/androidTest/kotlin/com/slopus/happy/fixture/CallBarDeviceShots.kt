package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import com.slopus.happy.R
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.ui.call.CallBarTags
import com.slopus.happy.ui.components.PageDialog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
import com.slopus.happy.ui.call.CallPaywall
import com.slopus.happy.ui.call.SheetStatusIcons
import com.slopus.happy.call.CallOffer
import com.slopus.happy.call.CallProblem
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
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.test.uiautomator.By
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

    /** With the status bar hidden, the bar is its 48 dp least: Mute and End take a whole 48 dp touch, none of it off screen. */
    @Test
    fun withoutStatusBar() {
        show(onVoice = {})
        rule.runOnUiThread {
            val window = rule.activity.window
            WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.statusBars())
        }
        // The status bar's own slide away, before the call.
        run(1_500)
        state.value = CallState.Active(CallActivity.Listening, false, SystemClock.elapsedRealtime() - 42_000)
        capture("no-status-bar")
        run(500)
        val least = (48 * app.resources.displayMetrics.density).toInt() - 1
        for (name in listOf(R.string.call_mute, R.string.call_end)) {
            val box = device.findObject(By.desc(app.getString(name))).visibleBounds
            android.util.Log.i("CallBarShots", "no status bar: ${app.getString(name)}=$box")
            assertTrue("${app.getString(name)} starts on screen ($box)", box.top >= 0)
            assertTrue("${app.getString(name)} is a whole 48 dp touch ($box, $least)", box.height() >= least && box.width() >= least)
        }
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

    /**
     * A full-window dialog of the app's covers the window the bar is in: it
     * carries the bar itself, its content below it, and End there ends the
     * call, after which the content takes the top back. A centred card leaves
     * the bar where it is.
     */
    @Test
    fun overDialogs() {
        val full = MutableStateFlow(false)
        val card = MutableStateFlow(false)
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                CallFrame(state, level, onMute = {}, onEnd = { state.value = CallState.Idle }) {
                    val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
                    AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {}))
                    val showFull by full.collectAsState()
                    val showCard by card.collectAsState()
                    if (showFull) {
                        PageDialog({ full.value = false }, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
                            Box(Modifier.fillMaxSize().background(Color(0xFF101010)).windowInsetsPadding(WindowInsets.statusBars)) {
                                Text("Viewer top", color = Color.White, modifier = Modifier.testTag("dialog-top"))
                            }
                        }
                    }
                    if (showCard) {
                        PageDialog({ card.value = false }, DialogProperties()) {
                            Box(Modifier.background(Color.White).padding(24.dp)) { Text("A card", modifier = Modifier.testTag("card")) }
                        }
                    }
                }
            }
        }
        rule.waitForIdle()
        state.value = CallState.Active(CallActivity.Listening, false, SystemClock.elapsedRealtime() - 42_000)
        rule.mainClock.autoAdvance = false
        run(800)
        full.value = true
        run(1_200)
        // As TalkBack is given them: a cleared node's children are left out of the merged tree.
        val bars = rule.onAllNodesWithTag(CallBarTags.BAR).fetchSemanticsNodes()
        val barBottom = bars.maxOf { it.boundsInRoot.bottom }
        val top = rule.onNodeWithTag("dialog-top", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        android.util.Log.i("CallBarShots", "dialog: bars read=${bars.size} barBottom=$barBottom contentTop=$top")
        assertEquals("the dialog carries its own bar; the window's under it is covered", 1, bars.size)
        assertEquals(1, rule.onAllNodesWithTag(CallBarTags.COVERED).fetchSemanticsNodes().size)
        // The covered one under it is left out: TalkBack reads the call once, from the dialog's.
        val read = rule.onAllNodes(hasContentDescription("Voice call", substring = true)).fetchSemanticsNodes()
        assertEquals("one bar read", 1, read.size)
        assertEquals("the end button read is the dialog's", 1, rule.onAllNodes(hasContentDescription(app.getString(R.string.call_end))).fetchSemanticsNodes().size)
        assertTrue("the dialog's content starts below its bar ($top < $barBottom)", top >= barBottom - 1)
        device.takeScreenshot(File(dir, "${if (dark) "dark" else "light"}-over-full-dialog.png"))
        // End in the dialog's bar ends the call; the content takes the top back.
        rule.onAllNodesWithTag(CallBarTags.END).fetchSemanticsNodes().size.let { assertEquals(1, it) }
        rule.onAllNodesWithTag(CallBarTags.END)[0].performClick()
        run(1_000)
        val after = rule.onNodeWithTag("dialog-top", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        android.util.Log.i("CallBarShots", "dialog after hang-up: contentTop=$after state=${state.value}")
        assertEquals(CallState.Idle, state.value)
        assertTrue("the content takes the top back ($after vs $top)", after < top)
        device.takeScreenshot(File(dir, "${if (dark) "dark" else "light"}-full-dialog-after.png"))
        full.value = false
        state.value = CallState.Active(CallActivity.Listening, false, SystemClock.elapsedRealtime() - 42_000)
        run(800)
        card.value = true
        run(1_200)
        assertEquals("a card leaves the one bar", 1, rule.onAllNodesWithTag(CallBarTags.BAR, useUnmergedTree = true).fetchSemanticsNodes().size)
        device.takeScreenshot(File(dir, "${if (dark) "dark" else "light"}-under-card-dialog.png"))
    }

    /** A Material bottom sheet as the app uses one (the link menu) stays below the bar and only dims it. */
    @OptIn(ExperimentalMaterial3Api::class)
    @Test
    fun underSheet() {
        val sheet = MutableStateFlow(false)
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                CallFrame(state, level, onMute = {}, onEnd = { state.value = CallState.Idle }) {
                    val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
                    AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {}))
                    val showSheet by sheet.collectAsState()
                    if (showSheet) {
                        ModalBottomSheet(onDismissRequest = { sheet.value = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
                            SheetStatusIcons()
                            Column(Modifier.fillMaxWidth().padding(24.dp)) {
                                repeat(4) { Text("Sheet row ${it + 1}", modifier = Modifier.padding(vertical = 12.dp)) }
                            }
                        }
                    }
                }
            }
        }
        rule.waitForIdle()
        state.value = CallState.Active(CallActivity.Listening, false, SystemClock.elapsedRealtime() - 42_000)
        rule.mainClock.autoAdvance = false
        run(800)
        sheet.value = true
        run(1_500)
        val barEnd = device.findObject(By.desc(app.getString(R.string.call_end)))
        val row = device.findObject(By.text("Sheet row 1"))
        android.util.Log.i("CallBarShots", "sheet: end=${barEnd?.visibleBounds} firstRow=${row?.visibleBounds}")
        assertTrue("the sheet is there", row != null)
        assertTrue("the sheet stays below the bar", barEnd == null || row.visibleBounds.top > barEnd.visibleBounds.bottom)
        device.takeScreenshot(File(dir, "${if (dark) "dark" else "light"}-under-sheet.png"))
        sheet.value = false
        run(800)
    }

    /** Free time used: the bar says so, a tap on it is the paywall, which sells nothing yet. */
    @Test
    fun paywall() {
        val paywall = MutableStateFlow(false)
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                CallFrame(state, level, onMute = {}, onEnd = { state.value = CallState.Idle }, onPaywall = { paywall.value = true }) {
                    val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
                    AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {}))
                    val shown by paywall.collectAsState()
                    if (shown) CallPaywall(freeAgain = System.currentTimeMillis() + 26 * 3_600_000L, offer = CallOffer.Unavailable, onDismiss = { paywall.value = false })
                }
            }
        }
        rule.waitForIdle()
        state.value = CallState.Ended(CallProblem.LimitReached)
        rule.waitForIdle()
        rule.onNode(hasContentDescription(app.getString(R.string.call_limit), substring = true)).performClick()
        rule.waitForIdle()
        Thread.sleep(800)
        val offer = device.findObject(By.text(app.getString(R.string.call_paywall_unavailable)))
        val bar = device.findObject(By.text(app.getString(R.string.call_limit)))
        android.util.Log.i("CallBarShots", "paywall: offer=${offer?.visibleBounds} bar=${bar?.visibleBounds}")
        assertTrue("the paywall is there", offer != null)
        device.takeScreenshot(File(dir, "${if (dark) "dark" else "light"}-paywall.png"))
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
