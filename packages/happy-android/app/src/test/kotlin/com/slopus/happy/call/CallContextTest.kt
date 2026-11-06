package com.slopus.happy.call

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

/** The agent connection's voice call: its context and its tools, with the conversations faked (iOS `CallContextTests`). */
class CallContextTest {
    private val backendTarget = CallTarget("a", "Backend", CallTarget.Kind.Bot, CallTarget.Status.Idle)
    private val docsTarget = CallTarget("b", "Docs", CallTarget.Kind.Task, CallTarget.Status.Running)
    private val releaseTarget = CallTarget("t", "Release notes", CallTarget.Kind.Task, CallTarget.Status.Idle)
    private val fixTarget = CallTarget("c", "Fix cache race", CallTarget.Kind.Subtask, CallTarget.Status.Running,
        listOf(CallTarget.Parent("task:t", "Release notes", "task", "t")))

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
        return FakeCallTargets(listOf(backendTarget, docsTarget), mutableMapOf(
            "a" to CallTargetState(backendTarget, messages, turns, unanswered = messages.last(), hasDraft = true),
            "b" to CallTargetState(docsTarget, working = true),
        ), focus)
    }

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun call(id: String, name: String, json: String) = CallToolCall(id, name, obj(json))
    private fun events(update: CallUpdate) = update.context.map(::obj)
    private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.strings(key: String) = this[key]?.jsonArray?.map { it.jsonPrimitive.content }
    private fun JsonObject.turns() = this["turns"]!!.jsonArray.map { it.jsonObject }
    private fun size(update: CallUpdate) = update.context.sumOf { it.utf8Size() + 1 }
    private var calls = 0
    private suspend fun CallContext.tool(name: String, json: String, id: String = "c${calls++}") = handle(CallToolCall(id, name, obj(json)))

    // History

    @Test
    fun theFirstSnapshotHoldsTheFocusWithItsLastFiveTurnsThePendingMessageOneOfThem() = runBlocking {
        val context = CallContext(backend(), now = { 1_700_000_000_000 })
        val snapshot = obj(context.initial())
        assertEquals(2, snapshot["schema"]!!.jsonPrimitive.int)
        assertEquals(0, snapshot["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("listSessions", "getSessionContext", "openSession", "sendMessage", "newWork", "goBack", "goHome"), snapshot.strings("tools"))
        assertEquals("2023-11-14T22:13:20Z", snapshot.str("at"))
        val focus = snapshot["focus"]!!.jsonObject
        // Named as the directory names it, which alone gives its reference.
        assertEquals("Backend", focus.str("title"))
        assertEquals(emptyList<String>(), focus.strings("parents"))
        for (key in listOf("ref", "targetRef", "kind", "status", "hasDraft", "messages")) assertNull(key, focus[key])
        // Four finished turns and the message waiting: five. The steered one has the person's half only.
        val turns = focus.turns()
        assertEquals(listOf("first ask", "second ask", "steer", "third ask"), turns.map { it.str("user") })
        assertEquals(listOf("first answer", "second answer", null, "third answer"), turns.map { it.str("assistant") })
        assertEquals(listOf("completed", "completed", "steering", "completed"), turns.map { it.str("ended") })
        assertFalse(focus["olderTurns"]!!.jsonPrimitive.boolean)
        val pending = focus["pendingUserMessage"]!!.jsonObject
        assertEquals("still waiting", pending.str("text"))
        assertEquals("accepted", pending.str("delivery"))
        assertEquals("Conversation directory:\nBackend [bot; ref=s1]\nDocs [task; ref=s2]", snapshot.str("directory"))
        assertEquals(listOf("a"), context.followed())
    }

    @Test
    fun theSnapshotKeepsItsBudgets() = runBlocking {
        val long = "é".repeat(5000)
        val turns = (0 until 10).map { CallTurn("r$it", long, long) }
        val many = (0 until 300).map { CallTarget("x$it", "n".repeat(200), CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val state = CallTargetState(backendTarget, turns = turns, unanswered = CallMessage("p", CallMessage.Role.User, long))
        val text = CallContext(FakeCallTargets(listOf(backendTarget) + many, mutableMapOf("a" to state), "a")).initial()
        assertTrue(text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        val snapshot = obj(text)
        val directory = snapshot.str("directory")!!
        assertTrue(directory, directory.endsWith("more; listSessions finds them by title."))
        assertTrue(directory.utf8Size() <= CallContext.Limits.DIRECTORY_BYTES)
        val focus = snapshot["focus"]!!.jsonObject
        val shown = focus.turns()
        assertTrue(shown.size <= CallContext.Limits.TURNS)
        for (turn in shown) {
            assertTrue((turn.str("assistant")?.utf8Size() ?: 0) <= CallContext.Limits.MESSAGE_BYTES)
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
    fun readingAConversationGivesItsLastFiveTurnsAndChangesNothingHeard() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        val read = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)
        assertEquals(listOf("first answer", "second answer", null, "third answer"), read.turns().map { it.str("assistant") })
        assertEquals("still waiting", read["pendingUserMessage"]!!.jsonObject.str("text"))
        assertFalse(read["working"]!!.jsonPrimitive.boolean)
        assertFalse(read["needsInput"]!!.jsonPrimitive.boolean)
        context.tool("listSessions", "{}")
        assertTrue(context.followed().isEmpty())
        // Not visited, so its new words say nothing.
        assertTrue(context.targetChanged(CallTargetState(backendTarget, listOf(CallMessage("n", CallMessage.Role.Assistant, "new")))).isEmpty)
    }

    /**
     * Five in all: five finished turns with nothing waiting, four with a
     * message waiting; an answer with no message of the person's is half a
     * pair; a read within 32 KB, oldest first to go.
     */
    @Test
    fun fiveTurnsInAllAndTheBudgetHolds() = runBlocking {
        val turns = (1..7).map { CallTurn("r$it", "ask $it", "answer $it") } + CallTurn("r8", reply = "done on its own")
        val targets = FakeCallTargets(listOf(backendTarget), mutableMapOf("a" to CallTargetState(backendTarget, turns = turns)), null)
        val context = CallContext(targets)
        context.initial()
        var read = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)
        assertEquals(listOf("answer 4", "answer 5", "answer 6", "answer 7", "done on its own"), read.turns().map { it.str("assistant") })
        assertNull(read.turns().last()["user"])
        assertTrue(read["olderTurns"]!!.jsonPrimitive.boolean)
        targets.states["a"] = CallTargetState(backendTarget, turns = turns, unanswered = CallMessage("p", CallMessage.Role.User, "and now?"))
        read = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)
        assertEquals(4, read.turns().size)
        assertEquals("and now?", read["pendingUserMessage"]!!.jsonObject.str("text"))
        val long = "é".repeat(5000)
        targets.states["a"] = CallTargetState(backendTarget, turns = (0 until 6).map { CallTurn("l$it", long, long) })
        val big = context.tool("getSessionContext", """{"targetRef":"s1"}""")
        assertTrue(big.text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        val shown = obj(big.text).turns()
        assertTrue(shown.size in 1 until 5)
    }

    @Test
    fun aFailedTurnIsReadWithItsReason() = runBlocking {
        val turns = listOf(CallTurn("r1", "ask", "fine"), CallTurn("r2", "again", ended = "error", error = "Rate limited"))
        val context = CallContext(FakeCallTargets(listOf(backendTarget), mutableMapOf("a" to CallTargetState(backendTarget, turns = turns)), null))
        context.initial()
        val read = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)
        val last = read.turns().last()
        assertEquals("error", last.str("ended"))
        assertEquals("Rate limited", last.str("error"))
        assertNull(last["assistant"])
        assertNull(read["pendingUserMessage"])
    }

    // The last four visited

    @Test
    fun theLastFourVisitedAreHeardAndTheFifthIsLetGo() = runBlocking {
        val ids = listOf("v1", "v2", "v3", "v4", "v5")
        val context = CallContext(FakeCallTargets(ids.map { CallTarget(it, it.uppercase(), CallTarget.Kind.Task, CallTarget.Status.Idle) }, mutableMapOf(), null))
        context.initial()
        for (id in ids) context.focusChanged(id)
        assertEquals(listOf("v5", "v4", "v3", "v2"), context.followed())
        // The fifth one back is no longer heard from.
        val first = CallTarget("v1", "V1", CallTarget.Kind.Task, CallTarget.Status.Idle)
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
        assertEquals(listOf("new"), next.map { it.str("text") })
    }

    @Test
    fun settingsOrHomeInFrontKeepTheVisited() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        assertFalse(context.tool("openSession", """{"targetRef":"s2","focusRevision":0}""").isError)
        context.focusChanged("b")
        val settings = events(context.focusChanged(null))
        assertEquals("focus", settings.single().str("event"))
        assertEquals(JsonNull, settings.single()["title"])
        assertEquals(2, settings.single()["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("b", "a"), context.followed())
        // Still heard from while Settings is in front.
        val docs = CallTargetState(docsTarget, working = true)
        context.targetChanged(docs)
        val words = events(context.targetChanged(docs.copy(messages = listOf(CallMessage("w", CallMessage.Role.Assistant, "Working on it")))))
        assertEquals(listOf("assistant_text"), words.map { it.str("event") })
    }

    @Test
    fun aFocusSaysWhichButNotItsHistory() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        val focus = events(context.focusChanged("a")).single()
        assertEquals("Backend", focus.str("title"))
        assertEquals(emptyList<String>(), focus.strings("parents"))
        assertNull(focus["ref"])
        assertNull(focus["targetRef"])
        assertNull(focus["turns"])
        assertFalse(focus.toString().contains("answer"))
    }

    /** "queued" is no receipt: a send that fails afterwards is said by nothing on its own, and read where the agent looks for it. */
    @Test
    fun aSendThatFailsLaterIsReadNotAnnounced() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        assertEquals("queued", obj(context.tool("sendMessage", """{"targetRef":"s1","text":"run it","focusRevision":0}""").text).str("status"))
        val failed = CallMessage("run", CallMessage.Role.User, "run it", delivery = CallMessage.Delivery.Failed)
        val state = targets.states.getValue("a").let { it.copy(messages = it.messages + failed, unanswered = failed) }
        targets.states["a"] = state
        assertTrue(context.targetChanged(state).isEmpty)
        val pending = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)["pendingUserMessage"]!!.jsonObject
        assertEquals("run it", pending.str("text"))
        assertEquals("failed", pending.str("delivery"))
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

    // Complete words only

    /** While the agent writes, nothing goes, however long it pauses; once it is complete the whole of it goes, once. */
    @Test
    fun aMessageGoesWholeOnceWhenCompleteAndNeverWhileItGrows() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        context.focusChanged("a")
        val old = listOf(CallMessage("x4", CallMessage.Role.Assistant, "third answer"))
        fun state(text: String, working: Boolean = true) =
            CallTargetState(backendTarget, old + CallMessage("r", CallMessage.Role.Assistant, text, final = !working), working = working)
        // The first sight is what was there: nothing goes.
        assertTrue(context.targetChanged(CallTargetState(backendTarget, old)).isEmpty)
        for (text in listOf("Look", "Looking", "Looking at it")) assertTrue(text, context.targetChanged(state(text)).isEmpty)
        // A pause is no end: the same words, still being written, a while later.
        delay(600)
        assertTrue(context.targetChanged(state("Looking at it")).isEmpty)
        val done = events(context.targetChanged(state("Looking at it. Done.", working = false)))
        assertEquals(listOf("assistant_text"), done.map { it.str("event") })
        assertEquals("Looking at it. Done.", done.single().str("text"))
        // By its title, never an ID or a reference.
        assertEquals("Backend", done.single().str("title"))
        assertEquals(emptyList<String>(), done.single().strings("parents"))
        for (key in listOf("messageId", "target", "ref", "delta", "final")) assertNull(key, done.single()[key])
        assertFalse(done.toString().contains("third answer"))
        // A status, a refresh, the same state again: nothing more.
        val refreshed = state("Looking at it. Done.", working = false).let { it.copy(target = it.target.copy(status = CallTarget.Status.Waiting), hasMore = true) }
        assertTrue(context.targetChanged(refreshed).isEmpty)
    }

    /** Words before a tool call are complete once the call comes, mid-run: they go then, without waiting for the turn to end. */
    @Test
    fun wordsTheAgentWentOnFromGoMidRunEachOnce() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        fun state(messages: List<CallMessage>, working: Boolean = true) = CallTargetState(backendTarget, messages, working = working)
        context.targetChanged(state(emptyList()))
        assertTrue(context.targetChanged(state(listOf(CallMessage("p1", CallMessage.Role.Assistant, "Let me check the logs", final = false)))).isEmpty)
        val checked = events(context.targetChanged(state(listOf(
            CallMessage("p1", CallMessage.Role.Assistant, "Let me check the logs."),
            CallMessage("p2", CallMessage.Role.Assistant, "They show", final = false),
        ))))
        assertEquals(listOf("Let me check the logs."), checked.map { it.str("text") })
        val rest = events(context.targetChanged(state(listOf(
            CallMessage("p1", CallMessage.Role.Assistant, "Let me check the logs."),
            CallMessage("u", CallMessage.Role.User, "and?"),
            CallMessage("p2", CallMessage.Role.Assistant, "They show a timeout."),
        ), working = false)))
        assertEquals(listOf("They show a timeout."), rest.map { it.str("text") })
    }

    @Test
    fun aLongMessageGoesCutAtFourKilobytesOnce() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        context.targetChanged(CallTargetState(backendTarget))
        val long = CallTargetState(backendTarget, listOf(CallMessage("r", CallMessage.Role.Assistant, "é".repeat(3000))))
        val cut = events(context.targetChanged(long)).single()
        assertEquals(4096, cut.str("text")!!.utf8Size())
        assertTrue(cut["truncated"]!!.jsonPrimitive.boolean)
        assertTrue(context.targetChanged(long).isEmpty)
    }

    @Test
    fun whatTheWaitLostIsPutRightInOneGo() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        context.focusChanged("b")
        context.focusChanged("a")
        context.targetChanged(CallTargetState(backendTarget, listOf(CallMessage("r", CallMessage.Role.Assistant, "Half", final = false)), working = true))
        context.targetChanged(CallTargetState(backendTarget, listOf(CallMessage("r", CallMessage.Role.Assistant, "Half way")),
            listOf(CallTurn("x", ended = "error", error = "Boom"))))
        // Say every one of those was lost: the directory as it is, the focus, then what was told.
        val update = context.resync()
        val fixed = events(update)
        assertEquals("directory", fixed[0].str("event"))
        assertEquals("Conversation directory:\nBackend [bot; ref=s1]\nDocs [task; ref=s2]", fixed[0].str("text"))
        assertEquals("focus", fixed[1].str("event"))
        assertTrue(fixed[1]["resync"]!!.jsonPrimitive.boolean)
        assertEquals(2, fixed[1]["focusRevision"]!!.jsonPrimitive.int)
        assertEquals("Backend", fixed[1].str("title"))
        assertEquals(listOf("session_error", "assistant_text"), fixed.drop(2).map { it.str("event") })
        assertEquals("Half way", fixed.last().str("text"))
        assertTrue(size(update) <= 32 * 1024)
        // What was there at first sight was never told, so none of it comes back.
        assertFalse(fixed.toString().contains("third answer"))
    }

    @Test
    fun aReplyBeingWrittenWhenFirstSeenGoesWholeOnceComplete() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        context.focusChanged("b")
        context.targetChanged(CallTargetState(docsTarget, listOf(CallMessage("w", CallMessage.Role.Assistant, "Halfway", final = false)), working = true))
        val next = events(context.targetChanged(CallTargetState(docsTarget, listOf(CallMessage("w", CallMessage.Role.Assistant, "Halfway there")))))
        assertEquals(listOf("Halfway there"), next.map { it.str("text") })
    }

    @Test
    fun anErrorThatStoppedATurnIsSaidOnceAndNothingElseIs() = runBlocking {
        val targets = backend()
        var state = CallTargetState(backendTarget, turns = listOf(CallTurn("old", ended = "error", error = "Old failure")))
        targets.states["a"] = state
        val context = CallContext(targets)
        context.initial()
        // The error that was there when the call began isn't news.
        assertTrue(context.targetChanged(state).isEmpty)
        // Working, needing the person, the person's messages and their delivery: none of it goes.
        state = state.copy(working = true, target = backendTarget.copy(status = CallTarget.Status.Running),
            messages = listOf(CallMessage("u", CallMessage.Role.User, "do it", delivery = CallMessage.Delivery.Queued)))
        assertTrue(context.targetChanged(state).isEmpty)
        state = state.copy(needsInput = true, target = backendTarget.copy(status = CallTarget.Status.NeedsInput),
            messages = listOf(CallMessage("u", CallMessage.Role.User, "do it", delivery = CallMessage.Delivery.Failed)))
        assertTrue(context.targetChanged(state).isEmpty)
        state = state.copy(working = false, needsInput = false, turns = state.turns + CallTurn("new", "do it", ended = "error", error = "The model refused"))
        val stopped = events(context.targetChanged(state))
        assertEquals(listOf("session_error"), stopped.map { it.str("event") })
        assertEquals("The model refused", stopped.single().str("reason"))
        assertEquals("Backend", stopped.single().str("title"))
        assertNull(stopped.single()["target"])
        assertTrue(context.targetChanged(state).isEmpty)
        // Stopped by the person is no error.
        assertTrue(context.targetChanged(state.copy(turns = state.turns + CallTurn("stop", "x", ended = "abort"))).isEmpty)
    }

    /** Words that ended their run say so (`finishedTurn`); words the agent went on from mid-run don't. */
    @Test
    fun wordsThatEndedTheirTurnSaySo() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        context.targetChanged(CallTargetState(backendTarget))
        val midRun = events(context.targetChanged(CallTargetState(backendTarget, listOf(
            CallMessage("p1", CallMessage.Role.Assistant, "Checking.", turn = "r9"),
            CallMessage("p2", CallMessage.Role.Assistant, "Still", final = false, turn = "r9"),
        ), working = true)))
        assertEquals(listOf("Checking."), midRun.map { it.str("text") })
        assertNull(midRun.single()["finishedTurn"])
        val ended = events(context.targetChanged(CallTargetState(backendTarget, listOf(
            CallMessage("p1", CallMessage.Role.Assistant, "Checking.", turn = "r9"),
            CallMessage("p2", CallMessage.Role.Assistant, "Still fine.", turn = "r9"),
        ), listOf(CallTurn("r9", reply = "Still fine.")))))
        assertEquals(listOf("Still fine."), ended.map { it.str("text") })
        assertTrue(ended.single()["finishedTurn"]!!.jsonPrimitive.boolean)
    }

    // Tools

    @Test
    fun sendMessageQueuesTheExactTextOnceAndHearsNothingMore() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val send = call("t1", "sendMessage", """{"targetRef":"s2","text":"  run the checks ","focusRevision":0}""")
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
        assertTrue(context.targetChanged(CallTargetState(docsTarget, listOf(CallMessage("r", CallMessage.Role.Assistant, "Done")))).isEmpty)
    }

    @Test
    fun sendMessageRefusesWhatItMustNotSend() = runBlocking {
        val targets = backend()
        targets.states["a"] = CallTargetState(backendTarget.copy(status = CallTarget.Status.NeedsInput), needsInput = true)
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
        assertEquals("uncertain", obj(first.text).str("status"))
        // The agent asking again, under a new tool call: the same message ID.
        targets.sendDelay = 0
        assertEquals("queued", obj(send("t2").text).str("status"))
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
        assertTrue(context.targetChanged(CallTargetState(backendTarget, listOf(CallMessage("n", CallMessage.Role.Assistant, "new")))).isEmpty)
        assertTrue(targets.sends.isEmpty())
    }

    @Test
    fun argumentsAreCheckedAgainstTheSchema() = runBlocking {
        val x = CallTarget("x", "X", CallTarget.Kind.Task, CallTarget.Status.Idle)
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

    // New work and the way back

    @Test
    fun newWorkOpensComposeAndItsFirstMessageGoesOnlyWhenSent() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        assertTrue(context.tool("newWork", """{"kind":"task","focusRevision":4}""").isError)
        assertTrue(context.tool("newWork", """{"kind":"board","focusRevision":0}""").isError)
        val opened = obj(context.tool("newWork", """{"kind":"bot","name":" Researcher ","focusRevision":0}""").text)
        assertEquals(true, opened["opened"]!!.jsonPrimitive.boolean)
        assertEquals(false, opened["sent"]!!.jsonPrimitive.boolean)
        assertEquals("bot", opened.str("kind"))
        assertEquals("Researcher", opened.str("title"))
        assertEquals(1, opened["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("Researcher"), targets.made.map { it.second })
        // Opening sends nothing.
        assertTrue(targets.sends.isEmpty())
        // Unlisted, it is reached by the reference newWork gave, and the screen saying so later says nothing.
        val ref = opened.str("targetRef")!!
        assertTrue(context.focusChanged("new-1").isEmpty)
        val sent = obj(context.tool("sendMessage", """{"targetRef":"$ref","text":"Find papers on caching","focusRevision":1}""").text)
        assertEquals("queued", sent.str("status"))
        assertEquals(listOf("new-1"), targets.sends.map { it.agentId })
        // Made, it is home's under the same reference.
        targets.setDirectory(listOf(backendTarget, docsTarget, CallTarget("new-1", "Researcher", CallTarget.Kind.Bot, CallTarget.Status.Running)))
        val listed = obj(context.tool("listSessions", """{"query":"research"}""").text)
        assertEquals(ref, listed["sessions"]!!.jsonArray[0].jsonObject.str("targetRef"))
    }

    @Test
    fun composeOpenedByHandIsReachedThroughTheFocus() = runBlocking {
        val targets = backend(focus = null)
        val context = CallContext(targets)
        context.initial()
        targets.newWork(CallTarget.Kind.Task, "")
        val focus = events(context.focusChanged("new-1")).last()
        assertEquals("New Task", focus.str("title"))
        val ref = focus.str("ref")!!
        assertFalse(context.tool("sendMessage", """{"targetRef":"$ref","text":"Fix the flaky test","focusRevision":1}""").isError)
    }

    @Test
    fun goBackPopsOneScreenAndGoHomeClearsThem() = runBlocking {
        val targets = backend(focus = null)
        targets.screens = 3
        val context = CallContext(targets)
        context.initial()
        assertTrue(context.tool("goBack", """{"focusRevision":2}""").isError)
        assertEquals(3, targets.screens)
        val back = obj(context.tool("goBack", """{"focusRevision":0}""").text)
        assertEquals(false, back["home"]!!.jsonPrimitive.boolean)
        assertEquals(JsonNull, back["title"])
        assertEquals(2, targets.screens)
        assertEquals(true, obj(context.tool("goHome", "{}").text)["home"]!!.jsonPrimitive.boolean)
        val nowhere = context.tool("goBack", """{"focusRevision":0}""")
        assertTrue(nowhere.isError)
        assertEquals("This is home; there is nothing to go back to.", obj(nowhere.text).str("reason"))
    }

    // Model, effort and times

    private val opus = CallModel("claude-opus-4-5", "Claude Opus 4.5", listOf("low", "medium", "high", "max"), "high")
    private val sonnet = CallModel("claude-sonnet-4-5", "Claude Sonnet 4.5", listOf("low", "medium", "high"), "medium")
    private val gpt = CallModel("gpt-5.2-codex", "GPT-5.2 Codex", listOf("low", "medium", "high", "xhigh"), "medium")

    /** Docs works on Opus at high effort, and the computer offers three models. */
    private fun modelled() = backend().also {
        it.states["b"] = CallTargetState(docsTarget, working = true, mode = CallMode(opus.id, opus.name, "high"), models = listOf(opus, sonnet, gpt))
    }

    @Test
    fun sendMessageSwitchesTheModelAndEffortTheComputerOffers() = runBlocking {
        val targets = modelled()
        val context = CallContext(targets)
        context.initial()
        // Working, it still takes the message, as the composer's send does.
        val both = obj(context.tool("sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0,"model":"sonnet","effort":"Low"}""").text)
        assertEquals("queued", both.str("status"))
        assertEquals("Claude Sonnet 4.5", both.str("model"))
        assertEquals("low", both.str("effort"))
        val effortOnly = obj(context.tool("sendMessage", """{"targetRef":"s2","text":"again","focusRevision":0,"effort":"max"}""").text)
        assertEquals("Claude Opus 4.5", effortOnly.str("model"))
        assertEquals("max", effortOnly.str("effort"))
        val modelOnly = obj(context.tool("sendMessage", """{"targetRef":"s2","text":"third","focusRevision":0,"model":"GPT 5.2 codex"}""").text)
        assertEquals("medium", modelOnly.str("effort"))
        assertNull(obj(context.tool("sendMessage", """{"targetRef":"s2","text":"fourth","focusRevision":0}""").text)["model"])
        assertEquals(
            listOf(CallModeChange("claude-sonnet-4-5", "low"), CallModeChange(effort = "max"), CallModeChange("gpt-5.2-codex"), null),
            targets.sends.map { it.change },
        )
    }

    @Test
    fun aModelOrEffortItDoesntOfferIsRefusedWithWhatItDoes() = runBlocking {
        val targets = modelled()
        val context = CallContext(targets)
        context.initial()
        val unknown = context.tool("sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0,"model":"gemini"}""")
        assertTrue(unknown.isError)
        val listed = obj(unknown.text)
        assertEquals(listOf("Claude Opus 4.5", "Claude Sonnet 4.5", "GPT-5.2 Codex"), listed["models"]!!.jsonArray.map { it.jsonObject.str("name") })
        assertTrue(listed.str("reason")!!.endsWith("Nothing was sent."))
        assertEquals(2, obj(context.tool("sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0,"model":"claude"}""").text)["models"]!!.jsonArray.size)
        val effort = obj(context.tool("sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0,"model":"sonnet","effort":"max"}""").text)
        assertEquals("Claude Sonnet 4.5 takes effort low, medium, high, not \"max\". Nothing was sent.", effort.str("reason"))
        assertTrue(context.tool("sendMessage", """{"targetRef":"s2","text":"go","focusRevision":0,"model":4}""").isError)
        // Without the computer's models, nothing changes and nothing goes.
        assertTrue(context.tool("sendMessage", """{"targetRef":"s1","text":"go","focusRevision":0,"effort":"high"}""").isError)
        assertTrue(targets.sends.isEmpty())
    }

    @Test
    fun readsSayWhenItLastHeardFromEachSideWhereItRunsAndOnWhat() = runBlocking {
        val now = 1_762_430_400_000L // 2025-11-06 12:00 UTC
        val app = CallTarget.Parent("p", "App", "project")
        val feature = CallTarget.Parent("w", "Feature", "workspace")
        val chat = CallTarget("c", "Feature chat", CallTarget.Kind.Conversation, CallTarget.Status.Idle, listOf(app, feature), activityAt = now - 300_000)
        val state = CallTargetState(
            chat,
            messages = listOf(CallMessage("u", CallMessage.Role.User, "ship it", now - 7_200_000), CallMessage("x", CallMessage.Role.Assistant, "Shipped")),
            turns = listOf(CallTurn("r", "ship it", "Shipped", endedAt = now - 300_000)),
            mode = CallMode(opus.id, opus.name, "high"), models = listOf(opus, sonnet),
        )
        val context = CallContext(FakeCallTargets(listOf(chat), mutableMapOf("c" to state), null), now = { now }, zone = java.time.ZoneId.of("Europe/Berlin"))
        context.initial()
        val read = obj(context.tool("getSessionContext", """{"targetRef":"s1"}""").text)
        assertEquals(obj("""{"ago":"2 hours ago","at":"2025-11-06T11:00:00+01:00"}"""), read["lastUserMessage"])
        assertEquals(obj("""{"ago":"5 minutes ago","at":"2025-11-06T12:55:00+01:00"}"""), read["lastAgentReply"])
        assertEquals("App / Feature", read.str("workspace"))
        assertEquals(obj("""{"id":"claude-opus-4-5","name":"Claude Opus 4.5","effort":"high"}"""), read["model"])
        assertEquals(listOf("low", "medium", "high", "max"), read["models"]!!.jsonArray[0].jsonObject.strings("efforts"))
        val listed = obj(context.tool("listSessions", "{}").text)
        val row = listed["sessions"]!!.jsonArray[0].jsonObject
        assertEquals(obj("""{"ago":"5 minutes ago","at":"2025-11-06T12:55:00+01:00"}"""), row["lastActivity"])
        assertEquals("App / Feature", row.str("workspace"))
        assertEquals("2025-11-06T13:00:00+01:00", listed.str("now"))
    }

    @Test
    fun agoIsSaidAsAPersonWould() {
        assertEquals("just now", CallContext.ago(-30))
        assertEquals("just now", CallContext.ago(59))
        assertEquals("a minute ago", CallContext.ago(60))
        assertEquals("5 minutes ago", CallContext.ago(5 * 60 + 20))
        assertEquals("an hour ago", CallContext.ago(90 * 60))
        assertEquals("5 hours ago", CallContext.ago(5 * 3600))
        assertEquals("yesterday", CallContext.ago(30 * 3600))
        assertEquals("4 days ago", CallContext.ago(4 * 86400))
    }

    /** The phone sends the prompt docs/agent-voice-call.md holds, the same words iOS sends. */
    @Test
    fun thePromptGoesFromThePhoneAsTheDocsHoldIt() {
        assertEquals(CallPrompt.SYSTEM, CallStart("{}").prompt)
        assertTrue(CallPrompt.SYSTEM.contains("{{initialConversationContext}}"))
        for (tool in CallTool.entries) assertTrue(tool.wire, CallPrompt.SYSTEM.contains(tool.wire))
        val root = generateSequence(File("").absoluteFile) { it.parentFile }.first { File(it, "docs/agent-voice-call.md").exists() }
        assertTrue(File(root, "docs/agent-voice-call.md").readText().contains("```text\n" + CallPrompt.SYSTEM + "\n```"))
        val swift = File(root, "packages/happy-ios/Sources/HappyCore/Call/CallTools.swift").readText()
        val ios = Regex("public static let system = \"\"\"\n(.*?)\n    \"\"\"", RegexOption.DOT_MATCHES_ALL).find(swift)!!.groupValues[1]
            .lines().joinToString("\n") { it.removePrefix("    ") }
        assertEquals(ios, CallPrompt.SYSTEM)
    }

    @Test
    fun theToolsAreDescribedForTheDashboard() {
        assertEquals(listOf("listSessions", "getSessionContext", "openSession", "sendMessage", "newWork", "goBack", "goHome"), CallTool.entries.map { it.wire })
        assertEquals(listOf("kind", "focusRevision"), CallTool.NewWork.parameters.strings("required"))
        assertEquals(listOf("task", "bot"), CallTool.NewWork.parameters["properties"]!!.jsonObject["kind"]!!.jsonObject.strings("enum"))
        assertEquals(listOf("focusRevision"), CallTool.GoBack.parameters.strings("required"))
        assertEquals(JsonArray(emptyList()), CallTool.GoHome.parameters["required"])
        assertEquals("string", CallTool.SendMessage.parameters["properties"]!!.jsonObject["model"]!!.jsonObject.str("type"))
        assertTrue(CallTool.SendMessage.summary.contains("only when the person has explicitly asked you to send"))
        assertEquals("integer", CallTool.OpenSession.parameters["properties"]!!.jsonObject["focusRevision"]!!.jsonObject.str("type"))
        assertEquals(listOf("targetRef", "text", "focusRevision"), CallTool.SendMessage.parameters.strings("required"))
        assertEquals(listOf("targetRef"), CallTool.GetSessionContext.parameters.strings("required"))
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
        val many = (0 until 120).map { CallTarget("x$it", if (it % 2 == 0) "Even $it" else "Odd $it", CallTarget.Kind.Task, CallTarget.Status.Idle) }
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

    // The directory: what the person sees

    @Test
    fun theDirectoryIsHomesConversationsNestedAsItShowsThem() = runBlocking {
        val list = CallTarget.from(CallTargetsTest.sidebar())
        val context = CallContext(FakeCallTargets(list, mutableMapOf(), null))
        val initial = obj(context.initial())
        assertEquals(
            """
            Conversation directory:
            Architect [bot; ref=s1]
            Release notes [task; ref=s2]
              Fix cache race [subtask; ref=s3]
                Check the lock [subtask; ref=s4]
            New Task [task; ref=s5]
            App [project]
              Root chat [conversation; ref=s6]
              Feature [workspace]
                Feature chat [conversation; ref=s7]
            """.trimIndent(),
            initial.str("directory"),
        )
        // No IDs of the computer's in what the agent reads.
        for (id in list.map { it.agentId }) assertFalse(id, initial.str("directory")!!.contains(id))
        val found = obj(context.tool("listSessions", """{"query":"lock"}""").text)["sessions"]!!.jsonArray.first().jsonObject
        assertEquals("s4", found.str("targetRef"))
        assertEquals("subtask", found.str("kind"))
        assertEquals(listOf("Release notes", "Fix cache race"), found.strings("parents"))
    }

    /** A subtask is reached like anything else listed, by its reference, whether or not the person ever opened it. */
    @Test
    fun everyListedConversationIsReachedSubtasksToo() = runBlocking {
        val targets = FakeCallTargets(listOf(releaseTarget, fixTarget), mutableMapOf(
            "t" to CallTargetState(releaseTarget),
            "c" to CallTargetState(fixTarget, turns = listOf(CallTurn("r", "sub ask", "sub answer"))),
        ), null)
        val context = CallContext(targets)
        context.initial()
        val read = obj(context.tool("getSessionContext", """{"targetRef":"s2"}""").text)
        assertEquals("Fix cache race", read.str("title"))
        assertEquals(listOf("Release notes"), read.strings("parents"))
        assertNull(read["targetRef"])
        assertNull(read["ref"])
        assertEquals("sub answer", read.turns().first().str("assistant"))
        assertTrue(obj(context.tool("openSession", """{"targetRef":"s2","focusRevision":0}""").text)["opened"]!!.jsonPrimitive.boolean)
        assertEquals("queued", obj(context.tool("sendMessage", """{"targetRef":"s2","text":"go on","focusRevision":1}""").text).str("status"))
        assertEquals(listOf("c"), targets.sends.map { it.agentId })
        // A reference no one gave reaches nothing.
        assertTrue(context.tool("getSessionContext", """{"targetRef":"s9"}""").isError)
    }

    /** New work settles for a second, then goes as the whole directory, by home's label whatever it is then; a status alone is no change. */
    @Test
    fun aNewEntryGoesOnceSettledAsTheWholeDirectory() = runBlocking {
        val targets = FakeCallTargets(listOf(releaseTarget), mutableMapOf(), null)
        val context = CallContext(targets)
        // Its watch answering ahead of the first snapshot: nothing due.
        assertFalse(context.directoryChanged(listOf(releaseTarget)))
        context.initial()
        assertFalse(context.directoryChanged(listOf(releaseTarget.copy(status = CallTarget.Status.Running))))
        // New, and nobody named it yet: due, and goes as the label is at the flush.
        val fresh = CallTarget("n", "New Task", CallTarget.Kind.Task, CallTarget.Status.Idle)
        assertTrue(context.directoryChanged(listOf(releaseTarget, fresh)))
        targets.setDirectory(listOf(releaseTarget, fresh))
        val flushed = events(context.flushDirectory())
        assertEquals(listOf("directory"), flushed.map { it.str("event") })
        assertEquals("Conversation directory:\nRelease notes [task; ref=s1]\nNew Task [task; ref=s2]", flushed.single().str("text"))
        // Told: the same again is nothing.
        assertFalse(context.directoryChanged(listOf(releaseTarget, fresh)))
        assertTrue(context.flushDirectory().isEmpty)
        // Named later: the same reference, the new title.
        val named = fresh.copy(title = "Ship 2.0")
        assertTrue(context.directoryChanged(listOf(releaseTarget, named)))
        targets.setDirectory(listOf(releaseTarget, named))
        assertEquals("Conversation directory:\nRelease notes [task; ref=s1]\nShip 2.0 [task; ref=s2]", events(context.flushDirectory()).first().str("text"))
    }

    /** The flush reads home as it is then: a name that came in the second goes, work that went away in it never does. */
    @Test
    fun theFlushTellsHomeAsItIsThen() = runBlocking {
        val targets = FakeCallTargets(listOf(releaseTarget), mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        val fresh = CallTarget("n", "New Task", CallTarget.Kind.Task, CallTarget.Status.Idle)
        context.directoryChanged(listOf(releaseTarget, fresh))
        val named = fresh.copy(title = "Fix the login redirect")
        targets.setDirectory(listOf(releaseTarget, named))
        val titled = events(context.flushDirectory())
        assertEquals("Conversation directory:\nRelease notes [task; ref=s1]\nFix the login redirect [task; ref=s2]", titled.first().str("text"))
        assertFalse(titled.toString().contains("New Task"))
        // Came and went within the second: nothing at all.
        val brief = CallTarget("b", "Brief", CallTarget.Kind.Task, CallTarget.Status.Idle)
        assertTrue(context.directoryChanged(listOf(releaseTarget, named, brief)))
        targets.setDirectory(listOf(releaseTarget, named))
        assertTrue(context.flushDirectory().isEmpty)
    }

    /** A snapshot within its size shows what it can and counts the rest; whatever is new or changed among the rest still goes, in as many `directory_entries` as it takes, each with what it sits under. */
    @Test
    fun whatTheSnapshotCantShowThatIsNewStillGoes() = runBlocking {
        val many = (0 until 150).map { CallTarget("x$it", "Task $it", CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val targets = FakeCallTargets(many, mutableMapOf(), null)
        val context = CallContext(targets)
        assertTrue(obj(context.initial()).str("directory")!!.endsWith("… and 50 more; listSessions finds them by title."))
        val late = late(40)
        targets.setDirectory(many + late)
        context.directoryChanged(many + late)
        val update = context.flushDirectory()
        val flushed = events(update)
        assertEquals("directory", flushed.first().str("event"))
        val pages = flushed.drop(1)
        assertTrue(pages.size > 1)
        var told = ""
        for (page in pages) {
            assertEquals("directory_entries", page.str("event"))
            val text = page.str("text")!!
            assertTrue(text.utf8Size() <= CallContext.Limits.ENTRIES_BYTES)
            // Each page says what its entries sit under.
            assertTrue(text, text.contains("\nTask 149 [task; ref="))
            told += text
        }
        for (index in 0 until 40) assertTrue("Late $index", told.contains("  Late $index "))
        // What was cut and hasn't changed isn't paged out.
        assertFalse(told.contains("Task 120 ["))
        assertTrue(size(update) <= 32 * 1024)
    }

    /** A reference reaches a conversation while home lists it; gone, it reaches nothing and isn't heard from; back, it reaches it again. */
    @Test
    fun aReferenceReachesWhatIsListedNow() = runBlocking {
        val targets = FakeCallTargets(listOf(backendTarget, docsTarget), mutableMapOf(
            "a" to CallTargetState(backendTarget), "b" to CallTargetState(docsTarget),
        ), "b")
        val context = CallContext(targets)
        context.initial()
        targets.setDirectory(listOf(backendTarget))
        context.directoryChanged(listOf(backendTarget))
        assertEquals("Conversation directory:\nBackend [bot; ref=s1]", events(context.flushDirectory()).first().str("text"))
        assertTrue(context.followed().isEmpty())
        for (name in listOf("getSessionContext", "openSession", "sendMessage")) {
            assertTrue(name, context.tool(name, """{"targetRef":"s2","text":"hi","focusRevision":0}""").isError)
        }
        targets.setDirectory(listOf(backendTarget, docsTarget))
        context.directoryChanged(listOf(backendTarget, docsTarget))
        assertEquals("Conversation directory:\nBackend [bot; ref=s1]\nDocs [task; ref=s2]", events(context.flushDirectory()).first().str("text"))
        assertFalse(context.tool("getSessionContext", """{"targetRef":"s2"}""").isError)
    }

    /** The agent has a conversation's line before any update about it: new work the person opens before the directory settles, a rename before its words. */
    @Test
    fun aConversationIsToldBeforeItsFocusOrItsWords() = runBlocking {
        val targets = FakeCallTargets(listOf(releaseTarget), mutableMapOf("t" to CallTargetState(releaseTarget)), null)
        val context = CallContext(targets)
        context.initial()
        targets.setDirectory(listOf(releaseTarget, fixTarget))
        assertTrue(context.directoryChanged(listOf(releaseTarget, fixTarget)))
        // Opened before the second is out.
        val focus = events(context.focusChanged("c"))
        assertEquals(listOf("directory_entries", "focus"), focus.map { it.str("event") })
        assertEquals("More of the conversation directory:\nRelease notes [task; ref=s1]\n  Fix cache race [subtask; ref=s2]", focus[0].str("text"))
        assertEquals("Fix cache race", focus[1].str("title"))
        assertEquals(listOf("Release notes"), focus[1].strings("parents"))
        // The flush still goes, whole.
        assertEquals(listOf("directory"), events(context.flushDirectory()).map { it.str("event") })
        // Renamed, then its words: the new name first.
        context.targetChanged(CallTargetState(fixTarget, working = true))
        val renamed = fixTarget.copy(title = "Fix the cache race")
        val words = events(context.targetChanged(CallTargetState(renamed, listOf(CallMessage("m", CallMessage.Role.Assistant, "Fixed.")))))
        assertEquals(listOf("directory_entries", "assistant_text"), words.map { it.str("event") })
        assertTrue(words[0].str("text")!!.endsWith("  Fix the cache race [subtask; ref=s2]"))
        assertEquals("Fix the cache race", words[1].str("title"))
        // Told once: its next words come alone.
        val next = events(context.targetChanged(CallTargetState(renamed, listOf(
            CallMessage("m", CallMessage.Role.Assistant, "Fixed."), CallMessage("m2", CallMessage.Role.Assistant, "And tested."),
        ))))
        assertEquals(listOf("assistant_text"), next.map { it.str("event") })
    }

    /** Work deleted while the directory settles: a reply that comes late from it says nothing, under its old name or any, and no line of it goes. */
    @Test
    fun aLateReplyFromWorkThatWentAwaySaysNothing() = runBlocking {
        val targets = backend(focus = "b")
        val context = CallContext(targets)
        context.initial()
        context.targetChanged(CallTargetState(docsTarget, working = true))
        targets.setDirectory(listOf(backendTarget))
        assertTrue(context.directoryChanged(listOf(backendTarget)))
        val late = context.targetChanged(CallTargetState(docsTarget, listOf(CallMessage("w", CallMessage.Role.Assistant, "Done.")),
            listOf(CallTurn("x", ended = "error", error = "Boom"))))
        assertTrue(late.isEmpty)
        val flushed = events(context.flushDirectory())
        assertEquals(listOf("directory"), flushed.map { it.str("event") })
        assertFalse(flushed.toString().contains("Docs"))
        assertTrue(context.followed().isEmpty())
    }

    /** A conversation under more than a page can show: still told, with what it sits under on one line cut to fit, and the ones after it too. */
    @Test
    fun anEntryTooDeepForAPageStillGoes() = runBlocking {
        val chain = (0 until 80).map { CallTarget.Parent("session:p$it", "Parent $it " + "y".repeat(180), "subtask", "p$it") }
        val deep = CallTarget("deep", "Deep one", CallTarget.Kind.Subtask, CallTarget.Status.Idle, chain)
        val after = CallTarget("after", "After it", CallTarget.Kind.Task, CallTarget.Status.Idle)
        val targets = FakeCallTargets(listOf(releaseTarget), mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        targets.setDirectory(listOf(releaseTarget, deep, after))
        context.directoryChanged(listOf(releaseTarget, deep, after))
        val flushed = events(context.flushDirectory())
        val told = flushed.mapNotNull { it.str("text") }.joinToString("\n")
        assertTrue(told, told.contains("Deep one [subtask; ref="))
        assertTrue(told, told.contains("(under Parent 0 "))
        assertTrue(told, told.contains("After it [task; ref="))
        for (event in flushed.filter { it.str("event") == "directory_entries" }) {
            assertTrue(event.str("text")!!.utf8Size() <= CallContext.Limits.ENTRIES_BYTES)
        }
        assertFalse(context.owesDirectory())
    }

    /** Title and what it sits under name it; a reference only when that leaves it unclear, or it has no name of its own yet. */
    @Test
    fun anUpdateHasAReferenceOnlyWhenItsNameIsUnclear() = runBlocking {
        val parent = CallTarget.Parent("task:t", "Release notes", "task", "t")
        val one = CallTarget("c1", "Fix", CallTarget.Kind.Subtask, CallTarget.Status.Idle, listOf(parent))
        val two = CallTarget("c2", "Fix", CallTarget.Kind.Subtask, CallTarget.Status.Idle, listOf(parent))
        val elsewhere = CallTarget("c3", "Fix", CallTarget.Kind.Task, CallTarget.Status.Idle)
        val unnamed = CallTarget("u", "New Task", CallTarget.Kind.Task, CallTarget.Status.Idle)
        val context = CallContext(FakeCallTargets(listOf(releaseTarget, one, two, elsewhere, unnamed), mutableMapOf(), null))
        context.initial()
        suspend fun focus(id: String) = events(context.focusChanged(id)).last()
        val first = focus("c1")
        assertEquals("s2", first.str("ref"))
        assertEquals(listOf("Release notes"), first.strings("parents"))
        val other = focus("c3")
        assertNull(other["ref"])
        assertEquals(emptyList<String>(), other.strings("parents"))
        assertEquals("s5", focus("u").str("ref"))
        assertNull(focus("t")["ref"])
    }

    /** Sizes are counted as the JSON that carries them: names full of quotes, backslashes, slashes and control characters keep every update within its budget. */
    @Test
    fun budgetsHoldInEncodedJson() = runBlocking {
        val nasty = "\"q\" \\b\\ /s/ \u0001\u0002\u0007\u001B"
        val many = (0 until 400).map { CallTarget("x$it", "$it " + nasty.repeat(8), CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val visits = many.take(4)
        val targets = FakeCallTargets(many.take(200), visits.associateTo(HashMap()) { it.agentId to CallTargetState(it) }, null)
        val context = CallContext(targets)
        context.initial()
        for (target in visits) {
            context.focusChanged(target.agentId)
            context.targetChanged(CallTargetState(target))
            val words = (0 until 6).map { CallMessage("${target.agentId}m$it", CallMessage.Role.Assistant, nasty.repeat(200)) }
            context.targetChanged(CallTargetState(target, words))
        }
        targets.setDirectory(many)
        context.directoryChanged(many)
        val flush = context.flushDirectory()
        assertTrue(size(flush) <= CallSession.PENDING_BYTES)
        for (line in flush.context) {
            val limit = if (obj(line).str("event") == "directory") CallContext.Limits.DIRECTORY_BYTES else CallContext.Limits.ENTRIES_BYTES
            assertTrue(line.utf8Size() <= limit + 64)
        }
        assertTrue(size(context.resync()) <= CallSession.PENDING_BYTES)
        while (context.owesDirectory()) assertTrue(size(context.moreDirectory()) <= CallSession.PENDING_BYTES / 2)
        // Titles from home carry no control characters at all.
        assertEquals("a b c\u200Dd", CallTarget.clean("a\u0001b\nc\u200Dd"))
    }

    companion object {
        /** [count] new subtasks under "Task 149", each a long line. */
        fun late(count: Int): List<CallTarget> {
            val parent = CallTarget.Parent("task:x149", "Task 149", "task", "x149")
            return (0 until count).map { CallTarget("n$it", "Late $it " + "z".repeat(150), CallTarget.Kind.Subtask, CallTarget.Status.Idle, listOf(parent)) }
        }
    }
}

/** Conversations as a call reaches them, in memory. */
class FakeCallTargets(
    @Volatile private var entries: List<CallTarget>,
    val states: MutableMap<String, CallTargetState>,
    private val focus: String?,
) : CallTargets {
    data class Sent(val agentId: String, val text: String, val id: String, val change: CallModeChange? = null)

    private val lock = Mutex()
    @Volatile var sendDelay = 0L
    var onRead: (suspend () -> Unit)? = null
    val sends = java.util.Collections.synchronizedList(ArrayList<Sent>())
    val follows = java.util.Collections.synchronizedList(ArrayList<Pair<String, Boolean>>())
    val opened = java.util.Collections.synchronizedList(ArrayList<String>())

    /** Home changed: what the next read of the directory gives. */
    fun setDirectory(entries: List<CallTarget>) { this.entries = entries }

    override suspend fun directory() = entries
    override suspend fun state(agentId: String): CallTargetState? {
        onRead?.let { onRead = null; it() }
        return lock.withLock { states[agentId] }
    }
    override suspend fun focused() = focus
    override suspend fun open(agentId: String): Boolean { opened += agentId; return states[agentId] != null }
    override suspend fun send(agentId: String, text: String, id: String, change: CallModeChange?): CallSendOutcome {
        if (sendDelay > 0) try { delay(sendDelay) } catch (e: kotlinx.coroutines.CancellationException) { sends += Sent(agentId, text, id, change); throw e }
        sends += Sent(agentId, text, id, change)
        return CallSendOutcome.Queued
    }
    override suspend fun follow(agentId: String, following: Boolean) { follows += agentId to following }

    /** New work opened, as the screen would put it: unlisted until its first message. */
    val made = java.util.Collections.synchronizedList(ArrayList<Pair<CallTarget.Kind, String>>())
    private val unlistedWork = java.util.concurrent.ConcurrentHashMap<String, CallTarget>()
    /** Screens over home, the top last: what `back` and `home` take away. */
    @Volatile var screens = 0
    override suspend fun newWork(kind: CallTarget.Kind, name: String): CallTarget {
        made += kind to name
        val draft = CallTarget("new-${made.size}", name.ifEmpty { if (kind == CallTarget.Kind.Bot) "New Bot" else "New Task" }, kind, CallTarget.Status.Idle)
        unlistedWork[draft.agentId] = draft
        lock.withLock { states[draft.agentId] = CallTargetState(draft) }
        screens++
        return draft
    }
    override suspend fun unlisted(agentId: String): CallTarget? = unlistedWork[agentId]
    override suspend fun back(): CallScreenMove {
        if (screens == 0) return CallScreenMove.Refused("This is home; there is nothing to go back to.")
        screens--
        return CallScreenMove.Moved(screens == 0)
    }
    override suspend fun home(): CallScreenMove {
        screens = 0
        return CallScreenMove.Moved(true)
    }
}
