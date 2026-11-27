package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.HappyApplication
import com.slopus.happy.MainActivity
import com.slopus.happy.OpenAccount
import com.slopus.happy.call.CallAgent
import com.slopus.happy.call.CallProbe
import com.slopus.happy.call.CallState
import com.slopus.happy.payments.OfferSheet
import com.slopus.happy.ui.call.CallBarTags
import com.slopus.happy.ui.connection.AgentHomeTags
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * One real call on the Happy CLI account this phone has open, through the
 * app itself: its home's voice button, the build's hosted agent, and the
 * account's real sessions, so what it sends reaches their computers. The
 * person's side is typed, not spoken: each `prompts` argument (split on
 * `|`) goes in once the agent is quiet. Then mute and end from the bar.
 * With `used` set, the free time is spent first and the tap must show the
 * used-up sheet instead (the one allowance every call counts against).
 * Runs only when asked for by name (`-e live 1`): it is a billed conversation
 * that reaches real sessions. Skipped too without an agent ID or a Happy
 * account open. Shots and `live.txt` (what was said and the tools run) go to
 * the app's external files under `relay-live/`; nothing goes to logcat.
 */
@RunWith(AndroidJUnit4::class)
class LegacyCallLiveDeviceCheck {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val graph by lazy { (app.applicationContext as HappyApplication).graph }
    private val arguments = InstrumentationRegistry.getArguments()
    private val prompts = arguments.getString("prompts").orEmpty().split("|").map { it.trim() }.filter { it.isNotEmpty() }
    private val dir = File(app.getExternalFilesDir(null), "relay-live").apply { mkdirs() }

    private fun until(millis: Long, condition: () -> Boolean): Boolean {
        val end = SystemClock.elapsedRealtime() + millis
        while (SystemClock.elapsedRealtime() < end) {
            if (condition()) return true
            // The bar's level animates for as long as the call is up: the clock is driven, never waited idle.
            if (!rule.mainClock.autoAdvance) rule.mainClock.advanceTimeBy(100)
            Thread.sleep(100)
        }
        return condition()
    }

    private fun shot(name: String) {
        until(500) { false }
        device.takeScreenshot(File(dir, "$name.png"))
    }

    private val agentLines get() = CallProbe.lines.value.count { it.role == "agent" }

    @Test
    fun aRealCallOnTheOpenHappyAccount() {
        assumeTrue("a live call only with -e live 1", arguments.getString("live") == "1")
        assumeTrue("no agent ID in this build", CallAgent.hostedAgentId != null)
        assumeTrue("no Happy account open", graph.openAccount.value is OpenAccount.Happy)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        val used = arguments.getString("used") == "1"
        rule.runOnUiThread { graph.calls.applyTestEnvironment("seen", used, null) }
        CallProbe.reset()
        assertTrue("no voice button on home", until(30_000) {
            rule.onAllNodes(androidx.compose.ui.test.hasTestTag(AgentHomeTags.VOICE), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        })
        rule.waitForIdle()
        shot("home")
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag(AgentHomeTags.VOICE, useUnmergedTree = true).performClick()
        if (used) {
            assertTrue("the used-up sheet never showed", until(10_000) { graph.offers.sheet.value is OfferSheet.Used })
            Thread.sleep(1_500)
            shot("used-up")
            rule.runOnUiThread { graph.offers.dismiss() }
            assertTrue("a call started with no time left", !graph.calls.state.value.isLive)
            return
        }
        val log = StringBuilder()
        try {
            assertTrue("never connected: ${graph.calls.state.value}", until(30_000) { graph.calls.state.value is CallState.Active && CallProbe.live != null })
            until(15_000) { agentLines > 0 }
            shot("connected")
            prompts.forEachIndexed { index, prompt ->
                val before = agentLines
                rule.runOnUiThread { CallProbe.live?.type(prompt) }
                until(45_000) { agentLines > before }
                // Its tools and its last words.
                until(4_000) { false }
                shot("answer-${index + 1}")
            }
            rule.onNodeWithTag(CallBarTags.MUTE, useUnmergedTree = true).performClick()
            until(1_500) { false }
            shot("muted")
            rule.onNodeWithTag(CallBarTags.END, useUnmergedTree = true).performClick()
            assertTrue("the call never ended", until(10_000) { !graph.calls.state.value.isLive })
            until(1_500) { false }
            shot("ended")
        } finally {
            if (graph.calls.state.value.isLive) rule.runOnUiThread { graph.calls.close() }
            CallProbe.lines.value.forEach { log.append("${it.role}: ${it.text}\n") }
            CallProbe.tools.value.forEach { log.append("TOOL ${it.name} ${it.parameters} -> ${if (it.isError) "ERROR " else ""}${it.result}\n") }
            CallProbe.sent.value.forEach { log.append("CONTEXT ${it.kind} ${it.bytes} bytes\n") }
            File(dir, "live.txt").writeText(log.toString())
        }
    }
}
