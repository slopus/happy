package com.slopus.happy.call

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class MemoryHistoryStore : CallHistoryStore {
    var stored: String? = null
    var writes = 0
    override fun read() = stored
    override fun write(text: String) { stored = text; writes += 1 }
}

/** What calls said, kept for the next (iOS `CallHistoryTests`). */
@OptIn(ExperimentalCoroutinesApi::class)
class CallHistoryTest {
    /** Thirty slots, the interruptions among them; the oldest go first. */
    @Test
    fun thirtySlotsRollWithTheInterruptionsCounted() {
        val history = CallHistory(null)
        repeat(20) { history.heard("ask $it", it.toLong()) }
        repeat(10) { history.ended(CallEnding.Dropped, 20L + it) }
        history.said("answer", 1, 30)
        assertEquals(CallHistory.SLOTS, history.slots.size)
        assertEquals(CallSlot.person("ask 1", 1), history.slots.first())
        assertEquals(10, history.slots.count { it.kind == CallSlot.Kind.Ended })
        assertEquals(CallSlot.assistant("answer", 30), history.slots.last())
    }

    /** Written after every slot, a correction too: the next launch reads it whole, from its file too. */
    @Test
    fun itIsKeptAcrossLaunchesAfterEverySlot() {
        val store = MemoryHistoryStore()
        val history = CallHistory(store)
        history.began()
        history.heard("  what's new?  ", 1)
        history.said("Three things finished, and the release task needs you.", 7, 2)
        assertEquals(2, store.writes)
        history.corrected("Three things finished", 7)
        history.ended(CallEnding.CallLimit, 3)
        assertEquals(4, store.writes)
        val next = CallHistory(store)
        assertEquals(listOf(CallSlot.person("what's new?", 1), CallSlot.assistant("Three things finished", 2), CallSlot.ended(CallEnding.CallLimit, 3)), next.slots)
        next.began()
        next.corrected("x", 7)
        assertEquals("Three things finished", next.slots[1].text)
        assertEquals(4, store.writes)
        val file = Files.createTempDirectory("history").resolve("c1.call-history.json").toFile()
        CallHistory(FileCallHistoryStore(file)).apply { heard("on disk", 5); ended(CallEnding.Silence, 6) }
        assertEquals(listOf(CallSlot.person("on disk", 5), CallSlot.ended(CallEnding.Silence, 6)), CallHistory(FileCallHistoryStore(file)).slots)
    }

    @Test
    fun onlyTheUnaskedEndsSound() {
        assertEquals(listOf(CallEnding.Dropped, CallEnding.CallLimit, CallEnding.TimeUsed, CallEnding.Silence), CallEnding.entries.filter { it.isUnexpected })
    }

    // A call's history

    private val test = TestScope(StandardTestDispatcher())
    private val granted = FakeGrants(CallGrantResult.Granted(CallGrant("g")))

    private fun session(history: CallHistory, timing: CallCues.Timing = CallCues.Timing(), connection: FakeCallConnection = FakeCallConnection(),
                        allowance: CallAllowance? = null, events: (CallEvents) -> Unit = {}) =
        CallSession(test, granted, { true }, now = { test.testScheduler.currentTime }, allowance = allowance,
            wallClock = { 1_700_000_000_000 + test.testScheduler.currentTime }, history = history, timing = timing) { _, _, callEvents ->
            events(callEvents)
            connection
        }

    /** The person's words and the agent's as spoken, never its greeting, context, tools or a cue; the end it came to. */
    @Test
    fun aCallKeepsWhatWasSaidAloudAndHowItEnded() {
        val history = CallHistory(null)
        val connection = FakeCallConnection()
        var events: CallEvents? = null
        val call = session(history, connection = connection) { events = it }
        call.start(null, { "context" }, { CallToolResult("{}") })
        test.runCurrent()
        val said = events!!
        said.said("Hi, Happy here", 1)
        call.deliver(CallUpdate(listOf("""{"event":"assistant_text","text":"build passed"}""")))
        runBlocking { said.tool(CallToolCall("t", "readConversation", JsonObject(emptyMap()))) }
        said.heard("Read me the release task.")
        said.said("It shipped at noon and the notes are drafted.", 2)
        said.corrected("It shipped at noon", 2)
        connection.cue(CallCue.Silence(25_000).text)
        call.stop()
        assertEquals(listOf(CallSlot.Kind.Person, CallSlot.Kind.Assistant, CallSlot.Kind.Ended), history.slots.map { it.kind })
        assertEquals(listOf("Read me the release task.", "It shipped at noon", null), history.slots.map { it.text })
        assertEquals(CallEnding.HungUp, history.slots.last().ending)
    }

    /** A drop is kept, plays as unasked; a call that said nothing and was hung up leaves no line. */
    @Test
    fun aDropIsKeptAndAPlainEmptyCallIsNot() {
        val history = CallHistory(null)
        var events: CallEvents? = null
        val ended = ArrayList<CallEnding>()
        val call = session(history) { events = it }
        call.onEnded = { ended += it }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        call.stop()
        test.runCurrent()
        assertEquals(listOf(CallEnding.HungUp), ended)
        assertTrue(history.slots.isEmpty())
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        events!!.disconnected()
        test.runCurrent()
        assertEquals(CallState.Ended(CallProblem.Connection), call.state.value)
        assertEquals(listOf(CallEnding.Dropped), history.slots.map { it.ending })
        assertEquals(listOf(CallEnding.HungUp, CallEnding.Dropped), ended)
        assertTrue(ended.last().isUnexpected)
    }

    /** Quiet: the agent is cued to say so, then the call ends itself, kept as ended for silence. */
    @Test
    fun silenceCuesTheAgentThenEndsTheCall() {
        val history = CallHistory(null)
        val connection = FakeCallConnection()
        var ended: CallEnding? = null
        val call = session(history, connection = connection)
        call.onEnded = { ended = it }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        test.testScheduler.advanceTimeBy(74_500)
        test.runCurrent()
        assertTrue(connection.cues.isEmpty())
        test.testScheduler.advanceTimeBy(1_000)
        test.runCurrent()
        assertEquals(listOf("""{"event":"silence","endsIn":"25 seconds"}"""), connection.cues)
        test.testScheduler.advanceTimeBy(25_000)
        test.runCurrent()
        assertEquals(CallState.Idle, call.state.value)
        assertEquals(CallEnding.Silence, ended)
        assertEquals(listOf(CallEnding.Silence), history.slots.map { it.ending })
    }

    /** The agent agreed to restart: once it has said so, the call ends and a new one starts with what was said in its context. */
    @Test
    fun aRestartCarriesTheCallOver() {
        val history = CallHistory(null)
        var events: CallEvents? = null
        val contexts = ArrayList<String>()
        val ended = ArrayList<CallEnding>()
        val call = session(history) { events = it }
        call.onEnded = { ended += it }
        call.start(null, { CallContext.recap(history.slots, 1_700_000_000_000 + test.testScheduler.currentTime, 4096).orEmpty().also { contexts += it } }, { CallToolResult("") })
        test.runCurrent()
        events!!.said("Hi, Happy here", 1)
        events!!.heard("Yes, restart it.")
        val result = call.requestRestart()
        assertFalse(result.text, result.isError)
        events!!.activity(CallActivity.AgentSpeaking, 0f, null)
        events!!.said("Restarting now.", 2)
        events!!.activity(CallActivity.Listening, 0f, null)
        test.testScheduler.advanceTimeBy(1_100)
        test.runCurrent()
        assertEquals(listOf(CallEnding.Restarted), ended)
        assertTrue(call.state.value is CallState.Active)
        assertEquals(2, contexts.size)
        assertTrue(contexts[1], contexts[1].contains("the person: Yes, restart it."))
        assertTrue(contexts[1], contexts[1].contains("the call restarted, carried over"))
        call.stop()
    }

    /** No restart with under a minute of voice time left. */
    @Test
    fun aRestartNeedsTimeLeft() {
        val allowance = CallAllowance(MemoryUsageStore(), free = 1_000_000, window = 10_000_000_000)
        allowance.record("used", 1_700_000_000_000 - 960_000, 1_700_000_000_000)
        val call = session(CallHistory(null), allowance = allowance)
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        val result = call.requestRestart()
        assertTrue(result.isError)
        assertTrue(result.text, "isn't enough voice time" in result.text)
        call.stop()
    }
}

class CallCuesTest {
    @Test
    fun theCuesAreFactsAsJson() {
        assertEquals("""{"event":"silence","endsIn":"25 seconds"}""", CallCue.Silence(25_000).text)
        assertEquals("""{"event":"call_ending","reason":"call_limit","in":"about 5 minutes","restart":true}""", CallCue.Ending(CallCue.Reason.CallLimit, 300_000, true).text)
        assertEquals("""{"event":"call_ending","reason":"time_used","in":"about a minute","restart":false}""", CallCue.Ending(CallCue.Reason.TimeUsed, 70_000, false).text)
        assertEquals("less than a minute", CallCue.spoken(20_000))
        assertEquals("[app] ", CallCue.MARK)
    }

    /** Warned at 75 s of quiet, ended at 100 s: always before the provider's own 120 s. */
    @Test
    fun silenceWarnsThenEndsBeforeTheProviderWould() {
        val cues = CallCues(since = 0)
        assertNull(cues.next(CallCues.Moment(74_000)))
        assertNull(cues.next(CallCues.Moment(75_000, personSpeaking = true)))
        assertEquals(CallCues.Action.Cue(CallCue.Silence(25_000)), cues.next(CallCues.Moment(76_000)))
        cues.agentSpoke(80_000)
        assertNull(cues.next(CallCues.Moment(100_000)))
        assertEquals(CallCues.Action.End(CallEnding.Silence), cues.next(CallCues.Moment(101_000)))
        assertTrue(cues.timing.silenceEnd < 120_000)
        val again = CallCues(since = 0)
        again.next(CallCues.Moment(75_000))
        again.heard(90_000)
        assertNull(again.next(CallCues.Moment(120_000)))
        assertEquals(CallCues.Action.Cue(CallCue.Silence(25_000)), again.next(CallCues.Moment(165_000)))
    }

    /** Five minutes before the one-call limit the agent offers a fresh call; it ends ours 10 s before the provider's. */
    @Test
    fun theCallLimitIsOfferedFiveMinutesAhead() {
        val cues = CallCues(since = 0)
        cues.heard(3_280_000)
        assertNull(cues.next(CallCues.Moment(3_289_000)))
        assertEquals(CallCues.Action.Cue(CallCue.Ending(CallCue.Reason.CallLimit, 300_000, true)), cues.next(CallCues.Moment(3_290_000)))
        cues.heard(3_580_000)
        assertNull(cues.next(CallCues.Moment(3_589_000)))
        assertEquals(CallCues.Action.End(CallEnding.CallLimit), cues.next(CallCues.Moment(3_590_000)))
    }

    /** The voice time: two minutes ahead of the free 20, five of the paid hours, never a restart; past the limit only if time outlasts it. */
    @Test
    fun theVoiceTimeIsSaidAheadAndOffersNoRestart() {
        val free = CallCues(since = 0)
        assertNull(free.next(CallCues.Moment(10_000, allowanceLeft = 121_000, allowanceTotal = 1_200_000)))
        assertEquals(CallCues.Action.Cue(CallCue.Ending(CallCue.Reason.TimeUsed, 120_000, false)), free.next(CallCues.Moment(11_000, allowanceLeft = 120_000, allowanceTotal = 1_200_000)))
        assertNull(free.next(CallCues.Moment(12_000, allowanceLeft = 100_000, allowanceTotal = 1_200_000)))
        val paid = CallCues(since = 0)
        assertNull(paid.next(CallCues.Moment(10_000, allowanceLeft = 301_000, allowanceTotal = 18_000_000)))
        assertEquals(CallCues.Action.Cue(CallCue.Ending(CallCue.Reason.TimeUsed, 300_000, false)), paid.next(CallCues.Moment(11_000, allowanceLeft = 300_000, allowanceTotal = 18_000_000)))
        val short = CallCues(since = 0)
        short.heard(3_290_000)
        assertEquals(CallCues.Action.Cue(CallCue.Ending(CallCue.Reason.CallLimit, 300_000, false)), short.next(CallCues.Moment(3_290_000, allowanceLeft = 360_000, allowanceTotal = 18_000_000)))
        assertFalse(short.canRestart(59_000))
        assertTrue(short.canRestart(null))
    }

    /** Asked to restart: once the agent's words on it are said, or it says none. */
    @Test
    fun aRestartWaitsForTheAgentsWords() {
        val cues = CallCues(since = 0)
        cues.restartAsked(10_000)
        assertNull(cues.next(CallCues.Moment(11_000)))
        assertNull(cues.next(CallCues.Moment(12_000, agentSpeaking = true)))
        cues.agentSpoke(13_000)
        assertEquals(CallCues.Action.Restart, cues.next(CallCues.Moment(13_000)))
        val silent = CallCues(since = 0)
        silent.restartAsked(10_000)
        assertNull(silent.next(CallCues.Moment(13_000)))
        assertEquals(CallCues.Action.Restart, silent.next(CallCues.Moment(14_000)))
        val endless = CallCues(since = 0)
        endless.restartAsked(10_000)
        assertEquals(CallCues.Action.Restart, endless.next(CallCues.Moment(22_000, agentSpeaking = true)))
    }
}

class CallRecapTest {
    private val backend = CallTarget("a", "Backend", CallTarget.Kind.Bot, CallTarget.Status.Idle)

    /** The first context says what earlier calls said, oldest first, how long ago, the interruptions inline, after the time. */
    @Test
    fun theFirstContextRecapsEarlierCalls() = runBlocking {
        val now = 1_700_000_000_000L
        val slots = listOf(
            CallSlot.person("Check the release task.", now - 840_000), CallSlot.assistant("It finished; all checks passed.\nNothing failed.", now - 830_000),
            CallSlot.ended(CallEnding.Dropped, now - 720_000), CallSlot.person("Hello?", now - 30_000),
        )
        val targets = FakeCallTargets(listOf(backend), mutableMapOf(), null)
        val text = CallContext(targets, now = { now }, zone = java.time.ZoneOffset.UTC).initial(slots)
        assertEquals(
            """
            Previous voice conversation (earlier calls, oldest first):
            - 14 minutes ago, the person: Check the release task.
            - 13 minutes ago, you: It finished; all checks passed.
               Nothing failed.
            - 12 minutes ago: the call dropped (connection lost)
            - just now, the person: Hello?
            """.trimIndent(),
            text.split("\n\n")[1],
        )
        assertFalse(CallContext(targets, now = { now }).initial().contains("Previous voice conversation"))
    }

    /** Its own 8 KB, each line's words within 1 KB, the newest kept; under the 32 KB the older turns and the directory give way before it. */
    @Test
    fun theRecapKeepsItsBudgetAndTheNewestLines() = runBlocking {
        val now = 1_700_000_000_000L
        val long = "word ".repeat(400)
        val slots = (0 until 30).map { CallSlot.assistant("$it $long", now - (30 - it) * 1_000L) }
        val recap = CallContext.recap(slots, now, CallContext.Limits.RECAP_BYTES)!!
        assertTrue(recap.utf8Size() <= CallContext.Limits.RECAP_BYTES)
        assertTrue(recap.contains("Older lines aren't shown."))
        assertTrue(recap.contains("you: 29 word"))
        assertFalse(recap.contains("you: 0 word"))
        assertTrue(recap.contains(" more words)"))
        val reply = "é".repeat(4000)
        val turns = (0 until 5).map { CallTurn("r$it", "ask $it", "$it $reply") }
        val many = (0 until 300).map { CallTarget("x$it", "n".repeat(200), CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val targets = FakeCallTargets(listOf(backend) + many, mutableMapOf("a" to CallTargetState(backend, turns = turns)), "a")
        val text = CallContext(targets, now = { now }).initial(slots)
        assertTrue(text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        assertTrue("the newest turn stays", text.contains("Agent: 4 é"))
        assertFalse("older turns went first", text.contains("Agent: 0 é"))
        assertTrue("the newest of the recap stays", text.contains("you: 29 word"))
    }

    /** navigate to happy://call/restart is the call's, at any focusRevision. */
    @Test
    fun navigateRestartsTheCallWhenTheCallLetsIt() = runBlocking {
        val context = CallContext(FakeCallTargets(listOf(backend), mutableMapOf(), null))
        context.initial()
        fun navigate(id: String, json: String) = runBlocking {
            context.handle(CallToolCall(id, "navigate", kotlinx.serialization.json.Json.parseToJsonElement(json) as JsonObject))
        }
        assertTrue(navigate("1", """{"to":"happy://call/restart","focusRevision":0}""").isError)
        var asked = 0
        context.onRestart { asked += 1; CallToolResult("""{"ok":true,"restarting":true}""") }
        assertEquals("""{"ok":true,"restarting":true}""", navigate("2", """{"to":"HAPPY://call/restart/","focusRevision":9}""").text)
        assertEquals(1, asked)
    }
}
