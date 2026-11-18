package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.slopus.happy.call.CallAgent
import com.slopus.happy.call.CallContext
import com.slopus.happy.call.CallCues
import com.slopus.happy.call.CallDropSound
import com.slopus.happy.call.CallEnding
import com.slopus.happy.call.CallHistory
import com.slopus.happy.call.CallModeChange
import com.slopus.happy.call.CallProbe
import com.slopus.happy.call.CallProblem
import com.slopus.happy.call.CallTurn
import com.slopus.happy.call.CallScreenMove
import com.slopus.happy.call.CallSendOutcome
import com.slopus.happy.call.CallSession
import com.slopus.happy.call.CallState
import com.slopus.happy.call.CallTarget
import com.slopus.happy.call.CallTargetState
import com.slopus.happy.call.CallTargets
import com.slopus.happy.call.CallUpdate
import com.slopus.happy.call.ElevenLabsCallConnection
import com.slopus.happy.call.FileCallHistoryStore
import com.slopus.happy.call.PublicAgentCallGrants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The app's cues on real calls with the build's hosted agent (iOS has none:
 * its simulator has no microphone to call with). Short timings stand in for
 * the hour, the silence and the voice time; the cue mechanism, the agent's
 * answer, the restart and the drop are the real ones. The person's side is
 * typed, as in [CallLiveDeviceCheck]. Writes a `.txt` per check under `call-cues/` in the app's
 * external files. Each run is a few billed conversations; keep them short.
 */
@RunWith(AndroidJUnit4::class)
class CallCueLiveDeviceCheck {
    /** An activity in front: the microphone is the app's only while it is. */
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext
    private val dir = File(app.getExternalFilesDir(null), "call-cues").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val log = StringBuilder()

    private val conversations = listOf(
        CallTarget("bot-0", "Research Assistant", CallTarget.Kind.Bot, status = CallTarget.Status.Idle),
        CallTarget("task-0", "Release notes", CallTarget.Kind.Task, status = CallTarget.Status.Idle),
    )

    private val targets = object : CallTargets {
        override suspend fun directory() = conversations
        override suspend fun state(agentId: String): CallTargetState? = conversations.firstOrNull { it.agentId == agentId }?.let { CallTargetState(it) }
        override suspend fun focused(): String? = null
        override suspend fun open(agentId: String) = true
        override suspend fun send(agentId: String, text: String, id: String, change: CallModeChange?) = CallSendOutcome.Queued
        override suspend fun follow(agentId: String, following: Boolean) {}
        override suspend fun draft(kind: CallTarget.Kind, name: String): CallTarget? = null
        override suspend fun discard(agentId: String) {}
        override suspend fun unlisted(agentId: String): CallTarget? = null
        override suspend fun back(): CallScreenMove = CallScreenMove.Refused("No screens here.")
        override suspend fun home(): CallScreenMove = CallScreenMove.Moved(true)
    }

    private var connection: ElevenLabsCallConnection? = null
    private val contexts = ArrayList<String>()
    private val endings = ArrayList<CallEnding>()

    /** A call as the app makes one: history in a file, the drop sound on an unasked end, restarts through navigate, what reads find later as context. */
    private fun call(history: CallHistory, timing: CallCues.Timing, targets: CallTargets = this.targets): CallSession = runBlocking(Dispatchers.Main) {
        val agentId = CallAgent.hostedAgentId!!
        val context = CallContext(targets)
        val sound = CallDropSound(app)
        val session = CallSession(scope, PublicAgentCallGrants(agentId), permission = { true }, now = SystemClock::elapsedRealtime, history = history, timing = timing) { grant, request, events ->
            contexts += request.context
            ElevenLabsCallConnection.connect(app, scope, grant, request, events).also { connection = it }
        }
        session.onEnded = { ending ->
            endings += ending
            if (ending.isUnexpected) sound.play()
        }
        context.onRestart { withContext(Dispatchers.Main) { session.requestRestart() } }
        context.onReading { line -> scope.launch { session.deliver(CallUpdate(listOf(line))) } }
        session.start(null, { context.initial(history.slots) }, { call -> context.handle(call) })
        session
    }

    private fun until(millis: Long, condition: () -> Boolean): Boolean {
        val end = SystemClock.elapsedRealtime() + millis
        while (SystemClock.elapsedRealtime() < end) {
            if (runBlocking(Dispatchers.Main) { condition() }) return true
            Thread.sleep(200)
        }
        return runBlocking(Dispatchers.Main) { condition() }
    }

    private fun agentLines() = CallProbe.lines.value.count { it.role == "agent" }

    private fun type(text: String) {
        val before = agentLines()
        runBlocking(Dispatchers.Main) { connection?.type(text) }
        CallProbe.line("user", text)
        until(30_000) { agentLines() > before }
        until(2_500) { false }
    }

    private fun history(name: String) = File(dir, "$name.call-history.json").also { it.delete() }.let { CallHistory(FileCallHistoryStore(it)) }

    private fun write(name: String) {
        CallProbe.lines.value.forEach { log.append("${it.role}: ${it.text}\n") }
        CallProbe.tools.value.forEach { log.append("TOOL ${it.name} ${it.parameters} -> ${it.result}\n") }
        CallProbe.sent.value.filter { it.kind == "cue" }.forEach { log.append("CUE ${it.text}\n") }
        log.append("ENDINGS $endings\n")
        contexts.forEachIndexed { index, text -> log.append("CONTEXT ${index + 1}:\n${text.substringBefore("\n\nOn screen")}\n") }
        File(dir, "$name.txt").writeText(log.toString())
        android.util.Log.i("HappyCall", "$name done\n$log")
    }

    @After
    fun tearDown() {
        instrumentation.uiAutomation.executeShellCommand("cmd connectivity airplane-mode disable").close()
        scope.cancel()
    }

    /**
     * The one-call limit, near: cued, the agent offers a fresh call unasked;
     * told yes, it navigates to happy://call/restart and the next call's
     * first context has what was said.
     */
    @Test
    fun theAgentOffersARestartOnTheCueAndTheRestartCarriesTheCallOver() {
        assumeTrue("no agent ID in this build", CallAgent.hostedAgentId != null)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        CallProbe.reset()
        val history = history("restart")
        // The limit 90 s off from the start: the cue comes 80 s before it, about 10 s in.
        val session = call(history, CallCues.Timing(callLimit = 100_000, callLimitLead = 80_000, silenceWarning = 600_000, silenceEnd = 700_000))
        try {
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { agentLines() > 0 }
            type("Hi, I'm checking on the release notes task today.")
            val beforeCue = agentLines()
            assertTrue("no cue", until(20_000) { CallProbe.sent.value.any { it.kind == "cue" } })
            assertTrue("the agent never spoke on the cue", until(20_000) { agentLines() > beforeCue })
            log.append("SPOKE ON CUE: ${CallProbe.lines.value.last { it.role == "agent" }.text}\n")
            until(3_000) { false }
            type("Yes please, restart it.")
            assertTrue("never restarted: $endings", until(20_000) { CallEnding.Restarted in endings })
            assertTrue("the new call never connected", until(30_000) { session.state.value is CallState.Active && contexts.size == 2 })
            until(8_000) { false }
            assertTrue("the next call's context lacks what was said", "release notes task" in contexts[1] && CallEnding.Restarted.said in contexts[1])
        } finally {
            runBlocking(Dispatchers.Main) { session.stop() }
            until(2_000) { false }
            write("restart")
        }
    }

    /**
     * Quiet: the agent warns, unprompted, that the call will end and can
     * pick up next time; then the app ends it, before ElevenLabs would, with
     * the drop sound and a slot.
     */
    @Test
    fun silenceHasTheAgentWarnThenTheAppEndsTheCall() {
        assumeTrue("no agent ID in this build", CallAgent.hostedAgentId != null)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        CallProbe.reset()
        val history = history("silence")
        val session = call(history, CallCues.Timing(silenceWarning = 20_000, silenceEnd = 40_000))
        try {
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { agentLines() > 0 }
            type("Hello, I'll be quiet for a bit now.")
            val beforeCue = agentLines()
            assertTrue("no cue", until(40_000) { CallProbe.sent.value.any { it.kind == "cue" } })
            assertTrue("the agent never spoke on the cue", until(20_000) { agentLines() > beforeCue })
            log.append("SPOKE ON CUE: ${CallProbe.lines.value.last { it.role == "agent" }.text}\n")
            assertTrue("the app never ended it: ${session.state.value}", until(40_000) { session.state.value == CallState.Idle })
            until(2_000) { false }
            log.append("HISTORY ${history.slots.map { it.kind to (it.ending ?: it.text?.take(40)) }}\n")
            assertTrue("not ended for silence: $endings", endings == listOf(CallEnding.Silence) && history.slots.last().ending == CallEnding.Silence)
        } finally {
            runBlocking(Dispatchers.Main) { session.stop() }
            write("silence")
        }
    }

    /**
     * A real drop (airplane mode): the drop sound, a slot, and the next
     * call's first context saying so.
     */
    @Test
    fun aDropPlaysTheSoundAndTheNextCallKnows() {
        assumeTrue("no agent ID in this build", CallAgent.hostedAgentId != null)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        CallProbe.reset()
        val history = history("drop")
        val first = call(history, CallCues.Timing())
        try {
            assertTrue("never connected: ${first.state.value}", until(30_000) { first.state.value is CallState.Active })
            until(15_000) { agentLines() > 0 }
            type("Hi, remember the word pineapple for me.")
            instrumentation.uiAutomation.executeShellCommand("cmd connectivity airplane-mode enable").close()
            val dropped = until(120_000) { first.state.value == CallState.Ended(CallProblem.Connection) }
            log.append("DROPPED $dropped after airplane mode: ${first.state.value}\n")
            instrumentation.uiAutomation.executeShellCommand("cmd connectivity airplane-mode disable").close()
            until(2_000) { false }
            assertTrue("no drop: ${first.state.value}", dropped && endings.lastOrNull() == CallEnding.Dropped && history.slots.last().ending == CallEnding.Dropped)
        } finally {
            runBlocking(Dispatchers.Main) { first.stop() }
        }
        until(15_000) { false }
        val greeted = agentLines()
        val second = call(CallHistory(FileCallHistoryStore(File(dir, "drop.call-history.json"))), CallCues.Timing())
        try {
            assertTrue("the next call never connected: ${second.state.value}", until(45_000) { second.state.value is CallState.Active })
            until(15_000) { agentLines() > greeted }
            type("What happened on our last call, and which word did I ask you to remember?")
            assertTrue("the next call's context lacks the drop", CallEnding.Dropped.said in contexts.last() && "pineapple" in contexts.last())
        } finally {
            runBlocking(Dispatchers.Main) { second.stop() }
            until(2_000) { false }
            write("drop")
        }
    }

    /**
     * A read of a conversation the phone has but not current, the computer slower than the read waits: the agent
     * answers from what the phone has, the person asks something else meanwhile and is answered, then the refresh finds
     * a newer reply, which goes as a `conversation_update` line of context and never a cue: the agent says nothing of it
     * unasked, and tells it when asked. Then a read the computer never makes current: only a silent
     * `conversation_unconfirmed` line after, no cue.
     */
    @Test
    fun aReadNotCurrentIsAnsweredAndWhatIsNewIsSilentContext() {
        val (session, release, newer) = slowRelease("slow-read")
        fun cues() = CallProbe.sent.value.filter { it.kind == "cue" }
        fun updates() = CallProbe.sent.value.filter { it.kind == "update" && "conversation_update" in it.text }
        try {
            assertTrue("never connected: ${session.state.value}", until(30_000) { session.state.value is CallState.Active })
            until(15_000) { agentLines() > 0 }
            type("What's going on in the release notes task?")
            val first = CallProbe.tools.value.firstOrNull { it.name == "readConversation" }
            log.append("FIRST READ: ${first?.result}\n")
            assertTrue("the read wasn't marked refreshing: $first", first != null && "\"refreshing\":true" in first.result.toString())
            assertTrue("the read didn't have the kept turn: $first", "Ship the 2.1 notes" in first!!.result.toString())
            log.append("ANSWERED: ${CallProbe.lines.value.last { it.role == "agent" }.text}\n")
            // The voice goes on: asked something else meanwhile, it answers.
            type("Also, how many minutes are in an hour?")
            assertTrue("no update line", until(20_000) { updates().isNotEmpty() })
            val update = updates().first().text
            log.append("UPDATE LINE: $update\n")
            assertTrue("the update hasn't the new reply: $update", "pineapple" in update && "\"ref\":\"t:r2\"" in update)
            // Silent: no cue, and the agent says nothing of it unasked.
            val beforeQuiet = agentLines()
            until(8_000) { false }
            assertEquals("the update went as a cue", 0, cues().count { "conversation_update" in it.text })
            assertEquals("the agent spoke unasked", beforeQuiet, agentLines())
            type("Anything new there since?")
            log.append("ASKED: ${CallProbe.lines.value.last { it.role == "agent" }.text}\n")
            assertTrue("never said what was new", CallProbe.lines.value.last { it.role == "agent" }.text.lowercase().contains("pineapple"))
            // Now the computer doesn't answer in time: no cue, a silent line.
            release.never = true
            release.state = release.state.copy(fresh = false)
            type("Read the release notes task again please.")
            assertTrue("no unconfirmed line", until(20_000) { CallProbe.sent.value.any { it.kind == "update" && "conversation_unconfirmed" in it.text } })
            assertEquals("a cue", 0, cues().count { "conversation_" in it.text })
            log.append("TOLD AGAIN: ${CallProbe.lines.value.last { it.role == "agent" }.text}\n")
            log.append("NEWER: ${newer.turns.last().reply}\n")
        } finally {
            runBlocking(Dispatchers.Main) { session.stop() }
            until(2_000) { false }
            write("slow-read")
        }
    }

    /** What the release notes task's refresh does: wait, then come current with [state]; or, [never], not in time. */
    private class Slow(var state: CallTargetState, var never: Boolean = false)

    /**
     * A call where the phone has the release notes task as it was 29 minutes ago (one turn), and the computer, 6 s
     * after it is asked, has a newer reply.
     */
    private fun slowRelease(name: String): Triple<CallSession, Slow, CallTargetState> {
        assumeTrue("no agent ID in this build", CallAgent.hostedAgentId != null)
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.RECORD_AUDIO)
        CallProbe.reset()
        val release = conversations[1]
        val shipped = CallTurn("r1", "Ship the 2.1 notes", "Done: the 2.1 changelog is published.")
        val kept = CallTargetState(release, turns = listOf(shipped), fresh = false, checkedAt = System.currentTimeMillis() - 29 * 60_000)
        val newer = kept.copy(turns = listOf(shipped, CallTurn("r2", "Add the pineapple fix", "Added: the pineapple fix is now listed first in the 2.1 notes.")), fresh = true)
        val slow = Slow(kept)
        val targets = object : CallTargets by targets {
            override suspend fun state(agentId: String): CallTargetState? = if (agentId == release.agentId) slow.state else targets.state(agentId)
            override suspend fun refreshed(agentId: String, limitMillis: Long): CallTargetState? {
                if (agentId != release.agentId) return targets.state(agentId)
                if (slow.never) { delay(limitMillis); return slow.state.copy(fresh = false) }
                delay(6_000)
                slow.state = newer.copy(fresh = false)
                return newer
            }
        }
        return Triple(call(history(name), CallCues.Timing(silenceWarning = 600_000, silenceEnd = 700_000), targets), slow, newer)
    }
}
