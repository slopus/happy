package com.slopus.happy.call

import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.FailureReason
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
import java.io.File

/** The agent connection's voice call: its context and its four tools, with the conversations faked (iOS `CallContextTests`). */
class CallContextTest {
    private val a = CallTarget("a", "Backend", CallTarget.Kind.Bot, status = CallTarget.Status.Idle)
    private val b = CallTarget("b", "Docs", CallTarget.Kind.Task, status = CallTarget.Status.Running)

    /** Backend: three finished turns, one that only steered, and a message no turn has answered yet. */
    private fun backend(focus: String? = "a"): FakeCallTargets {
        val turns = listOf(
            CallTurn("r1", "first ask", "first answer"),
            CallTurn("r2", "second ask", "second answer"),
            CallTurn("r3", "steer", ended = "steering"),
            CallTurn("r4", "third ask", "third answer"),
        )
        val messages = listOf(
            CallMessage("u1", CallMessage.Role.User, "first ask"), CallMessage("x1", CallMessage.Role.Assistant, "first answer"),
            CallMessage("u2", CallMessage.Role.User, "second ask"), CallMessage("x2", CallMessage.Role.Assistant, "second answer"),
            CallMessage("u4", CallMessage.Role.User, "third ask"), CallMessage("x4", CallMessage.Role.Assistant, "third answer"),
            CallMessage("u5", CallMessage.Role.User, "still waiting", delivery = CallMessage.Delivery.Accepted),
        )
        return FakeCallTargets(listOf(a, b), mutableMapOf(
            "a" to CallTargetState(a, messages, turns, unanswered = messages.last(), hasDraft = true),
            "b" to CallTargetState(b, working = true),
        ), focus)
    }

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun call(id: String, name: String, json: String) = CallToolCall(id, name, obj(json))
    private fun events(update: CallUpdate) = update.context.map(::obj)
    private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private var calls = 0
    private suspend fun CallContext.tool(name: String, json: String, id: String = "c${calls++}") = handle(CallToolCall(id, name, obj(json)))

    // History

    @Test
    fun theFirstSnapshotHoldsTheFocusWithItsLastTwoTurnsAndThePendingMessage() = runBlocking {
        val context = CallContext(backend(), now = { 1_700_000_000_000 })
        val snapshot = obj(context.initial())
        assertEquals(1, snapshot["schema"]!!.jsonPrimitive.int)
        assertEquals(0, snapshot["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("listSessions", "getSessionContext", "openSession", "sendMessage"), snapshot["tools"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("2023-11-14T22:13:20Z", snapshot.str("at"))
        val focus = snapshot["focus"]!!.jsonObject
        assertEquals("s1", focus.str("targetRef"))
        assertEquals("Backend", focus.str("title"))
        assertNull(focus["hasDraft"])
        assertNull(focus["messages"])
        // The last two turns that answered: the steering one in between is skipped.
        val turns = focus["turns"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("second ask", "third ask"), turns.map { it.str("user") })
        assertEquals(listOf("second answer", "third answer"), turns.map { it.str("assistant") })
        assertTrue(focus["olderTurns"]!!.jsonPrimitive.boolean)
        val pending = focus["pendingUserMessage"]!!.jsonObject
        assertEquals("still waiting", pending.str("text"))
        assertEquals("accepted", pending.str("delivery"))
        val directory = snapshot["directory"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("s1", "s2"), directory.map { it.str("targetRef") })
        assertEquals("running", directory[1].str("status"))
        assertEquals(listOf("a"), context.followed())
    }

    @Test
    fun theSnapshotKeepsItsBudgets() = runBlocking {
        val long = "é".repeat(5000)
        val turns = (0 until 10).map { CallTurn("r$it", long, long) }
        val many = (0 until 300).map { CallTarget("x$it", "n".repeat(200), CallTarget.Kind.Conversation, status = CallTarget.Status.Idle) }
        val state = CallTargetState(a, turns = turns, unanswered = CallMessage("p", CallMessage.Role.User, long))
        val text = CallContext(FakeCallTargets(listOf(a) + many, mutableMapOf("a" to state), "a")).initial()
        assertTrue(text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        val snapshot = obj(text)
        assertTrue(snapshot["directoryTruncated"]!!.jsonPrimitive.boolean)
        val focus = snapshot["focus"]!!.jsonObject
        val shown = focus["turns"]!!.jsonArray.map { it.jsonObject }
        assertTrue(shown.size <= CallContext.Limits.TURNS)
        for (turn in shown) {
            assertTrue(turn.str("assistant")!!.utf8Size() <= CallContext.Limits.MESSAGE_BYTES)
            assertTrue(turn["truncated"]!!.jsonPrimitive.boolean)
        }
        assertTrue(focus["pendingUserMessage"]!!.jsonObject["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun truncationKeepsWholeCharacters() {
        assertEquals("aé", CallContext.truncated("aé😀", 4))
        assertEquals("aé😀", CallContext.truncated("aé😀", 7))
    }

    @Test
    fun readingAConversationGivesItsLastTwoTurnsAndChangesNothingHeard() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        val read = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)
        assertEquals(listOf("second answer", "third answer"), read["turns"]!!.jsonArray.map { it.jsonObject.str("assistant") })
        assertEquals("still waiting", read["pendingUserMessage"]!!.jsonObject.str("text"))
        assertFalse(read["working"]!!.jsonPrimitive.boolean)
        assertFalse(read["needsInput"]!!.jsonPrimitive.boolean)
        context.tool("listSessions", "{}")
        assertTrue(context.followed().isEmpty())
        // Not visited, so its new words say nothing.
        assertTrue(context.targetChanged(CallTargetState(a, listOf(CallMessage("n", CallMessage.Role.Assistant, "new")))).isEmpty)
    }

    @Test
    fun aFailedTurnIsReadWithItsReason() = runBlocking {
        val turns = listOf(CallTurn("r1", "ask", "fine"), CallTurn("r2", "again", ended = "error", error = "Rate limited"))
        val context = CallContext(FakeCallTargets(listOf(a), mutableMapOf("a" to CallTargetState(a, turns = turns)), null))
        context.initial()
        val read = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)
        val last = read["turns"]!!.jsonArray.last().jsonObject
        assertEquals("error", last.str("ended"))
        assertEquals("Rate limited", last.str("error"))
        assertNull(last["assistant"])
        assertNull(read["pendingUserMessage"])
    }

    // The last four visited

    @Test
    fun theLastFourVisitedAreHeardAndTheFifthIsLetGo() = runBlocking {
        val ids = listOf("v1", "v2", "v3", "v4", "v5")
        val context = CallContext(FakeCallTargets(ids.map { CallTarget(it, it.uppercase(), CallTarget.Kind.Task, status = CallTarget.Status.Idle) }, mutableMapOf(), null))
        context.initial()
        for (id in ids) context.focusChanged(id)
        assertEquals(listOf("v5", "v4", "v3", "v2"), context.followed())
        // The fifth one back is no longer heard from.
        val first = CallTarget("v1", "V1", CallTarget.Kind.Task, status = CallTarget.Status.Idle)
        val hi = CallMessage("m", CallMessage.Role.Assistant, "hi")
        assertTrue(context.targetChanged(CallTargetState(first, listOf(hi))).isEmpty)
        // Visiting one again makes it the latest.
        context.focusChanged("v2")
        assertEquals(listOf("v2", "v5", "v4", "v3"), context.followed())
        // Back after it was let go, what it says then is what was there: nothing is replayed.
        context.focusChanged("v1")
        assertEquals(listOf("v1", "v2", "v5", "v4"), context.followed())
        assertTrue(context.targetChanged(CallTargetState(first, listOf(hi))).isEmpty)
        val next = events(context.targetChanged(CallTargetState(first, listOf(hi, CallMessage("m2", CallMessage.Role.Assistant, "new")))))
        assertEquals(listOf("new"), next.map { it.str("delta") })
    }

    @Test
    fun settingsOrHomeInFrontKeepTheVisited() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        assertFalse(context.tool("openSession", """{"targetRef":"s2","focusRevision":0}""").isError)
        context.focusChanged("b")
        val settings = events(context.focusChanged(null))
        assertEquals("focus", settings.single().str("event"))
        assertEquals(JsonNull, settings.single()["targetRef"])
        assertEquals(2, settings.single()["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("b", "a"), context.followed())
        // Still heard from while Settings is in front.
        val docs = CallTargetState(b, working = true)
        context.targetChanged(docs)
        val words = events(context.targetChanged(docs.copy(messages = listOf(CallMessage("w", CallMessage.Role.Assistant, "Working on it", final = false)))))
        assertEquals(listOf("assistant_text"), words.map { it.str("event") })
    }

    @Test
    fun aFocusSaysWhichButNotItsHistory() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        val focus = events(context.focusChanged("a")).single()
        assertEquals("s1", focus.str("targetRef"))
        assertEquals("Backend", focus.str("title"))
        assertNull(focus["turns"])
        assertFalse(focus.toString().contains("answer"))
    }

    @Test
    fun openingGivesTheRevisionTheNextStepTakes() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        val opened = obj(context.tool("openSession", """{"targetRef":"s2","focusRevision":0}""").text)
        assertEquals(1, opened["focusRevision"]!!.jsonPrimitive.int)
        // The screen saying the same afterwards tells the agent nothing new.
        assertTrue(context.focusChanged("b").isEmpty)
        // Chained on what the open gave, the next open goes.
        val next = context.tool("openSession", """{"targetRef":"s1","focusRevision":1}""")
        assertFalse(next.isError)
        assertEquals(2, obj(next.text)["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("a", "b"), context.followed())
        val send = obj(context.tool("sendMessage", """{"targetRef":"s2","text":"go","focusRevision":2}""").text)
        assertEquals("queued", send.str("status"))
        assertEquals("on the person's device, not confirmed delivered or read", send.str("delivery"))
    }

    // New words only

    @Test
    fun onlyNewWordsGoAsDeltasAtMostEveryHalfSecond() = runBlocking {
        var clock = 100_000L
        val context = CallContext(backend(focus = null), now = { clock })
        context.initial()
        context.focusChanged("a")
        val old = listOf(CallMessage("x4", CallMessage.Role.Assistant, "third answer"))
        fun state(text: String, working: Boolean = true) =
            CallTargetState(a, old + CallMessage("r", CallMessage.Role.Assistant, text, final = !working), working = working)
        // The first sight is what was there: nothing goes.
        assertTrue(context.targetChanged(CallTargetState(a, old)).isEmpty)
        val look = events(context.targetChanged(state("Look")))
        assertEquals(listOf("Look"), look.map { it.str("delta") })
        assertFalse(look.single()["final"]!!.jsonPrimitive.boolean)
        clock += 100
        assertTrue(context.targetChanged(state("Looking")).isEmpty)
        clock += 500
        assertEquals(listOf("ing at it"), events(context.targetChanged(state("Looking at it"))).map { it.str("delta") })
        clock += 100
        // The run over, the rest goes at once, whatever the clock.
        val done = events(context.targetChanged(state("Looking at it. Done.", working = false)))
        assertEquals(listOf(". Done."), done.map { it.str("delta") })
        assertTrue(done.single()["final"]!!.jsonPrimitive.boolean)
        assertFalse(done.toString().contains("third answer"))
        assertTrue(context.targetChanged(state("Looking at it. Done.", working = false)).isEmpty)
    }

    @Test
    fun aRewrittenMessageIsSentWholeOnce() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        fun state(text: String) = CallTargetState(a, listOf(CallMessage("r", CallMessage.Role.Assistant, text)))
        context.targetChanged(state("Hello there"))
        val reset = events(context.targetChanged(state("Goodbye")))
        assertEquals(listOf("assistant_text_reset"), reset.map { it.str("event") })
        assertEquals("Goodbye", reset.single().str("text"))
        assertEquals(listOf(" now"), events(context.targetChanged(state("Goodbye now"))).map { it.str("delta") })
    }

    @Test
    fun aReplyStopsAtFourKilobytes() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        fun state(count: Int) = CallTargetState(a, listOf(CallMessage("r", CallMessage.Role.Assistant, "é".repeat(count))))
        assertEquals(2000, events(context.targetChanged(state(1000))).single().str("delta")!!.utf8Size())
        val over = events(context.targetChanged(state(3000))).single()
        assertEquals(2096, over.str("delta")!!.utf8Size())
        assertTrue(over["truncated"]!!.jsonPrimitive.boolean)
        assertTrue(context.targetChanged(state(4000)).isEmpty)
    }

    @Test
    fun deltasKeepEachMessagesIdentityAndOrder() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        fun state(first: String, second: String, working: Boolean = true) = CallTargetState(a, listOf(
            CallMessage("p1", CallMessage.Role.Assistant, first),
            CallMessage("u", CallMessage.Role.User, "and?"),
            CallMessage("p2", CallMessage.Role.Assistant, second, final = !working),
        ), working = working)
        val both = events(context.targetChanged(state("One.", "Two")))
        assertEquals(listOf("p1", "p2"), both.map { it.str("messageId") })
        assertEquals(listOf("One.", "Two"), both.map { it.str("delta") })
        assertEquals(listOf(true, false), both.map { it["final"]!!.jsonPrimitive.boolean })
        val rest = events(context.targetChanged(state("One.", "Two, three.", working = false)))
        assertEquals(listOf("p2"), rest.map { it.str("messageId") })
        assertEquals(listOf(", three."), rest.map { it.str("delta") })
    }

    @Test
    fun theSameWordsFinishedSayTheirEndOnce() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        fun state(working: Boolean) = CallTargetState(a, listOf(CallMessage("r", CallMessage.Role.Assistant, "All done.", final = !working)), working = working)
        assertEquals(listOf(false), events(context.targetChanged(state(true))).map { it["final"]!!.jsonPrimitive.boolean })
        val end = events(context.targetChanged(state(false))).single()
        assertEquals("", end.str("delta"))
        assertTrue(end["final"]!!.jsonPrimitive.boolean)
        assertTrue(context.targetChanged(state(false)).isEmpty)
    }

    @Test
    fun whatTheWaitLostIsPutRightInOneGo() = runBlocking {
        var clock = 0L
        val context = CallContext(backend(), now = { clock })
        context.initial()
        context.focusChanged("b")
        context.focusChanged("a")
        fun state(text: String) = CallTargetState(a, listOf(CallMessage("r", CallMessage.Role.Assistant, text, final = false)), working = true)
        context.targetChanged(state("Half"))
        clock += 600
        context.targetChanged(state("Half way"))
        context.targetChanged(CallTargetState(a, listOf(CallMessage("r", CallMessage.Role.Assistant, "Half way")), listOf(CallTurn("x", ended = "error", error = "Boom")), working = true))
        // Say every one of those was lost: the agent gets the focus as it is, and each message whole.
        val fixed = events(context.resync())
        assertEquals("focus", fixed.first().str("event"))
        assertTrue(fixed.first()["resync"]!!.jsonPrimitive.boolean)
        assertEquals(2, fixed.first()["focusRevision"]!!.jsonPrimitive.int)
        assertEquals("s1", fixed.first().str("targetRef"))
        assertEquals(listOf("session_error", "assistant_text_reset"), fixed.drop(1).map { it.str("event") })
        assertEquals("Half way", fixed.last().str("text"))
        assertEquals("r", fixed.last().str("messageId"))
        // Baseline history isn't streamed, so none of it comes back.
        assertFalse(fixed.toString().contains("third answer"))
        // And words after it go on from there.
        val next = events(context.targetChanged(CallTargetState(a, listOf(CallMessage("r", CallMessage.Role.Assistant, "Half way there")))))
        assertEquals(listOf(" there"), next.map { it.str("delta") })
    }

    @Test
    fun aReplyBeingWrittenWhenFirstSeenGoesFromItsStart() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        context.focusChanged("b")
        context.targetChanged(CallTargetState(b, listOf(CallMessage("w", CallMessage.Role.Assistant, "Halfway", final = false)), working = true))
        val next = events(context.targetChanged(CallTargetState(b, listOf(CallMessage("w", CallMessage.Role.Assistant, "Halfway there")))))
        assertEquals(listOf("Halfway there"), next.map { it.str("delta") })
    }

    @Test
    fun anErrorThatStoppedATurnIsSaidOnceAndNothingElseIs() = runBlocking {
        val targets = backend()
        var state = CallTargetState(a, turns = listOf(CallTurn("old", ended = "error", error = "Old failure")))
        targets.states["a"] = state
        val context = CallContext(targets)
        context.initial()
        // The error that was there when the call began isn't news.
        assertTrue(context.targetChanged(state).isEmpty)
        // Working, needing the person, the person's messages and their delivery: none of it goes.
        state = state.copy(working = true, target = a.copy(status = CallTarget.Status.Running),
            messages = listOf(CallMessage("u", CallMessage.Role.User, "do it", delivery = CallMessage.Delivery.Queued)))
        assertTrue(context.targetChanged(state).isEmpty)
        state = state.copy(needsInput = true, target = a.copy(status = CallTarget.Status.NeedsInput),
            messages = listOf(CallMessage("u", CallMessage.Role.User, "do it", delivery = CallMessage.Delivery.Failed)))
        assertTrue(context.targetChanged(state).isEmpty)
        state = state.copy(working = false, needsInput = false, turns = state.turns + CallTurn("new", "do it", ended = "error", error = "The model refused"))
        val stopped = events(context.targetChanged(state))
        assertEquals(listOf("session_error"), stopped.map { it.str("event") })
        assertEquals("The model refused", stopped.single().str("reason"))
        assertEquals("s1", stopped.single().str("target"))
        assertTrue(context.targetChanged(state).isEmpty)
        // Stopped by the person is no error.
        assertTrue(context.targetChanged(state.copy(turns = state.turns + CallTurn("stop", "x", ended = "abort"))).isEmpty)
    }

    // Tools

    @Test
    fun sendMessageQueuesTheExactTextOnceAndHearsNothingMore() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val send = CallToolCall("t1", "sendMessage", obj("""{"targetRef":"s2","text":"  run the checks ","focusRevision":0}"""))
        val first = context.handle(send)
        assertFalse(first.isError)
        assertEquals("queued", obj(first.text).str("status"))
        // The provider asking again under the same ID gets the same answer.
        assertEquals(first, context.handle(send))
        assertEquals(listOf("  run the checks "), targets.sends.map { it.text })
        assertEquals(listOf("b"), targets.sends.map { it.agentId })
        // Sending neither opens it nor adds it to what the call hears.
        assertEquals(listOf("a"), context.followed())
        assertTrue(targets.opened.isEmpty())
        assertTrue(targets.follows.isEmpty())
        assertTrue(context.targetChanged(CallTargetState(b, listOf(CallMessage("r", CallMessage.Role.Assistant, "Done")))).isEmpty)
    }

    @Test
    fun sendMessageRefusesWhatItMustNotSend() = runBlocking {
        val targets = backend()
        targets.states["a"] = CallTargetState(a.copy(status = CallTarget.Status.NeedsInput), needsInput = true)
        val context = CallContext(targets)
        context.initial()
        val refusals = listOf(
            """{"targetRef":"s1","text":"yes","focusRevision":0}""",
            """{"targetRef":"s2","text":"go","focusRevision":3}""",
            """{"targetRef":"s9","text":"go","focusRevision":0}""",
            """{"targetRef":"s2","text":"  ","focusRevision":0}""",
            """{"targetRef":"s2","text":7,"focusRevision":0}""",
            """{"targetRef":"s2","text":"${"é".repeat(4097)}","focusRevision":0}""",
        )
        for (json in refusals) assertTrue(json, context.tool("sendMessage", json).isError)
        assertTrue(context.tool("processPermissionRequest", "{}").isError)
        assertEquals("Unknown tool.", obj(context.tool("setSessionWatch", """{"targetRef":"s2","enabled":true}""").text).str("reason"))
        assertTrue(targets.sends.isEmpty())
        // 8 KiB exactly is fine.
        assertFalse(context.tool("sendMessage", """{"targetRef":"s2","text":"${"é".repeat(4096)}","focusRevision":0}""").isError)
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
    fun argumentsAreCheckedAgainstTheSchema() = runBlocking {
        val x = CallTarget("x", "X", CallTarget.Kind.Task, status = CallTarget.Status.Idle)
        val targets = FakeCallTargets(listOf(x), mutableMapOf("x" to CallTargetState(x)), null)
        val context = CallContext(targets)
        context.initial()
        for (bad in listOf("\"0\"", "true", "0.5", "null")) {
            assertTrue(bad, context.tool("openSession", """{"targetRef":"s1","focusRevision":$bad}""").isError)
        }
        assertTrue(targets.opened.isEmpty())
        assertFalse(context.tool("openSession", """{"targetRef":"s1","focusRevision":0}""").isError)
        for (bad in listOf("""{"query":3}""", """{"cursor":5}""", """{"cursor":"-1"}""", """{"cursor":"x"}""")) {
            assertTrue(bad, context.tool("listSessions", bad).isError)
        }
        assertTrue(context.tool("getSessionContext", """{"targetRef":1}""").isError)
    }

    @Test
    fun theFourToolsAreDescribedForTheDashboard() {
        assertEquals(listOf("listSessions", "getSessionContext", "openSession", "sendMessage"), CallTool.entries.map { it.wire })
        assertEquals("integer", CallTool.OpenSession.parameters["properties"]!!.jsonObject["focusRevision"]!!.jsonObject.str("type"))
        assertEquals(listOf("targetRef", "text", "focusRevision"), CallTool.SendMessage.parameters["required"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("targetRef"), CallTool.GetSessionContext.parameters["required"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(JsonArray(emptyList()), CallTool.ListSessions.parameters["required"])
        assertTrue(CallTool.ListSessions.summary.contains("case-insensitive substring"))
        assertTrue(CallTool.SendMessage.summary.contains("queued on the person's device, not confirmed delivered or read"))
        assertTrue(CallTool.SendMessage.summary.contains("8 KiB"))
    }

    /** docs/agent-voice-call.md's client tools are what the phone answers, word for word. */
    @Test
    fun theDocsHoldTheseToolsExactly() {
        val doc = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "docs/agent-voice-call.md") }.first { it.exists() }.readText()
        val tools = Regex("```json\n(.*?)\n```", RegexOption.DOT_MATCHES_ALL).findAll(doc)
            .map { obj(it.groupValues[1]) }.filter { it.str("type") == "client" }.toList()
        assertEquals(CallTool.entries.map { it.wire }, tools.map { it.str("name") })
        for ((tool, documented) in CallTool.entries.zip(tools)) {
            assertEquals(tool.wire, tool.summary, documented.str("description"))
            assertEquals(tool.wire, tool.parameters, documented["parameters"])
        }
    }

    @Test
    fun listSessionsPagesAndFiltersBySubstring() = runBlocking {
        val many = (0 until 120).map { CallTarget("x$it", if (it % 2 == 0) "Even $it" else "Odd $it", CallTarget.Kind.Conversation, status = CallTarget.Status.Idle) }
        val context = CallContext(FakeCallTargets(many, mutableMapOf(), null))
        context.initial()
        val first = obj(context.tool("listSessions", "{}").text)
        assertEquals(50, first["sessions"]!!.jsonArray.size)
        assertEquals("50", first.str("nextCursor"))
        assertEquals(16, obj(context.tool("listSessions", """{"query":"DD 1","cursor":null}""").text)["sessions"]!!.jsonArray.size)
        val paged = obj(context.tool("listSessions", """{"query":"odd","cursor":"50"}""").text)
        assertEquals(10, paged["sessions"]!!.jsonArray.size)
        assertNull(paged["nextCursor"])
    }

    @Test
    fun theDirectorySaysWhatCameWentOrWasRenamedButNoStatus() = runBlocking {
        val context = CallContext(backend())
        // Its watch answering at once, ahead of the snapshot that holds it all: nothing to say.
        assertTrue(context.directoryChanged(listOf(a, b)).isEmpty)
        context.initial()
        assertTrue(context.directoryChanged(listOf(a, b.copy(status = CallTarget.Status.Idle))).isEmpty)
        val renamed = events(context.directoryChanged(listOf(a, b.copy(title = "Docs site"))))
        assertEquals(listOf("Docs site"), renamed.single()["changed"]!!.jsonArray.map { it.jsonObject.str("title") })
        // Gone, its reference can't be used, and it isn't heard from.
        val gone = context.directoryChanged(listOf(b))
        assertTrue(gone.context.single().contains(""""removed":["s1"]"""))
        assertTrue(context.tool("getSessionContext", """{"targetRef":"s1"}""").isError)
        assertTrue(context.followed().isEmpty())
    }

    @Test
    fun aConversationReadsAsTurnsOfPublicWordsOnly() {
        fun user(id: String, text: String, delivery: Delivery = Delivery.Sent) = ConversationRow.User(id, id, text, emptyList(), emptyList(), delivery)
        fun text(key: String, text: String) = ConversationRow.Text(key, text, emptyList())
        val rows = listOf(
            user("u1", "fix it"),
            text("a1:0", "Looking"),
            text("a2:0", "Fixed."),
            ConversationRow.TurnEnd("r1:end", "r1", "completed", 10, 1, "Fixed."),
            user("u2", "again"),
            ConversationRow.Failure("f", "f", FailureReason.RateLimited("Claude"), retryable = true, resolved = false),
            ConversationRow.TurnEnd("r2:end", "r2", "error", 10, 0, null),
            user("u3", "hello", Delivery.Sending),
            text("x:0", "thinking out loud"),
        )
        val conversation = ConversationState(created = true, loaded = true, working = true, rows = rows, draft = "half typed")
        val state = CallTargetState.from(conversation, a) { reason -> "rate limited: ${(reason as FailureReason.RateLimited).vendor}" }
        assertEquals(listOf(CallTurn("r1", "fix it", "Fixed."), CallTurn("r2", "again", null, "error", "rate limited: Claude")), state.turns)
        assertEquals("hello", state.unanswered?.text)
        assertEquals(CallMessage.Delivery.Queued, state.unanswered?.delivery)
        assertEquals(listOf("Looking", "Fixed.", "thinking out loud"), state.messages.filter { it.role == CallMessage.Role.Assistant }.map { it.text })
        assertFalse(state.messages.last().final)
        assertTrue(state.hasDraft)
        assertEquals(CallTarget.Status.Running, state.target.status)
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
