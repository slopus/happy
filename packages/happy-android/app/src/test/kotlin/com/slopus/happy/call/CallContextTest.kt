package com.slopus.happy.call

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The agent connection's voice call: its context and its five tools, with the conversations faked (iOS `CallContextTests`). */
class CallContextTest {
    private fun backend(focus: String? = "a", messages: Int = 3): FakeCallTargets {
        val a = CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.Idle)
        val b = CallTarget("b", "Docs", CallTarget.Kind.Task, status = CallTarget.Status.Running)
        val history = (0 until messages).map { index ->
            CallMessage("m$index", if (index % 2 == 0) CallMessage.Role.User else CallMessage.Role.Assistant, "line $index",
                time = 1_700_000_000_000, delivery = if (index % 2 == 0) CallMessage.Delivery.Accepted else null)
        }
        return FakeCallTargets(listOf(a, b), mutableMapOf("a" to CallTargetState(a, history, hasDraft = true), "b" to CallTargetState(b, working = true)), focus)
    }

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun call(id: String, name: String, json: String) = CallToolCall(id, name, obj(json))

    @Test
    fun theFirstSnapshotHoldsTheFocusAndTheDirectoryButNoDraft() = runBlocking {
        val context = CallContext(backend(), now = { 1_700_000_000_000 })
        val snapshot = obj(context.initial())
        assertEquals(1, snapshot["schema"]!!.jsonPrimitive.int)
        assertEquals(0, snapshot["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("listSessions", "getSessionContext", "openSession", "setSessionWatch", "sendMessage"), snapshot["tools"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("2023-11-14T22:13:20Z", snapshot["at"]!!.jsonPrimitive.content)
        val focus = snapshot["focus"]!!.jsonObject
        assertEquals("s1", focus["targetRef"]!!.jsonPrimitive.content)
        assertEquals("Backend", focus["title"]!!.jsonPrimitive.content)
        assertTrue(focus["hasDraft"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("line 0", "line 1", "line 2"), focus["messages"]!!.jsonArray.map { it.jsonObject["text"]!!.jsonPrimitive.content })
        val directory = snapshot["directory"]!!.jsonArray
        assertEquals(listOf("s1", "s2"), directory.map { it.jsonObject["targetRef"]!!.jsonPrimitive.content })
        assertEquals("running", directory[1].jsonObject["status"]!!.jsonPrimitive.content)
        assertFalse(snapshot["historyTruncated"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun theSnapshotKeepsItsBudgets() = runBlocking {
        val long = "é".repeat(5000)
        val a = CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.Idle)
        val messages = (0 until 40).map { CallMessage("m$it", CallMessage.Role.Assistant, long) }
        val many = (0 until 300).map { CallTarget("x$it", "n".repeat(200), CallTarget.Kind.Conversation, status = CallTarget.Status.Idle) }
        val text = CallContext(FakeCallTargets(listOf(a) + many, mutableMapOf("a" to CallTargetState(a, messages)), "a")).initial()
        assertTrue(text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        val snapshot = obj(text)
        assertTrue(snapshot["historyTruncated"]!!.jsonPrimitive.boolean)
        assertTrue(snapshot["directoryTruncated"]!!.jsonPrimitive.boolean)
        val shown = snapshot["focus"]!!.jsonObject["messages"]!!.jsonArray
        assertTrue(shown.size <= CallContext.Limits.MESSAGES)
        for (message in shown) {
            assertTrue(message.jsonObject["text"]!!.jsonPrimitive.content.utf8Size() <= CallContext.Limits.MESSAGE_BYTES)
            assertTrue(message.jsonObject["truncated"]!!.jsonPrimitive.boolean)
        }
        assertEquals("m39", shown.last().jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun truncationKeepsWholeCharacters() {
        assertEquals("aé", CallContext.truncated("aé😀", 4))
        assertEquals("aé😀", CallContext.truncated("aé😀", 7))
    }

    @Test
    fun sendMessageQueuesTheExactTextOnceAndFollowsTheTarget() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val send = call("t1", "sendMessage", """{"targetRef":"s2","text":"  run the checks ","focusRevision":0}""")
        val first = context.handle(send)
        assertFalse(first.isError)
        assertEquals("queued", obj(first.text)["status"]!!.jsonPrimitive.content)
        // The provider asking again under the same ID gets the same answer.
        assertEquals(first, context.handle(send))
        assertEquals(listOf("  run the checks "), targets.sends.map { it.text })
        assertEquals(listOf("b"), targets.sends.map { it.agentId })
        assertEquals(listOf("a", "b"), context.followed())
    }

    @Test
    fun sendMessageRefusesWhatItMustNotSend() = runBlocking {
        val targets = backend()
        val a = CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.NeedsInput)
        targets.states["a"] = CallTargetState(a, needsInput = true)
        val context = CallContext(targets)
        context.initial()
        suspend fun send(id: String, json: String) = context.handle(call(id, "sendMessage", json))
        assertTrue(send("1", """{"targetRef":"s1","text":"yes","focusRevision":0}""").isError)
        assertTrue(send("2", """{"targetRef":"s2","text":"go","focusRevision":3}""").isError)
        assertTrue(send("3", """{"targetRef":"s9","text":"go","focusRevision":0}""").isError)
        assertTrue(send("4", """{"targetRef":"s2","text":"  ","focusRevision":0}""").isError)
        assertTrue(context.handle(call("5", "processPermissionRequest", "{}")).isError)
        assertTrue(context.handle(call("6", "answerQuestion", "{}")).isError)
        assertTrue(targets.sends.isEmpty())
    }

    @Test
    fun aSendWithNoAnswerInTimeIsUncertainAndNeverGoesUnderANewId() = runBlocking {
        val targets = backend()
        targets.sendDelay = 30_000
        val context = CallContext(targets, toolDeadlineMillis = 50)
        context.initial()
        suspend fun send(id: String) = context.handle(call(id, "sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0}"""))
        val started = System.nanoTime()
        val first = send("t1")
        assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000)
        assertTrue(first.isError)
        assertEquals("uncertain", obj(first.text)["status"]!!.jsonPrimitive.content)
        // The agent asking again, under a new tool call: the same message ID.
        targets.sendDelay = 0
        assertEquals("queued", obj(send("t2").text)["status"]!!.jsonPrimitive.content)
        // Settled, the same words later are a new message.
        send("t3")
        withTimeout(2_000) { while (targets.sends.size < 3) delay(5) }
        val ids = targets.sends.map { it.id }
        assertEquals(1, ids.take(2).toSet().size)
        assertNotEquals(ids[0], ids[2])
    }

    @Test
    fun movingTheScreenRefusesWhatWasAskedUnderTheOldFocus() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val moved = context.focusChanged("b")
        assertTrue(moved.context[0].contains(""""focusRevision":1"""))
        for (name in listOf("openSession", "sendMessage")) {
            val stale = context.handle(call(name, name, """{"targetRef":"s1","text":"go","focusRevision":0}"""))
            assertTrue(name, stale.isError)
            assertTrue(name, stale.text.contains("screen changed"))
        }
        assertTrue(targets.sends.isEmpty())
        assertTrue(targets.opened.isEmpty())
        assertFalse(context.handle(call("f", "sendMessage", """{"targetRef":"s1","text":"go","focusRevision":1}""")).isError)
    }

    @Test
    fun theFocusMovingWhileTheTargetIsReadStopsTheSend() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        targets.onRead = { context.focusChanged("b") }
        val raced = context.handle(call("r", "sendMessage", """{"targetRef":"s1","text":"go","focusRevision":0}"""))
        assertTrue(raced.text.contains("screen changed"))
        assertTrue(targets.sends.isEmpty())
    }

    @Test
    fun anEndedCallRunsNoTools() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        context.close()
        assertTrue(context.handle(call("late", "sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0}""")).isError)
        val a = CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.Idle)
        assertTrue(context.targetChanged(CallTargetState(a, listOf(CallMessage("n", CallMessage.Role.Assistant, "new")))).isEmpty)
        assertTrue(targets.sends.isEmpty())
    }

    @Test
    fun watchesFollowAndLetGoUnderTheirCap() = runBlocking {
        val many = (0 until 10).map { CallTarget("x$it", "T$it", CallTarget.Kind.Conversation, status = CallTarget.Status.Idle) }
        val targets = FakeCallTargets(many, mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        suspend fun watch(ref: String, on: Boolean) = context.handle(call("$ref$on", "setSessionWatch", """{"targetRef":"$ref","enabled":$on}"""))
        for (index in 1..7) assertFalse(watch("s$index", true).isError)
        assertTrue(watch("s8", true).isError)
        assertFalse(watch("s1", false).isError)
        assertEquals(8, targets.follows.size)
        assertEquals("x0" to false, targets.follows.last())
        assertEquals(6, context.followed().size)
    }

    @Test
    fun aWatchNeedsARealBooleanAndAnythingElseChangesNothing() = runBlocking {
        val targets = FakeCallTargets(listOf(CallTarget("x", "X", CallTarget.Kind.Task, status = CallTarget.Status.Idle)), mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        context.handle(call("on", "setSessionWatch", """{"targetRef":"s1","enabled":true}"""))
        listOf("""{"targetRef":"s1"}""", """{"targetRef":"s1","enabled":null}""", """{"targetRef":"s1","enabled":"false"}""", """{"targetRef":"s1","enabled":0}""")
            .forEachIndexed { index, bad -> assertTrue(bad, context.handle(call("bad$index", "setSessionWatch", bad)).isError) }
        assertEquals(listOf("x"), context.followed())
        assertEquals(1, targets.follows.size)
    }

    @Test
    fun aFocusRevisionIsAnIntegerNotAString() = runBlocking {
        val x = CallTarget("x", "X", CallTarget.Kind.Task, status = CallTarget.Status.Idle)
        val targets = FakeCallTargets(listOf(x), mutableMapOf("x" to CallTargetState(x)), null)
        val context = CallContext(targets)
        context.initial()
        listOf("\"0\"", "true", "0.5", "null").forEachIndexed { index, bad ->
            assertTrue(bad, context.handle(call("o$index", "openSession", """{"targetRef":"s1","focusRevision":$bad}""")).isError)
        }
        assertTrue(targets.opened.isEmpty())
        assertFalse(context.handle(call("ok", "openSession", """{"targetRef":"s1","focusRevision":0}""")).isError)
        assertEquals("integer", CallTool.OpenSession.parameters["properties"]!!.jsonObject["focusRevision"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("boolean", CallTool.SetSessionWatch.parameters["properties"]!!.jsonObject["enabled"]!!.jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun listSessionsPagesAndFilters() = runBlocking {
        val many = (0 until 120).map { CallTarget("x$it", if (it % 2 == 0) "Even $it" else "Odd $it", CallTarget.Kind.Conversation, status = CallTarget.Status.Idle) }
        val context = CallContext(FakeCallTargets(many, mutableMapOf(), null))
        context.initial()
        val first = obj(context.handle(call("1", "listSessions", "{}")).text)
        assertEquals(50, first["sessions"]!!.jsonArray.size)
        assertEquals("50", first["nextCursor"]!!.jsonPrimitive.content)
        val odd = obj(context.handle(call("2", "listSessions", """{"query":"odd","cursor":"50"}""")).text)
        assertEquals(10, odd["sessions"]!!.jsonArray.size)
        assertNull(odd["nextCursor"])
    }

    @Test
    fun aDispatchedRunFinishingIsAnnouncedAfterItsReplyNotOnAFlicker() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        context.handle(call("t1", "sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0}"""))
        val sent = targets.sends.first().id
        val b = CallTarget("b", "Docs", CallTarget.Kind.Task, status = CallTarget.Status.Idle)
        val asked = CallMessage(sent, CallMessage.Role.User, "go", delivery = CallMessage.Delivery.Accepted)
        // Idle for a moment before the message is taken: not finished.
        val flicker = context.targetChanged(CallTargetState(b, listOf(asked), working = false))
        assertTrue(flicker.prompts.isEmpty())
        assertTrue(flicker.context.any { it.contains("run_finished") })
        assertTrue(context.targetChanged(CallTargetState(b, listOf(asked), working = true)).prompts.isEmpty())
        val done = CallTargetState(b, listOf(asked, CallMessage("r1", CallMessage.Role.Assistant, "All green.")), working = false)
        val update = context.targetChanged(done)
        assertEquals(2, update.context.size)
        assertTrue(update.context[0].contains("All green."))
        assertTrue(update.context[1].contains("run_finished"))
        assertEquals(listOf("Docs finished. Tell the person its latest reply in a sentence or two."), update.prompts)
        // The same state again says nothing.
        assertTrue(context.targetChanged(done).isEmpty)
    }

    @Test
    fun aConversationNobodyFollowsSaysNothingButItsRow() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        val b = CallTarget("b", "Docs", CallTarget.Kind.Task, status = CallTarget.Status.Idle)
        assertTrue(context.targetChanged(CallTargetState(b, listOf(CallMessage("r", CallMessage.Role.Assistant, "secret")))).isEmpty)
        val row = context.directoryChanged(listOf(CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.Idle), b))
        assertEquals(1, row.context.size)
        assertTrue(row.prompts.isEmpty())
        assertFalse(row.context[0].contains("secret"))
        // Gone, its reference can't be used.
        val gone = context.directoryChanged(listOf(CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.Idle)))
        assertTrue(gone.context[0].contains(""""removed":["s2"]"""))
        assertTrue(context.handle(call("r", "getSessionContext", """{"targetRef":"s2"}""")).isError)
    }

    @Test
    fun partialWordsAreCoalescedAndNeedsInputAsksForTheApp() = runBlocking {
        var clock = 100_000L
        val context = CallContext(backend(messages = 0), now = { clock })
        context.initial()
        val a = CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.Running)
        fun state(text: String, working: Boolean = true, needsInput: Boolean = false) =
            CallTargetState(a, listOf(CallMessage("r", CallMessage.Role.Assistant, text, final = !working)), working = working, needsInput = needsInput)
        assertTrue(context.targetChanged(state("Look")).context.any { it.contains("Look") })
        clock += 100
        assertFalse(context.targetChanged(state("Looking")).context.any { it.contains("Looking") })
        clock += 500
        assertTrue(context.targetChanged(state("Looking at it")).context.any { it.contains("Looking at it") })
        val blocked = context.targetChanged(state("Looking at it", needsInput = true))
        assertEquals(listOf("Backend needs the person in the app. Say so briefly; don't try to answer it."), blocked.prompts)
    }

    @Test
    fun theToolsAreTheFiveWithNoPermissionOrQuestionTool() {
        assertEquals(listOf("listSessions", "getSessionContext", "openSession", "setSessionWatch", "sendMessage"), CallTool.entries.map { it.wire })
        assertEquals(listOf("targetRef", "text", "focusRevision"), CallTool.SendMessage.parameters["required"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(JsonArray(emptyList()), CallTool.ListSessions.parameters["required"])
    }
}

/** Conversations as a call reaches them, in memory. */
class FakeCallTargets(
    private val entries: List<CallTarget>,
    val states: MutableMap<String, CallTargetState>,
    private val focus: String?,
) : CallTargets {
    data class Sent(val agentId: String, val text: String, val id: String)

    private val lock = Mutex()
    @Volatile var sendDelay = 0L
    var onRead: (suspend () -> Unit)? = null
    val sends = java.util.Collections.synchronizedList(ArrayList<Sent>())
    val follows = java.util.Collections.synchronizedList(ArrayList<Pair<String, Boolean>>())
    val opened = java.util.Collections.synchronizedList(ArrayList<String>())

    override suspend fun directory() = entries
    override suspend fun state(agentId: String): CallTargetState? {
        onRead?.let { onRead = null; it() }
        return lock.withLock { states[agentId] }
    }
    override suspend fun focused() = focus
    override suspend fun open(agentId: String): Boolean { opened += agentId; return states[agentId] != null }
    override suspend fun send(agentId: String, text: String, id: String): CallSendOutcome {
        if (sendDelay > 0) try { delay(sendDelay) } catch (e: kotlinx.coroutines.CancellationException) { sends += Sent(agentId, text, id); throw e }
        sends += Sent(agentId, text, id)
        return CallSendOutcome.Queued
    }
    override suspend fun follow(agentId: String, following: Boolean) { follows += agentId to following }
}
