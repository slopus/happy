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
import com.slopus.happy.call.CallAgent
import com.slopus.happy.call.CallContext
import com.slopus.happy.call.CallMessage
import com.slopus.happy.call.CallProbe
import com.slopus.happy.call.CallSendOutcome
import com.slopus.happy.call.CallSession
import com.slopus.happy.call.CallState
import com.slopus.happy.call.CallTarget
import com.slopus.happy.call.CallTargetState
import com.slopus.happy.call.CallTargets
import com.slopus.happy.call.ElevenLabsCallConnection
import com.slopus.happy.call.PublicAgentCallGrants
import com.slopus.happy.ui.call.CallFrame
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlinx.coroutines.runBlocking

/**
 * One real call with the build's hosted agent (iOS `CallLiveCheck`): the
 * voice button pressed over a home of disposable conversations, the real
 * provider and the real client tools, nothing reaching a computer. The
 * person's side is typed, not spoken: each `prompt` argument line goes in
 * as a user message once the agent is quiet, so no room is ever listened to
 * (the emulator's microphone hears nothing). Skipped without an agent ID.
 * Writes shots and `live.txt` to the app's external files under `call-live/`.
 * Each run is a billed conversation; keep it short.
 */
@RunWith(AndroidJUnit4::class)
class CallLiveDeviceCheck {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val dir = File(app.getExternalFilesDir(null), "call-live").apply { mkdirs() }
    private val prompts = (InstrumentationRegistry.getArguments().getString("prompts") ?: "What sessions do I have?")
        .split("|").map { it.trim() }.filter { it.isNotEmpty() }

    private val conversations = listOf(
        CallTarget("bot-0", "Research Assistant", CallTarget.Kind.Bot, status = CallTarget.Status.Idle),
        CallTarget("task-0", "iPad split view", CallTarget.Kind.Task, status = CallTarget.Status.Idle),
        CallTarget("task-1", "Ship the cache", CallTarget.Kind.Task, status = CallTarget.Status.Idle),
        CallTarget("task-2", "Release notes", CallTarget.Kind.Task, status = CallTarget.Status.Idle),
    )

    /** The disposable computer: what is sent stays in this list. */
    private inner class Targets : CallTargets {
        val sent = ArrayList<Pair<String, String>>()
        override suspend fun directory() = conversations
        override suspend fun state(agentId: String): CallTargetState? = conversations.firstOrNull { it.agentId == agentId }?.let {
            CallTargetState(it, listOf(CallMessage("m-$agentId", CallMessage.Role.Assistant, "Done for now: ${it.title} is ready for review.", 1_755_400_000_000L)))
        }
        override suspend fun focused(): String? = null
        override suspend fun open(agentId: String) = conversations.any { it.agentId == agentId }
        override suspend fun send(agentId: String, text: String, id: String): CallSendOutcome {
            sent += agentId to text
            return CallSendOutcome.Queued
        }
        override suspend fun follow(agentId: String, following: Boolean) {}
    }

    private fun feed() = AgentFeed(loaded = true, rows = buildList {
        add(AgentFeedRow.Section(AgentFeedSection.Bots))
        add(AgentFeedRow.Conversation(agentId = "bot-0", title = "Research Assistant", kind = ConversationKind.Bot, depth = 0, activityAt = 1_755_400_000_000L))
        add(AgentFeedRow.Section(AgentFeedSection.Tasks))
        conversations.drop(1).forEach { add(AgentFeedRow.Conversation(agentId = it.agentId, title = it.title, kind = ConversationKind.Task, depth = 0, activityAt = 1_755_400_000_000L)) }
    })

    private var connection: ElevenLabsCallConnection? = null

    private fun until(millis: Long, condition: () -> Boolean): Boolean {
        val end = SystemClock.elapsedRealtime() + millis
        while (SystemClock.elapsedRealtime() < end) {
            if (condition()) return true
            rule.mainClock.advanceTimeBy(100)
            Thread.sleep(100)
        }
        return condition()
    }

    @Test
    fun aRealCallAnswersAndRunsItsTools() {
        val agentId = CallAgent.hostedAgentId
        assumeTrue("no agent ID in this build", agentId != null)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        CallProbe.reset()
        val targets = Targets()
        val context = CallContext(targets)
        val level = MutableStateFlow(0f)
        lateinit var session: CallSession
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            val scope = rememberCoroutineScope()
            session = remember {
                CallSession(scope, PublicAgentCallGrants(agentId!!), permission = { true }, now = SystemClock::elapsedRealtime) { grant, request, events ->
                    ElevenLabsCallConnection.connect(app, scope, grant, request, events).also { connection = it }
                }.also { it.onLevel = { value -> level.value = value } }
            }
            HappyTheme(ThemePreference.Light) {
                CallFrame(session.state, level, onMute = session::toggleMute, onEnd = session::stop) {
                    val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
                    AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {
                        session.start(null, { context.initial() }, { call -> context.handle(call) })
                    }))
                }
            }
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag(AgentHomeTags.VOICE, useUnmergedTree = true).performClick()
        val live = until(30_000) { session.state.value is CallState.Active }
        device.takeScreenshot(File(dir, "connected.png"))
        val log = StringBuilder()
        try {
            assertTrue("never connected: ${session.state.value}", live)
            until(15_000) { CallProbe.lines.value.any { it.role == "agent" } }
            prompts.forEachIndexed { index, prompt ->
                val before = CallProbe.lines.value.count { it.role == "agent" }
                rule.runOnUiThread { connection?.type(prompt) }
                CallProbe.line("user", prompt)
                until(30_000) { CallProbe.lines.value.count { it.role == "agent" } > before }
                until(3_000) { false }
                device.takeScreenshot(File(dir, "answer-${index + 1}.png"))
            }
        } finally {
            rule.runOnUiThread { session.stop() }
            until(2_000) { false }
            CallProbe.lines.value.forEach { log.append("${it.role}: ${it.text}\n") }
            CallProbe.tools.value.forEach { log.append("TOOL ${it.name} ${it.parameters} -> ${it.result}\n") }
            targets.sent.forEach { log.append("SENT ${it.first}: ${it.second}\n") }
            CallProbe.sent.value.forEach { log.append("CONTEXT ${it.kind} ${it.bytes} bytes\n") }
            File(dir, "live.txt").writeText(log.toString())
            android.util.Log.i("HappyCall", "live check done\n$log")
        }
        assertTrue("the agent never answered", CallProbe.lines.value.count { it.role == "agent" } > 1)
    }

    /**
     * A conversation's new words reaching a real call (iOS `CallLiveCheck`'s
     * incoming part), with no LLM step needed to drive them: the call visits
     * five disposable conversations in turn, the first one's agent writes a
     * reply in pieces while it is followed, then it drops out as the fifth is
     * visited, writes while it isn't heard, and is visited again. What went
     * into the call's context is checked against what should have: the
     * pieces as `assistant_text` deltas with one `final`, nothing while it
     * was out, no replay of what it wrote then, and the next new words
     * again. None of it makes the agent speak; one typed question at the end
     * asks what was said. Each run is a billed conversation; keep it short.
     */
    @Test
    fun aConversationsNewWordsReachTheCall() {
        val agentId = CallAgent.hostedAgentId
        assumeTrue("no agent ID in this build", agentId != null)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        CallProbe.reset()
        val five = conversations + CallTarget("task-3", "Fix login redirect", CallTarget.Kind.Task, status = CallTarget.Status.Idle)
        val states = five.associate { it.agentId to CallTargetState(it, listOf(CallMessage("m0-${it.agentId}", CallMessage.Role.Assistant, "Earlier: ${it.title} was set up.", 1_755_400_000_000L))) }.toMutableMap()
        val targets = object : CallTargets {
            override suspend fun directory() = five
            override suspend fun state(agentId: String): CallTargetState? = states[agentId]
            override suspend fun focused(): String? = null
            override suspend fun open(agentId: String) = agentId in states
            override suspend fun send(agentId: String, text: String, id: String) = CallSendOutcome.Queued
            override suspend fun follow(agentId: String, following: Boolean) {}
        }
        val context = CallContext(targets)
        val level = MutableStateFlow(0f)
        lateinit var session: CallSession
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            val scope = rememberCoroutineScope()
            session = remember {
                CallSession(scope, PublicAgentCallGrants(agentId!!), permission = { true }, now = SystemClock::elapsedRealtime) { grant, request, events ->
                    ElevenLabsCallConnection.connect(app, scope, grant, request, events).also { connection = it }
                }
            }
            HappyTheme(ThemePreference.Light) {
                CallFrame(session.state, level, onMute = session::toggleMute, onEnd = session::stop) {
                    val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
                    AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {
                        session.start(null, { context.initial() }, { call -> context.handle(call) })
                    }))
                }
            }
        }
        // What the screen does: a visit, then the conversation's state as following it gives it.
        fun deliver(update: com.slopus.happy.call.CallUpdate) = rule.runOnUiThread { session.deliver(update) }
        fun visit(id: String) {
            deliver(runBlocking { context.focusChanged(id) })
            deliver(runBlocking { context.targetChanged(states.getValue(id)) })
        }
        fun write(id: String, message: String, text: String, final: Boolean) {
            val old = states.getValue(id)
            states[id] = old.copy(messages = old.messages.filter { it.id != message } + CallMessage(message, CallMessage.Role.Assistant, text, 1_755_500_000_000L, final = final), working = !final)
            deliver(runBlocking { context.targetChanged(states.getValue(id)) })
        }
        fun updates() = CallProbe.sent.value.filter { it.kind == "update" }.map { it.text }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag(AgentHomeTags.VOICE, useUnmergedTree = true).performClick()
        val live = until(30_000) { session.state.value is CallState.Active }
        val log = StringBuilder()
        try {
            assertTrue("never connected: ${session.state.value}", live)
            until(15_000) { CallProbe.lines.value.any { it.role == "agent" } }
            // Let the greeting finish before anything goes in.
            until(6_000) { false }
            val spokenBefore = CallProbe.lines.value.count { it.role == "agent" }
            visit("bot-0")
            val pieces = listOf("The cache work", "The cache work is merged", "The cache work is merged and ships Tuesday with three fixes.")
            pieces.forEachIndexed { index, text ->
                until(700) { false }
                write("bot-0", "m1-bot-0", text, final = index == pieces.lastIndex)
            }
            until(1_000) { false }
            val streamed = updates().filter { "m1-bot-0" in it }
            log.append("STREAMED ${streamed.size}\n")
            for (id in listOf("task-0", "task-1", "task-2", "task-3")) { visit(id); until(300) { false } }
            val followed = runBlocking { context.followed() }
            log.append("FOLLOWED $followed\n")
            val beforeOut = updates().size
            write("bot-0", "m2-bot-0", "Written while not followed: the rollout plan is attached.", final = true)
            val whileOut = updates().size - beforeOut
            val beforeBack = updates().size
            visit("bot-0")
            val replayed = updates().drop(beforeBack).filter { "m2-bot-0" in it || "m1-bot-0" in it }
            until(700) { false }
            write("bot-0", "m3-bot-0", "Back again: release notes are drafted.", final = true)
            until(1_000) { false }
            val again = updates().filter { "m3-bot-0" in it }
            // Contextual updates never start a turn: the agent stayed quiet through all of it.
            until(4_000) { false }
            val spokeUnasked = CallProbe.lines.value.count { it.role == "agent" } - spokenBefore
            log.append("WHILE_OUT $whileOut REPLAYED ${replayed.size} AGAIN ${again.size} SPOKE_UNASKED $spokeUnasked\n")
            val question = "In one sentence: what did Research Assistant say most recently, and when does the cache ship?"
            val before = CallProbe.lines.value.count { it.role == "agent" }
            rule.runOnUiThread { connection?.type(question) }
            CallProbe.line("user", question)
            until(30_000) { CallProbe.lines.value.count { it.role == "agent" } > before }
            until(4_000) { false }
            device.takeScreenshot(File(dir, "incoming.png"))
            assertTrue("deltas then one final: $streamed", streamed.size == pieces.size && streamed.count { "\"final\":true" in it } == 1)
            assertTrue("bot-0 dropped out after four more visits: $followed", followed == listOf("task-3", "task-2", "task-1", "task-0"))
            assertTrue("nothing sent while it was out", whileOut == 0)
            assertTrue("no replay on the way back: $replayed", replayed.none { "assistant_text" in it })
            assertTrue("new words after the way back: $again", again.size == 1 && "\"final\":true" in again.single())
        } finally {
            rule.runOnUiThread { session.stop() }
            until(2_000) { false }
            CallProbe.lines.value.forEach { log.append("${it.role}: ${it.text}\n") }
            CallProbe.tools.value.forEach { log.append("TOOL ${it.name} ${it.parameters} -> ${it.result}\n") }
            CallProbe.sent.value.forEach { log.append("CONTEXT ${it.kind} ${it.bytes} bytes${if (it.kind == "update") ": ${it.text}" else ""}\n") }
            File(dir, "incoming.txt").writeText(log.toString())
            android.util.Log.i("HappyCall", "incoming check done\n$log")
        }
    }
}
