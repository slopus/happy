package com.slopus.happy.call

import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.Question
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** One call's life with the provider faked (iOS `CallSessionTests`). Nothing here opens a microphone. */
@OptIn(ExperimentalCoroutinesApi::class)
class CallSessionTest {
    private val test = TestScope(StandardTestDispatcher())
    private val granted = FakeGrants(CallGrantResult.Granted(CallGrant("g", "t", "u")))

    private fun session(grants: CallGrants = granted, permission: suspend () -> Boolean = { true }, connect: suspend (CallGrant, CallStart, CallEvents) -> CallConnection) =
        CallSession(test, grants, permission, now = { 42 }, connect = connect)

    private fun counted(allowance: CallAllowance, connect: suspend (CallGrant, CallStart, CallEvents) -> CallConnection) =
        CallSession(test, granted, { true }, now = { 42 }, allowance = allowance, wallClock = { 1_000_000 + test.testScheduler.currentTime }, connect = connect)

    @Test
    fun aPublicAgentIsCalledByItsIdAlone() {
        var started: CallGrant? = null
        val call = CallSession(test, PublicAgentCallGrants("agent_public"), { true }, now = { 42 }) { grant, _, _ -> started = grant; FakeCallConnection() }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        assertEquals(CallGrant("agent_public"), started)
        assertEquals(null, started?.conversationToken)
        call.stop()
    }

    @Test
    fun onlyAnAgentIdFromTheBuildIsTaken() {
        assertEquals("agent_01abc", CallAgent.id(" agent_01abc \n"))
        assertEquals(null, CallAgent.id(""))
        assertEquals(null, CallAgent.id("agent_"))
        assertEquals(null, CallAgent.id("sk_live"))
        assertEquals(null, CallAgent.id(null))
        // Tests build without one.
        assertEquals(null, CallAgent.hostedAgentId)
    }

    @Test
    fun noFreeTimeLeftEndsAtTheTapWithoutTheMicrophone() {
        val allowance = CallAllowance(MemoryUsageStore(), free = 60_000, window = 10_000_000)
        allowance.record("old", 900_000, 960_000)
        var asked = false
        val call = CallSession(test, granted, { asked = true; true }, now = { 42 }, allowance = allowance, wallClock = { 1_000_000 }) { _, _, _ -> error("never connects") }
        call.start(null, { "" }, { CallToolResult("") })
        assertEquals(CallState.Ended(CallProblem.LimitReached), call.state.value)
        test.runCurrent()
        assertFalse(asked)
    }

    @Test
    fun aLiveCallIsCountedEveryTenSecondsAndEndsWhenTheFreeTimeIsGone() {
        val store = MemoryUsageStore()
        val allowance = CallAllowance(store, free = 25_000, window = 10_000_000)
        val connection = FakeCallConnection()
        val call = counted(allowance) { _, _, _ -> connection }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        test.testScheduler.advanceTimeBy(10_001)
        test.runCurrent()
        // Written down while it runs: a killed app still counts this much.
        assertEquals(10_000L, store.usage.used(1_010_001, 10_000_000))
        test.testScheduler.advanceTimeBy(15_000)
        test.runCurrent()
        assertEquals(CallState.Ended(CallProblem.LimitReached), call.state.value)
        assertTrue(connection.ended)
        assertEquals(25_000L, store.usage.used(1_030_000, 10_000_000))
        assertEquals(1, store.usage.spans.size)
    }

    @Test
    fun aStoppedCallCountsUpToItsEndOnce() {
        val store = MemoryUsageStore()
        val allowance = CallAllowance(store, free = 1_200_000, window = 10_000_000)
        val call = counted(allowance) { _, _, _ -> FakeCallConnection() }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        test.testScheduler.advanceTimeBy(45_000)
        call.stop()
        test.testScheduler.advanceTimeBy(60_000)
        test.runCurrent()
        assertEquals(1_155_000L, allowance.remaining(1_200_000))
        assertEquals(1_155_000L, CallAllowance(store, free = 1_200_000, window = 10_000_000).remaining(1_200_000))
    }

    @Test
    fun aConnectionWithoutAGrantEndsAtOnceWithoutTheMicrophone() {
        var asked = false
        val call = session(UnconfiguredCallGrants, permission = { asked = true; true }) { _, _, _ -> error("never connects") }
        call.start(null, { "" }, { CallToolResult("") })
        assertEquals(CallState.Ended(CallProblem.NotSetUp), call.state.value)
        test.runCurrent()
        assertFalse(asked)
        call.stop()
        assertEquals(CallState.Idle, call.state.value)
    }

    @Test
    fun noMicrophoneEndsTheCall() {
        val call = session(permission = { false }) { _, _, _ -> FakeCallConnection() }
        call.start(null, { "" }, { CallToolResult("") })
        assertEquals(CallState.Connecting, call.state.value)
        test.runCurrent()
        assertEquals(CallState.Ended(CallProblem.MicrophonePermission), call.state.value)
    }

    @Test
    fun aRefusedGrantSaysWhy() {
        val call = session(FakeGrants(CallGrantResult.Refused(CallProblem.SubscriptionRequired))) { _, _, _ -> FakeCallConnection() }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        assertEquals(CallState.Ended(CallProblem.SubscriptionRequired), call.state.value)
    }

    @Test
    fun aLiveCallGetsItsContextOnceItConnectsAndNeverAPrompt() {
        val connection = FakeCallConnection()
        var started: CallStart? = null
        var events: CallEvents? = null
        val call = session { _, start, callEvents -> started = start; events = callEvents; connection }
        call.start("pl", { """{"schema":1}""" }, { CallToolResult("") })
        // Before it connects, nothing is sent and nothing is lost.
        call.deliver(CallUpdate(context = listOf("early")))
        test.runCurrent()
        assertEquals(CallState.Active(CallActivity.Listening, false, 42), call.state.value)
        assertEquals(CallStart("""{"schema":1}""", "pl"), started)
        assertEquals(listOf("early"), connection.updates)
        events!!.activity(CallActivity.AgentSpeaking, 0f, null)
        call.deliver(CallUpdate(listOf("c1")))
        events!!.activity(CallActivity.Listening, 0f, null)
        assertEquals(listOf("early", "c1"), connection.updates)
        call.toggleMute()
        test.runCurrent()
        assertEquals(CallState.Active(CallActivity.Listening, true, 42), call.state.value)
        assertTrue(connection.muted)
        events!!.disconnected()
        assertEquals(CallState.Ended(CallProblem.Connection), call.state.value)
        test.runCurrent()
        assertTrue(connection.ended)
    }

    @Test
    fun whatAnEndedCallStillSaysGoesNowhere() {
        val connection = FakeCallConnection()
        var events: CallEvents? = null
        val levels = ArrayList<Float>()
        val call = session { _, _, callEvents -> events = callEvents; connection }
        call.onLevel = { levels += it }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        call.stop()
        test.runCurrent()
        assertTrue(connection.ended)
        val heard = levels.size
        events!!.activity(CallActivity.AgentSpeaking, 1f, 1f)
        events!!.disconnected()
        call.deliver(CallUpdate(listOf("late")))
        assertEquals(CallState.Idle, call.state.value)
        assertEquals(heard, levels.size)
        assertTrue(connection.updates.isEmpty())
    }

    @Test
    fun contextTooMuchForTheWaitIsLetGoWholeAndAskedFor() {
        val connection = FakeCallConnection()
        val gate = CompletableDeferred<Unit>()
        val call = session { _, _, _ -> gate.await(); connection }
        var overflows = 0
        call.onOverflow = { overflows += 1 }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        val line = "x".repeat(1023)
        repeat(40) { call.deliver(CallUpdate(listOf(line))) }
        assertEquals(1, overflows)
        call.deliver(CallUpdate(listOf("resync")))
        gate.complete(Unit)
        test.runCurrent()
        // What was over the limit went whole; what came after it waits on.
        val lines = connection.updates.single().split("\n")
        assertEquals(8, lines.size)
        assertEquals("resync", lines.last())
        call.stop()
    }

    @Test
    fun aCallHungUpWhileConnectingNeverGoesLive() {
        val connection = FakeCallConnection()
        val gate = CompletableDeferred<Unit>()
        val call = session { _, _, _ -> gate.await(); connection }
        call.start(null, { "" }, { CallToolResult("") })
        test.runCurrent()
        call.stop()
        gate.complete(Unit)
        test.runCurrent()
        assertEquals(CallState.Idle, call.state.value)
        assertTrue(connection.updates.isEmpty())
        call.toggleMute()
        test.runCurrent()
        assertFalse(connection.muted)
    }

    @Test
    fun aConversationReadsAsPublicWordsWithAQuestionAsAFlagOnly() {
        val question = Question("q", "pending", "the secret plan", listOf(Question.Prompt("p", null, "Deploy to prod?", false, emptyList(), null)), null, isPermission = false)
        val state = ConversationState(
            created = true,
            loaded = true,
            working = true,
            draft = "half typed",
            question = question,
            rows = listOf(
                ConversationRow.User("u:user", "u", "hello", emptyList(), emptyList(), Delivery.Sending),
                ConversationRow.Reasoning("x:0", "thinking out loud", streaming = false),
                ConversationRow.Text("a:0", "first", emptyList()),
                ConversationRow.Text("a:1", "second", emptyList()),
                ConversationRow.Ask("ask", question, AskPhase.Pending),
            ),
        )
        val read = CallTargetState.from(state, CallTarget("a", "A", CallTarget.Kind.Bot, status = CallTarget.Status.Idle))
        // Each of the agent's text blocks is its own message: its words between steps.
        assertEquals(listOf("hello", "first", "second"), read.messages.map { it.text })
        assertEquals(listOf("u", "a:0", "a:1"), read.messages.map { it.id })
        assertEquals(CallMessage.Delivery.Queued, read.messages[0].delivery)
        assertEquals(listOf(true, true, false), read.messages.map { it.final })
        assertTrue(read.needsInput)
        assertTrue(read.hasDraft)
        assertEquals(CallTarget.Status.NeedsInput, read.target.status)
        val words = read.toString()
        assertFalse(words.contains("Deploy"))
        assertFalse(words.contains("secret plan"))
        assertFalse(words.contains("half typed"))
        assertFalse(words.contains("thinking out loud"))
    }
}

class FakeGrants(private val result: CallGrantResult) : CallGrants {
    override val isConfigured = true
    override suspend fun grant() = result
}

class FakeCallConnection : CallConnection {
    val updates = ArrayList<String>()
    var muted = false
    var ended = false
    override suspend fun end() { ended = true }
    override suspend fun setMuted(muted: Boolean) { this.muted = muted }
    override fun update(context: String) { updates += context }
}

class MemoryUsageStore : CallUsageStore {
    var usage = CallUsage()
    override fun load() = usage
    override fun save(usage: CallUsage) { this.usage = usage }
}
