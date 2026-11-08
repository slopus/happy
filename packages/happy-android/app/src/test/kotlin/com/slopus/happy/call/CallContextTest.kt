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
    /** A thousand words of the agent's, two pages: about 6 KB. */
    private val thousandWords = List(40) { "The build in `packages/happy-ios` failed on step three: the cache key changed after the lockfile update, so the agent rebuilt it and reran the tests." }.joinToString(" ")
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
        val utc = java.time.ZoneOffset.UTC
        val context = CallContext(backend(), now = { 1_700_000_000_000 }, zone = utc)
        val text = context.initial()
        // Plain lines, as Happy Agent's own tools write them: the focus, its turns (four finished and the message
        // waiting: five), the directory once.
        assertEquals(
            """
            |Now: 2023-11-14T22:13:00Z (the person's local time)
            |focusRevision: 0
            |
            |On screen: Backend — bot, ref s1
            |Working: no. Needs the person: no.
            |Last turns, oldest first:
            |1. The person: first ask
            |   Agent: first answer
            |2. The person: second ask
            |   Agent: second answer
            |3. The person: steer
            |   Ended: steering
            |4. The person: third ask
            |   Agent: third answer
            |Waiting for an answer, from the person:
            |   still waiting
            |
            |Conversations in the app, in the sidebar's order:
            |- Backend — bot, ref s1
            |- Docs — task, ref s2
            |
            """.trimMargin() + "\n" + CallContext.NEW_WORK_TEXT + """
            |
            |
            |Destinations (navigate's to):
            |- happy://home — the home list
            |- happy://back — one screen back; refused at home
            |- happy://conversation/<ref> — that conversation on screen, such as happy://conversation/s1
            |- happy://call/restart — end this call and start a new one at once, this conversation carried over; only when the person agrees
            """.trimMargin(),
            text,
        )
        assertFalse("no JSON", text.contains("{"))
        assertEquals(listOf("a"), context.followed())
        // Told once: the screen, the person going back to it, says nothing of its ref again.
        context.focusChanged("b")
        assertNull(events(context.focusChanged("a")).first()["ref"])
    }

    @Test
    fun theSnapshotKeepsItsBudgets() = runBlocking {
        val long = "é".repeat(5000)
        val turns = (0 until 10).map { CallTurn("r$it", long, long) }
        val many = (0 until 300).map { CallTarget("x$it", "n".repeat(200), CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val state = CallTargetState(backendTarget, turns = turns, unanswered = CallMessage("p", CallMessage.Role.User, long))
        val text = CallContext(FakeCallTargets(listOf(backendTarget) + many, mutableMapOf("a" to state), "a")).initial()
        assertTrue(text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        val parts = text.split("\n\n")
        val directory = parts.first { it.startsWith("Conversations in the app") }
        assertTrue(directory, directory.endsWith("more; listConversations finds them by title."))
        assertTrue(directory.utf8Size() <= CallContext.Limits.DIRECTORY_BYTES)
        val screen = parts.first { it.startsWith("On screen:") }
        assertTrue(screen.lines().count { it.firstOrNull()?.isDigit() == true } <= CallContext.Limits.TURNS)
        assertTrue(screen.contains(" … (cut, 1 more word)"))
        assertTrue(screen.contains("Older turns aren't shown."))
        assertTrue(text.endsWith(CallContext.NEW_WORK_TEXT + "\n\n" + CallContext.DESTINATIONS_TEXT))
    }

    /** The models the message tool's description sends the agent to: the conversation on screen's, as a read lists them. */
    @Test
    fun theFirstContextListsTheModelsTheScreensConversationCanSwitchTo() = runBlocking {
        val targets = backend()
        targets.states["a"] = CallTargetState(backendTarget, mode = CallMode(opus.id, opus.name, "high"), models = listOf(opus, CallModel("plain", "Plain", emptyList(), "")))
        val text = CallContext(targets).initial()
        assertTrue(text, text.contains(
            """
            Model: Claude Opus 4.5, effort high
            Models it can switch to:
            - Claude Opus 4.5 — id claude-opus-4-5, efforts low, medium, high, max
            - Plain — id plain
            """.trimIndent(),
        ))
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
        val read = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
        assertEquals(listOf("first answer", "second answer", null, "third answer"), read.turns().map { it.str("assistant") })
        assertEquals("still waiting", read["pendingUserMessage"]!!.jsonObject.str("text"))
        assertFalse(read["working"]!!.jsonPrimitive.boolean)
        assertFalse(read["needsInput"]!!.jsonPrimitive.boolean)
        context.tool("listConversations", "{}")
        assertTrue(context.followed().isEmpty())
        // Not visited, so its new words say nothing.
        assertTrue(context.targetChanged(CallTargetState(backendTarget, listOf(CallMessage("n", CallMessage.Role.Assistant, "new")))).isEmpty)
    }

    /**
     * Five in all: five finished turns with nothing waiting, four with a
     * message waiting; an answer with no message of the person's is half a
     * pair; a read within [CallContext.Limits.READ_BYTES] on the wire, the
     * oldest first to go and the newest whole.
     */
    @Test
    fun fiveTurnsInAllAndTheBudgetHolds() = runBlocking {
        val turns = (1..7).map { CallTurn("r$it", "ask $it", "answer $it") } + CallTurn("r8", reply = "done on its own")
        val targets = FakeCallTargets(listOf(backendTarget), mutableMapOf("a" to CallTargetState(backendTarget, turns = turns)), null)
        val context = CallContext(targets)
        context.initial()
        var read = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
        assertEquals(listOf("answer 4", "answer 5", "answer 6", "answer 7", "done on its own"), read.turns().map { it.str("assistant") })
        assertNull(read.turns().last()["user"])
        assertTrue(read["olderTurns"]!!.jsonPrimitive.boolean)
        targets.states["a"] = CallTargetState(backendTarget, turns = turns, unanswered = CallMessage("p", CallMessage.Role.User, "and now?"))
        read = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
        assertEquals(4, read.turns().size)
        assertEquals("and now?", read["pendingUserMessage"]!!.jsonObject.str("text"))
        // Each reply within its own limit, but escaped six bytes a character on the wire.
        val heavy = "<<<< ".repeat(1600)
        targets.states["a"] = CallTargetState(backendTarget, turns = (0 until 6).map { CallTurn("l$it", "ask $it", heavy) })
        val big = context.tool("readConversation", """{"ref":"s1","words":5000}""")
        assertTrue(CallContext.escapedSize(big.text) <= CallContext.Limits.READ_BYTES)
        val shown = obj(big.text).turns()
        assertEquals(listOf("ask 5"), shown.map { it.str("user") })
        assertEquals(heavy, shown.single().str("assistant"))
        assertNull(shown.single()["cut"])
    }

    /** About a thousand words of the agent's come back whole: in a read asking for a thousand words a message, five turns of them, and told as they come. */
    @Test
    fun aThousandWordReplyComesBackWhole() = runBlocking {
        assertEquals(1000, thousandWords.split(" ").size)
        val turns = (1..5).map { CallTurn("r$it", "ask $it", thousandWords) }
        val context = CallContext(FakeCallTargets(listOf(backendTarget), mutableMapOf("a" to CallTargetState(backendTarget, turns = turns)), null))
        context.initial()
        val read = context.tool("readConversation", """{"ref":"s1","words":1000}""")
        assertTrue(CallContext.escapedSize(read.text) <= CallContext.Limits.READ_BYTES)
        val shown = obj(read.text).turns()
        assertEquals(List(5) { thousandWords }, shown.map { it.str("assistant") })
        assertTrue(shown.all { it["cut"] == null })
        val live = CallContext(backend())
        live.initial()
        live.targetChanged(CallTargetState(backendTarget))
        val told = events(live.targetChanged(CallTargetState(backendTarget, listOf(CallMessage("r", CallMessage.Role.Assistant, thousandWords))))).single()
        assertEquals(thousandWords, told.str("text"))
        assertNull(told["truncated"])
    }

    /** Five turns of a thousand words fit the first context whole; five replies at their limit don't, and the older give way, the newest there whole. */
    @Test
    fun theFirstContextKeepsTheNewestTurnWhole() = runBlocking {
        suspend fun initial(reply: String): String {
            val turns = (1..5).map { CallTurn("r$it", "ask $it", "Turn $it. $reply") }
            return CallContext(FakeCallTargets(listOf(backendTarget), mutableMapOf("a" to CallTargetState(backendTarget, turns = turns)), "a")).initial()
        }
        val fits = initial(thousandWords)
        assertTrue(fits.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        for (turn in 1..5) assertTrue(fits.contains("Agent: Turn $turn. $thousandWords\n"))
        assertFalse(fits.contains("(cut,"))
        val most = "$thousandWords $thousandWords".split(" ").take(1300).joinToString(" ")
        assertTrue(most.utf8Size() + 8 <= CallContext.Limits.REPLY_BYTES)
        val text = initial(most)
        assertTrue(text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        assertTrue(text.contains("Agent: Turn 5. $most\n"))
        assertFalse(text.contains("Turn 1. "))
        assertFalse(text.contains("(cut,"))
        assertTrue(text.contains("Older turns aren't shown."))
    }

    @Test
    fun clippingCutsAfterAWordAndCountsTheRest() {
        assertEquals("short", CallContext.clipped("short", 64))
        assertEquals("word word word word word word … (cut, 94 more words)", CallContext.clipped("word ".repeat(100), 64))
        assertEquals("é".repeat(16) + " … (cut, 1 more word)", CallContext.clipped("é".repeat(100), 64))
    }

    @Test
    fun aFailedTurnIsReadWithItsReason() = runBlocking {
        val turns = listOf(CallTurn("r1", "ask", "fine"), CallTurn("r2", "again", ended = "error", error = "Rate limited"))
        val context = CallContext(FakeCallTargets(listOf(backendTarget), mutableMapOf("a" to CallTargetState(backendTarget, turns = turns)), null))
        context.initial()
        val read = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
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
        assertFalse(context.tool("navigate", """{"to":"happy://conversation/s2","focusRevision":0}""").isError)
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
        assertNull(focus["ref"])
        assertNull(focus["turns"])
        assertFalse(focus.toString().contains("answer"))
    }

    /** "queued" is no receipt: a send that fails afterwards is said by nothing on its own, and read where the agent looks for it. */
    @Test
    fun aSendThatFailsLaterIsReadNotAnnounced() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        assertEquals("queued", obj(context.tool("message", """{"to":"s1","text":"run it"}""").text).str("status"))
        val failed = CallMessage("run", CallMessage.Role.User, "run it", delivery = CallMessage.Delivery.Failed)
        val state = targets.states.getValue("a").let { it.copy(messages = it.messages + failed, unanswered = failed) }
        targets.states["a"] = state
        assertTrue(context.targetChanged(state).isEmpty)
        val pending = obj(context.tool("readConversation", """{"ref":"s1"}""").text)["pendingUserMessage"]!!.jsonObject
        assertEquals("run it", pending.str("text"))
        assertEquals("failed", pending.str("delivery"))
    }

    @Test
    fun openingGivesTheRevisionTheNextStepTakes() = runBlocking {
        val context = CallContext(backend(focus = null))
        context.initial()
        val opened = obj(context.tool("navigate", """{"to":"happy://conversation/s2","focusRevision":0}""").text)
        assertEquals(1, opened["focusRevision"]!!.jsonPrimitive.int)
        // The screen saying the same afterwards tells the agent nothing new.
        assertTrue(context.focusChanged("b").isEmpty)
        // Chained on what the open gave, the next open goes.
        val next = context.tool("navigate", """{"to":"happy://conversation/s1","focusRevision":1}""")
        assertFalse(next.isError)
        assertEquals(2, obj(next.text)["focusRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("a", "b"), context.followed())
        val send = obj(context.tool("message", """{"to":"s2","text":"go"}""").text)
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
    fun aLongMessageGoesCutAfterAWordOnce() = runBlocking {
        val context = CallContext(backend())
        context.initial()
        context.targetChanged(CallTargetState(backendTarget))
        val words = (1..2000).map { "w$it" }
        val long = CallTargetState(backendTarget, listOf(CallMessage("r", CallMessage.Role.Assistant, words.joinToString(" "))))
        val cut = events(context.targetChanged(long)).single()
        val text = cut.str("text")!!
        assertTrue(text.utf8Size() <= CallContext.Limits.REPLY_BYTES)
        val kept = text.substringBefore(" … (cut, ").split(" ")
        assertEquals(words.take(kept.size), kept)
        assertTrue(text, text.endsWith(" … (cut, ${words.size - kept.size} more words)"))
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
        // Say every one of those was lost: the focus with its reference, then what was told; the directory never again.
        val update = context.resync()
        val fixed = events(update)
        assertEquals("focus", fixed[0].str("event"))
        assertTrue(fixed[0]["resync"]!!.jsonPrimitive.boolean)
        assertEquals(2, fixed[0]["focusRevision"]!!.jsonPrimitive.int)
        assertEquals("Backend", fixed[0].str("title"))
        assertEquals("s1", fixed[0].str("ref"))
        assertEquals(listOf("session_error", "assistant_text"), fixed.drop(1).map { it.str("event") })
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
    fun messageQueuesTheExactTextOnceAndHearsItsReply() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val send = call("t1", "message", """{"to":"s2","text":"  run the checks "}""")
        val first = context.handle(send)
        assertFalse(first.isError)
        assertEquals("queued", obj(first.text).str("status"))
        // The provider asking again under the same ID gets the same answer.
        assertEquals(first, context.handle(send))
        assertEquals(listOf("  run the checks "), targets.sends.map { it.text })
        assertEquals(listOf("b"), targets.sends.map { it.agentId })
        // Sending doesn't open it, but the call hears from it from then on.
        assertEquals(listOf("b", "a"), context.followed())
        assertTrue(targets.opened.isEmpty())
        // What is there when it is first seen is had; its reply, once complete, goes.
        assertTrue(context.targetChanged(CallTargetState(docsTarget, working = true)).isEmpty)
        val reply = events(context.targetChanged(CallTargetState(docsTarget, listOf(CallMessage("r", CallMessage.Role.Assistant, "Done")))))
        assertEquals(listOf("Done"), reply.map { it.str("text") })
    }

    /** Messaged conversations count among the four, but the one on screen never drops out while it is in front. */
    @Test
    fun messagedConversationsAreAmongTheFourButNeverPushOutTheScreen() = runBlocking {
        val list = (1..5).map { CallTarget("v$it", "V$it", CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val targets = FakeCallTargets(list, list.associateTo(HashMap()) { it.agentId to CallTargetState(it) }, "v1")
        val context = CallContext(targets)
        context.initial()
        context.focusChanged("v1")
        for (ref in listOf("s2", "s3", "s4", "s5")) context.tool("message", """{"to":"$ref","text":"go"}""")
        assertEquals(listOf("v5", "v4", "v3", "v1"), context.followed())
    }

    // Reading current state

    /** Each [CallReading] the context hands on, in order. */
    private suspend fun readings(context: CallContext): MutableList<CallReading> {
        val all = java.util.Collections.synchronizedList(ArrayList<CallReading>())
        context.onReading { all += it }
        return all
    }

    private suspend fun waitFor(condition: () -> Boolean) = withTimeout(5_000) { while (!condition()) delay(5) }

    private fun cue(reading: CallReading?): JsonObject = obj((reading as CallReading.Update).cue.text)
    private fun line(reading: CallReading?): JsonObject = obj((reading as CallReading.Context).line)

    /** Backend as this phone kept it, not current: last read 29 minutes ago. */
    private fun kept(targets: FakeCallTargets) {
        targets.states["a"] = targets.states["a"]!!.copy(fresh = false, checkedAt = 1_700_000_000_000 - 29 * 60_000)
    }

    /** A conversation that is current answers at once, as it is: no marker, no refresh, no wait, and nothing follows. */
    @Test
    fun aCurrentConversationIsReadAtOnce() = runBlocking {
        val targets = backend(focus = null)
        targets.refresh["a"] = FakeCallTargets.Refresh.After(5_000)
        val context = CallContext(targets)
        val all = readings(context)
        context.initial()
        val started = System.nanoTime()
        val read = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 200)
        assertNull(read["refreshing"])
        assertNull(read["checked"])
        assertEquals(4, read.turns().size)
        delay(100)
        assertTrue(all.isEmpty())
        assertTrue(targets.refreshes.isEmpty())
    }

    /** One that isn't current answers at once too, with what the phone has, marked `refreshing` with when it was last current; the refresh goes on behind it. */
    @Test
    fun aConversationNotCurrentIsReadAtOnceMarkedRefreshing() = runBlocking {
        val targets = backend(focus = null)
        kept(targets)
        targets.refresh["a"] = FakeCallTargets.Refresh.After(5_000)
        val context = CallContext(targets, now = { 1_700_000_000_000 })
        val all = readings(context)
        context.initial()
        val started = System.nanoTime()
        val result = context.tool("readConversation", """{"ref":"s1"}""")
        assertTrue((System.nanoTime() - started) / 1_000_000 < 200)
        assertFalse(result.isError)
        val read = obj(result.text)
        assertEquals(true, read["refreshing"]!!.jsonPrimitive.boolean)
        assertEquals("29 minutes ago", read["checked"]!!.jsonObject.str("ago"))
        assertEquals("Backend", read.str("title"))
        assertEquals(4, read.turns().size)
        assertNull(read["status"])
        waitFor { all.size == 1 }
        assertEquals(listOf<CallReading>(CallReading.Refreshing), all.toList())
        context.close()
    }

    /** The refresh finds more: one `conversation_update` cue, with the turns new or changed since the read (the waiting message answered), as a read gives them. */
    @Test
    fun whatTheRefreshFindsNewComesAsOneCue() = runBlocking {
        val targets = backend(focus = null)
        kept(targets)
        targets.refresh["a"] = FakeCallTargets.Refresh.After(150)
        val context = CallContext(targets, refreshMillis = 2_000)
        val all = readings(context)
        context.initial()
        context.tool("readConversation", """{"ref":"s1"}""")
        // Meanwhile on the computer: the waiting message is answered.
        val kept = targets.states["a"]!!
        targets.states["a"] = kept.copy(turns = kept.turns + CallTurn("r5", "still waiting", "Done: the cache is fixed."), unanswered = null)
        waitFor { all.size == 2 }
        delay(50)
        assertEquals(2, all.size)
        val cue = cue(all.last())
        assertEquals("conversation_update", cue.str("event"))
        assertEquals("s1", cue.str("ref"))
        assertEquals("Backend", cue.str("title"))
        assertEquals(listOf("Done: the cache is fixed."), cue.turns().map { it.str("assistant") })
        assertEquals("t:r5", cue.turns().first().str("ref"))
        assertNull(cue["pendingUserMessage"])
        assertNull(cue["refreshing"])
        assertEquals("t:r4", cue.str("continueFrom"))
        assertEquals(false, cue["working"]!!.jsonPrimitive.boolean)
    }

    /** The refresh finds nothing new: no cue, only a line of context. */
    @Test
    fun aRefreshThatFindsNothingNewSaysSoSilently() = runBlocking {
        val targets = backend(focus = null)
        kept(targets)
        targets.refresh["a"] = FakeCallTargets.Refresh.After(100)
        val context = CallContext(targets, refreshMillis = 2_000)
        val all = readings(context)
        context.initial()
        context.tool("readConversation", """{"ref":"s1"}""")
        waitFor { all.size == 2 }
        val line = line(all.last())
        assertEquals("conversation_current", line.str("event"))
        assertEquals("s1", line.str("ref"))
        assertNull(line["turns"])
    }

    /** One the computer doesn't make current in time: no cue, a line of context that it may be out of date, with when it was last current. */
    @Test
    fun aRefreshThatTimesOutIsASilentUnconfirmedLine() = runBlocking {
        val targets = backend(focus = null)
        kept(targets)
        targets.refresh["a"] = FakeCallTargets.Refresh.Never
        val context = CallContext(targets, now = { 1_700_000_000_000 }, refreshMillis = 150)
        val all = readings(context)
        context.initial()
        context.tool("readConversation", """{"ref":"s1"}""")
        waitFor { all.size == 2 }
        val line = line(all.last())
        assertEquals("conversation_unconfirmed", line.str("event"))
        assertEquals("29 minutes ago", line["checked"]!!.jsonObject.str("ago"))
    }

    /** Asked again while the first refresh is on its way, the read joins it: both answered at once, one refresh, one update. */
    @Test
    fun readsOfOneConversationOnTheirWayAreOne() = runBlocking {
        val targets = backend(focus = null)
        kept(targets)
        targets.refresh["a"] = FakeCallTargets.Refresh.After(200)
        val context = CallContext(targets, refreshMillis = 2_000)
        val all = readings(context)
        context.initial()
        assertEquals(true, obj(context.tool("readConversation", """{"ref":"s1"}""").text)["refreshing"]!!.jsonPrimitive.boolean)
        assertEquals(true, obj(context.tool("readConversation", """{"ref":"s1","from":1}""").text)["refreshing"]!!.jsonPrimitive.boolean)
        targets.states["a"] = targets.states["a"]!!.copy(working = true)
        waitFor { all.any { it is CallReading.Update } }
        delay(100)
        assertEquals(1, all.count { it is CallReading.Update })
        assertEquals(2, all.count { it == CallReading.Refreshing })
        val cue = cue(all.last())
        assertEquals(true, cue["working"]!!.jsonPrimitive.boolean)
        assertEquals(0, cue.turns().size)
        assertEquals(listOf("a"), targets.refreshes.toList())
    }

    /** One the phone keeps nothing of yet answers at once all the same, as the directory has it with no turns, marked `refreshing`; its turns come with the update, the newest five. */
    @Test
    fun aConversationThePhoneHasNothingOfAnswersAtOnceAndItsTurnsFollow() = runBlocking {
        val targets = backend(focus = null)
        targets.stateDelay = 3_000
        targets.refresh["a"] = FakeCallTargets.Refresh.After(800)
        val context = CallContext(targets, refreshMillis = 2_000)
        val all = readings(context)
        context.initial()
        targets.stateDelay = 3_000
        val started = System.nanoTime()
        val read = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 800)
        assertEquals(true, read["refreshing"]!!.jsonPrimitive.boolean)
        assertEquals("Backend", read.str("title"))
        assertEquals(0, read.turns().size)
        targets.stateDelay = 0
        waitFor { all.size == 2 }
        val cue = cue(all.last())
        assertEquals(4, cue.turns().size)
        assertEquals("still waiting", cue["pendingUserMessage"]!!.jsonObject.str("text"))
        context.close()
    }

    /** What a refresh finds after the call ended is told to nobody. */
    @Test
    fun aRefreshThatEndsAfterTheCallSaysNothing() = runBlocking {
        val targets = backend(focus = null)
        kept(targets)
        targets.refresh["a"] = FakeCallTargets.Refresh.After(300)
        val context = CallContext(targets, refreshMillis = 2_000)
        val all = readings(context)
        context.initial()
        context.tool("readConversation", """{"ref":"s1"}""")
        context.close()
        delay(600)
        assertEquals(listOf<CallReading>(CallReading.Refreshing), all.toList())
    }

    @Test
    fun messageRefusesWhatItMustNotSend() = runBlocking {
        val targets = backend()
        targets.states["a"] = CallTargetState(backendTarget.copy(status = CallTarget.Status.NeedsInput), needsInput = true)
        val context = CallContext(targets)
        context.initial()
        val refusals = listOf(
            """{"to":"s1","text":"yes"}""",
            """{"text":"yes"}""",
            """{"to":"s9","text":"go"}""",
            """{"to":"Docs","text":"go"}""",
            """{"to":2,"text":"go"}""",
            """{"to":"s2","text":"  "}""",
            """{"to":"s2","text":7}""",
            """{"to":"s2","text":"${"é".repeat(4097)}"}""",
        )
        for (json in refusals) assertTrue(json, context.tool("message", json).isError)
        assertTrue(context.tool("processPermissionRequest", "{}").isError)
        assertEquals("Unknown tool.", obj(context.tool("setSessionWatch", """{"ref":"s2","enabled":true}""").text).str("reason"))
        assertTrue(targets.sends.isEmpty())
        // 8 KiB exactly is fine.
        assertFalse(context.tool("message", """{"to":"s2","text":"${"é".repeat(4096)}"}""").isError)
    }

    @Test
    fun aSendWithNoAnswerInTimeIsUncertainAndNeverGoesUnderANewId() = runBlocking {
        val targets = backend()
        targets.sendDelay = 30_000
        val context = CallContext(targets, toolDeadlineMillis = 50)
        context.initial()
        suspend fun send(id: String) = context.handle(call(id, "message", """{"to":"s2","text":"go"}"""))
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
    fun movingTheScreenRefusesANavigationAskedUnderTheOldFocus() = runBlocking {
        val targets = backend()
        targets.screens = 1
        val context = CallContext(targets)
        context.initial()
        val moved = context.focusChanged("b")
        assertTrue(moved.context[0].contains(""""focusRevision":1"""))
        for (to in listOf("happy://conversation/s1", "happy://back")) {
            val stale = context.tool("navigate", """{"to":"$to","focusRevision":0}""")
            assertTrue(to, stale.isError)
            assertTrue(to, stale.text.contains("screen changed"))
        }
        assertTrue(targets.opened.isEmpty())
        assertEquals(1, targets.screens)
        // A message names where it goes: a move on screen doesn't stop it.
        assertFalse(context.handle(call("m", "message", """{"to":"s1","text":"go"}""")).isError)
        assertFalse(context.tool("navigate", """{"to":"happy://conversation/s1","focusRevision":1}""").isError)
    }

    /** No `to`: the conversation on screen as the tool runs, named in the answer; with none on screen, nothing goes and the agent is told to ask. */
    @Test
    fun aMessageWithNoToGoesToTheConversationOnScreen() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val sent = obj(context.tool("message", """{"text":"run the checks"}""").text)
        assertEquals("queued", sent.str("status"))
        assertEquals("s1", sent.str("ref"))
        assertEquals("Backend", sent.str("title"))
        assertEquals("s1", obj(context.tool("message", """{"to":" ","text":"and the lint"}""").text).str("ref"))
        assertEquals(listOf("a", "a"), targets.sends.map { it.agentId })
        // A named one says no title: the agent named it.
        assertNull(obj(context.tool("message", """{"to":"s2","text":"go"}""").text)["title"])
        // The screen moving while it is read doesn't send it elsewhere.
        targets.onRead = { context.focusChanged("b") }
        assertFalse(context.tool("message", """{"text":"once more"}""").isError)
        assertEquals("a", targets.sends.last().agentId)

        val none = backend(focus = null)
        val away = CallContext(none)
        away.initial()
        val refused = away.tool("message", """{"text":"run the checks"}""")
        assertTrue(refused.isError)
        assertEquals("No conversation is on screen. Ask which one, then send with its ref as to.", obj(refused.text).str("reason"))
        assertTrue(none.sends.isEmpty())
    }

    /** navigate takes the destinations the context lists and nothing else, answering anything else with them. */
    @Test
    fun navigateTakesOnlyTheContextsDestinations() = runBlocking {
        val targets = backend()
        targets.screens = 2
        val context = CallContext(targets)
        context.initial()
        for (bad in listOf("\"happy://settings\"", "\"s2\"", "\"https://example.com\"", "\"happy://conversation/\"", "\"happy://conversation/s2/x\"", "3", "null")) {
            val result = context.tool("navigate", """{"to":$bad,"focusRevision":0}""")
            assertTrue(bad, result.isError)
            val value = obj(result.text)
            assertEquals(bad, false, value["ok"]!!.jsonPrimitive.boolean)
            assertEquals(bad, listOf("happy://home", "happy://back", "happy://conversation/<ref>"), value.strings("destinations"))
        }
        assertEquals(
            "\"happy://settings\" isn't a destination. to is one of: happy://home, happy://back, happy://conversation/<ref>.",
            obj(context.tool("navigate", """{"to":"happy://settings","focusRevision":0}""").text).str("reason"),
        )
        assertTrue(targets.opened.isEmpty())
        assertEquals(2, targets.screens)
        // The scheme and place in any case, a trailing slash too; home whatever focusRevision says.
        assertEquals(true, obj(context.tool("navigate", """{"to":" HAPPY://Home/ ","focusRevision":7}""").text)["home"]!!.jsonPrimitive.boolean)
        assertEquals(0, targets.screens)
        assertEquals(CallContext.Destination.Conversation("s12"), CallContext.destination("happy://conversation/s12"))
        assertEquals(CallContext.Destination.Back, CallContext.destination("Happy://Back"))
    }

    @Test
    fun anEndedCallRunsNoTools() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        context.close()
        assertTrue(context.handle(call("late", "message", """{"to":"s2","text":"go"}""")).isError)
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
            assertTrue(bad, context.tool("navigate", """{"to":"happy://conversation/s1","focusRevision":$bad}""").isError)
        }
        assertTrue(targets.opened.isEmpty())
        assertFalse(context.tool("navigate", """{"to":"happy://conversation/s1","focusRevision":0}""").isError)
        for (bad in listOf("""{"query":3}""", """{"cursor":5}""", """{"cursor":"-1"}""", """{"cursor":"x"}""")) {
            assertTrue(bad, context.tool("listConversations", bad).isError)
        }
        assertTrue(context.tool("readConversation", """{"ref":1}""").isError)
    }

    // New work and the way back

    /** v2's tools are the shipped build's: this one calls v3, and knows none of them. */
    @Test
    fun v2sToolsAreUnknown() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        for (name in listOf("sendMessage", "listSessions", "getSessionContext", "openSession", "newWork", "goBack", "goHome")) {
            val result = context.tool(name, """{"targetRef":"s2","text":"go","focusRevision":0,"kind":"bot"}""")
            assertEquals(name, "Unknown tool.", obj(result.text).str("reason"))
        }
        assertTrue(targets.sends.isEmpty())
        assertTrue(targets.opened.isEmpty())
        assertTrue(targets.made.isEmpty())
    }

    /** One call: compose's new work with this message its first, off screen, reached by the reference the answer gives from then on. */
    @Test
    fun sendingToNewTaskStartsItOffScreenWithThatMessageFirst() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val started = obj(context.tool("message", """{"to":"new-task","text":"Find papers on caching"}""").text)
        assertEquals("queued", started.str("status"))
        assertEquals("task", started.str("started"))
        assertEquals("New Task", started.str("title"))
        val ref = started.str("ref")!!
        assertEquals("s3", ref)
        // Nothing moved: the screen and its focus are as they were.
        assertNull(started["focusRevision"])
        assertEquals(0, targets.screens)
        assertEquals(listOf(CallTarget.Kind.Task), targets.made.map { it.first })
        assertEquals(listOf("new-1"), targets.sends.map { it.agentId })
        assertEquals(listOf("Find papers on caching"), targets.sends.map { it.text })
        // Unlisted until the computer has it, it is read and sent to by that reference.
        assertEquals("New Task", obj(context.tool("readConversation", """{"ref":"$ref"}""").text).str("title"))
        // Made, it is home's under the same reference.
        targets.setDirectory(listOf(backendTarget, docsTarget, CallTarget("new-1", "Caching papers", CallTarget.Kind.Task, CallTarget.Status.Running)))
        val listed = obj(context.tool("listConversations", """{"query":"caching"}""").text)
        assertEquals(ref, listed["conversations"]!!.jsonArray[0].jsonObject.str("ref"))
        assertEquals(true, obj(context.tool("navigate", """{"to":"happy://conversation/$ref","focusRevision":0}""").text)["opened"]!!.jsonPrimitive.boolean)
        // Only a send takes the new-work references.
        for ((name, json) in listOf("readConversation" to """{"ref":"new-task"}""", "navigate" to """{"to":"happy://conversation/new-task","focusRevision":1}""")) {
            val refused = context.tool(name, json)
            assertTrue(name, refused.isError)
            assertTrue(name, refused.text.contains("start it with message to new-task or new-bot"))
        }
    }

    @Test
    fun aNewBotIsNamedAfterAColon() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val started = obj(context.tool("message", """{"to":"New-Bot: Release helper ","text":"Watch the release"}""").text)
        assertEquals("bot", started.str("started"))
        assertEquals("Release helper", started.str("title"))
        assertEquals(listOf(CallTarget.Kind.Bot to "Release helper"), targets.made.toList())
        assertEquals("New Bot", obj(context.tool("message", """{"to":"new-bot","text":"Watch the docs"}""").text).str("title"))
    }

    /** The model and effort go as compose's pickers would set them before its first send; without them, compose's default, said in the answer. */
    @Test
    fun newWorkStartsOnTheModelAskedForOrComposesDefault() = runBlocking {
        val targets = backend()
        targets.newWorkMode = CallMode(opus.id, opus.name, "high")
        targets.newWorkModels = listOf(opus, sonnet, gpt)
        val context = CallContext(targets)
        context.initial()
        val asked = obj(context.tool("message", """{"to":"new-task","text":"go","model":"sonnet","effort":"low"}""").text)
        assertEquals("Claude Sonnet 4.5", asked.str("model"))
        assertEquals("low", asked.str("effort"))
        val plain = obj(context.tool("message", """{"to":"new-task","text":"also"}""").text)
        assertEquals("Claude Opus 4.5", plain.str("model"))
        assertEquals("high", plain.str("effort"))
        assertEquals(listOf(CallModeChange("claude-sonnet-4-5", "low"), null), targets.sends.map { it.change })
    }

    /** Refused for its model or its effort: nothing goes and nothing stays. */
    @Test
    fun aRefusedStartLeavesNothing() = runBlocking {
        val targets = backend()
        targets.newWorkMode = CallMode(opus.id, opus.name, "high")
        targets.newWorkModels = listOf(opus, sonnet)
        val context = CallContext(targets)
        context.initial()
        val unknown = context.tool("message", """{"to":"new-task","text":"go","model":"gemini"}""")
        assertTrue(unknown.isError)
        assertEquals(2, obj(unknown.text)["models"]!!.jsonArray.size)
        assertTrue(context.tool("message", """{"to":"new-task","text":"go","model":"sonnet","effort":"max"}""").isError)
        assertTrue(targets.sends.isEmpty())
        assertEquals(listOf("new-1", "new-2"), targets.discarded.toList())
    }

    /** The provider asking again, its answer lost: the same new work, never a second. */
    @Test
    fun theSameWordsAgainStartNothingNew() = runBlocking {
        val targets = backend()
        targets.sendDelay = 300
        val context = CallContext(targets, toolDeadlineMillis = 100)
        context.initial()
        val first = context.tool("message", """{"to":"new-task","text":"Fix the build"}""")
        assertEquals("uncertain", obj(first.text).str("status"))
        targets.sendDelay = 0
        delay(300)
        val second = obj(context.tool("message", """{"to":"new-task","text":"Fix the build"}""").text)
        assertEquals("queued", second.str("status"))
        assertEquals(1, targets.made.size)
        assertEquals(1, targets.sends.map { it.id }.toSet().size)
        assertEquals(setOf("new-1"), targets.sends.map { it.agentId }.toSet())
    }

    @Test
    fun composeOpenedByHandIsReachedThroughTheFocus() = runBlocking {
        val targets = backend(focus = null)
        val context = CallContext(targets)
        context.initial()
        targets.composeByHand()
        val focus = events(context.focusChanged("new-1")).last()
        assertEquals("New Task", focus.str("title"))
        val ref = focus.str("ref")!!
        assertFalse(context.tool("message", """{"to":"$ref","text":"Fix the flaky test"}""").isError)
    }

    @Test
    fun backPopsOneScreenAndHomeClearsThem() = runBlocking {
        val targets = backend(focus = null)
        targets.screens = 3
        val context = CallContext(targets)
        context.initial()
        assertTrue(context.tool("navigate", """{"to":"happy://back","focusRevision":2}""").isError)
        assertEquals(3, targets.screens)
        val back = obj(context.tool("navigate", """{"to":"happy://back","focusRevision":0}""").text)
        assertEquals(false, back["home"]!!.jsonPrimitive.boolean)
        assertEquals(JsonNull, back["title"])
        assertEquals(2, targets.screens)
        assertEquals(true, obj(context.tool("navigate", """{"to":"happy://home","focusRevision":0}""").text)["home"]!!.jsonPrimitive.boolean)
        val nowhere = context.tool("navigate", """{"to":"happy://back","focusRevision":0}""")
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
    fun messageSwitchesTheModelAndEffortTheComputerOffers() = runBlocking {
        val targets = modelled()
        val context = CallContext(targets)
        context.initial()
        // Working, it still takes the message, as the composer's send does.
        val both = obj(context.tool("message", """{"to":"s2","text":"go","model":"sonnet","effort":"Low"}""").text)
        assertEquals("queued", both.str("status"))
        assertEquals("Claude Sonnet 4.5", both.str("model"))
        assertEquals("low", both.str("effort"))
        val effortOnly = obj(context.tool("message", """{"to":"s2","text":"again","effort":"max"}""").text)
        assertEquals("Claude Opus 4.5", effortOnly.str("model"))
        assertEquals("max", effortOnly.str("effort"))
        val modelOnly = obj(context.tool("message", """{"to":"s2","text":"third","model":"GPT 5.2 codex"}""").text)
        assertEquals("medium", modelOnly.str("effort"))
        assertNull(obj(context.tool("message", """{"to":"s2","text":"fourth"}""").text)["model"])
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
        val unknown = context.tool("message", """{"to":"s2","text":"go","model":"gemini"}""")
        assertTrue(unknown.isError)
        val listed = obj(unknown.text)
        assertEquals(listOf("Claude Opus 4.5", "Claude Sonnet 4.5", "GPT-5.2 Codex"), listed["models"]!!.jsonArray.map { it.jsonObject.str("name") })
        assertTrue(listed.str("reason")!!.endsWith("Nothing was sent."))
        assertEquals(2, obj(context.tool("message", """{"to":"s2","text":"go","model":"claude"}""").text)["models"]!!.jsonArray.size)
        val effort = obj(context.tool("message", """{"to":"s2","text":"go","model":"sonnet","effort":"max"}""").text)
        assertEquals("Claude Sonnet 4.5 takes effort low, medium, high, not \"max\". Nothing was sent.", effort.str("reason"))
        assertTrue(context.tool("message", """{"to":"s2","text":"go","model":4}""").isError)
        // Without the computer's models, nothing changes and nothing goes.
        assertTrue(context.tool("message", """{"to":"s1","text":"go","effort":"high"}""").isError)
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
        val read = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
        assertEquals(obj("""{"ago":"2 hours ago","at":"2025-11-06T11:00:00+01:00"}"""), read["lastUserMessage"])
        assertEquals(obj("""{"ago":"5 minutes ago","at":"2025-11-06T12:55:00+01:00"}"""), read["lastAgentReply"])
        assertEquals("App / Feature", read.str("workspace"))
        assertEquals(obj("""{"id":"claude-opus-4-5","name":"Claude Opus 4.5","effort":"high"}"""), read["model"])
        assertEquals(listOf("low", "medium", "high", "max"), read["models"]!!.jsonArray[0].jsonObject.strings("efforts"))
        val listed = obj(context.tool("listConversations", "{}").text)
        val row = listed["conversations"]!!.jsonArray[0].jsonObject
        assertEquals(obj("""{"ago":"5 minutes ago","at":"2025-11-06T12:55:00+01:00"}"""), row["lastActivity"])
        assertEquals("App / Feature", row.str("workspace"))
        assertEquals("2025-11-06T13:00:00+01:00", listed.str("now"))
    }

    @Test
    fun aTeamsMessagesSayWhoWroteThem() = runBlocking {
        val now = 1_762_430_400_000L
        val chat = CallTarget("c", "Auth", CallTarget.Kind.Task, CallTarget.Status.Idle)
        val pending = CallMessage("m3", CallMessage.Role.User, "Now the signup", now - 60_000, author = "me")
        val read = CallTargetState(
            chat,
            messages = listOf(CallMessage("m1", CallMessage.Role.User, "Fix the login", now - 600_000, author = "ada"), CallMessage("m2", CallMessage.Role.Assistant, "Fixed"), pending),
            turns = listOf(CallTurn("r1", "Fix the login", "Fixed", endedAt = now - 500_000, userAuthor = "ada")),
            unanswered = pending,
        )
        assertEquals(setOf("ada", "me"), read.authors)
        // The one on the call is "the person"; a member the computer didn't name, "a teammate".
        val named = read.named(mapOf("ada" to "Ada Lovelace"), "me")
        assertEquals("Ada Lovelace", named.turns[0].userBy)
        assertEquals("the person", named.unanswered?.by)
        assertEquals("a teammate", read.named(emptyMap(), null).turns[0].userBy)
        val context = CallContext(FakeCallTargets(listOf(chat), mutableMapOf("c" to named), null), now = { now }, zone = java.time.ZoneOffset.UTC)
        context.initial()
        val body = obj(context.tool("readConversation", """{"ref":"s1"}""").text)
        assertEquals("Ada Lovelace", body["turns"]!!.jsonArray[0].jsonObject.str("userBy"))
        assertEquals("the person", body["pendingUserMessage"]!!.jsonObject.str("by"))
        assertEquals("the person", body["lastUserMessage"]!!.jsonObject.str("by"))
        // Outside a team nothing has an author, and nothing says who.
        assertTrue(CallTargetState(chat, messages = listOf(CallMessage("m", CallMessage.Role.User, "hi"))).named(emptyMap(), null).messages.all { it.by == null })
    }

    @Test
    fun messagesCarryTheirAuthorFromTheWire() {
        val message = com.slopus.happy.conversation.Message.parse(Json.parseToJsonElement("""{"id":"m","role":"user","createdAt":1,"content":[{"type":"text","text":"hi"}],"metadata":{"userId":"ada"}}"""))!!
        assertEquals("ada", message.userId)
        // Kept on the phone, it keeps its author.
        val kept = com.slopus.happy.conversation.KeptConversation.messageJson(message)
        assertEquals("ada", com.slopus.happy.conversation.Message.parse(kept)!!.userId)
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
        assertEquals(listOf("listConversations", "readConversation", "message", "navigate"), CallTool.entries.map { it.wire })
        assertEquals(JsonArray(emptyList()), CallTool.ListConversations.parameters["required"])
        assertEquals(listOf("ref"), CallTool.ReadConversation.parameters.strings("required"))
        assertEquals(listOf("text"), CallTool.Message.parameters.strings("required"))
        assertNull(CallTool.Message.parameters["properties"]!!.jsonObject["focusRevision"])
        assertEquals("string", CallTool.Message.parameters["properties"]!!.jsonObject["to"]!!.jsonObject.str("type"))
        assertEquals("string", CallTool.Message.parameters["properties"]!!.jsonObject["model"]!!.jsonObject.str("type"))
        assertEquals(listOf("to", "focusRevision"), CallTool.Navigate.parameters.strings("required"))
        assertEquals("integer", CallTool.Navigate.parameters["properties"]!!.jsonObject["focusRevision"]!!.jsonObject.str("type"))
        assertTrue(CallTool.Message.summary.contains("only when the person has explicitly asked you to send"))
        assertTrue(CallTool.Message.summary.contains("queued on the person's device, not confirmed delivered"))
        assertTrue(CallTool.ListConversations.summary.contains("case-insensitive substring"))
        for (destination in CallContext.DESTINATIONS) assertTrue(destination, CallTool.Navigate.summary.contains(destination))
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
    fun listConversationsPagesAndFiltersBySubstring() = runBlocking {
        val many = (0 until 120).map { CallTarget("x$it", if (it % 2 == 0) "Even $it" else "Odd $it", CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val context = CallContext(FakeCallTargets(many, mutableMapOf(), null))
        context.initial()
        val first = obj(context.tool("listConversations", "{}").text)
        assertEquals(50, first["conversations"]!!.jsonArray.size)
        assertEquals("50", first.str("nextCursor"))
        assertEquals(16, obj(context.tool("listConversations", """{"query":"DD 1","cursor":null}""").text)["conversations"]!!.jsonArray.size)
        val paged = obj(context.tool("listConversations", """{"query":"odd","cursor":"50"}""").text)
        assertEquals(10, paged["conversations"]!!.jsonArray.size)
        assertNull(paged["nextCursor"])
    }

    // The directory: what the person sees

    @Test
    fun theDirectoryIsHomesConversationsNestedAsItShowsThem() = runBlocking {
        val list = CallTarget.from(CallTargetsTest.sidebar())
        val context = CallContext(FakeCallTargets(list, mutableMapOf(), null))
        val initial = context.initial()
        assertTrue(initial, initial.contains(
            """
            Conversations in the app, in the sidebar's order:
            - Architect — bot, ref s1
            - Release notes — task, ref s2
              - Fix cache race — subtask, ref s3
                - Check the lock — subtask, ref s4
            - New Task — task, ref s5
            - App — project
              - Root chat — conversation, ref s6
              - Feature — workspace
                - Feature chat — conversation, ref s7
            """.trimIndent(),
        ))
        // No IDs of the computer's in what the agent reads.
        for (id in list.map { it.agentId }) assertFalse(id, initial.contains(id))
        val found = obj(context.tool("listConversations", """{"query":"lock"}""").text)["conversations"]!!.jsonArray.first().jsonObject
        assertEquals("s4", found.str("ref"))
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
        val read = obj(context.tool("readConversation", """{"ref":"s2"}""").text)
        assertEquals("Fix cache race", read.str("title"))
        assertEquals(listOf("Release notes"), read.strings("parents"))
        assertNull(read["ref"])
        assertNull(read["ref"])
        assertEquals("sub answer", read.turns().first().str("assistant"))
        assertTrue(obj(context.tool("navigate", """{"to":"happy://conversation/s2","focusRevision":0}""").text)["opened"]!!.jsonPrimitive.boolean)
        assertEquals("queued", obj(context.tool("message", """{"to":"s2","text":"go on"}""").text).str("status"))
        assertEquals(listOf("c"), targets.sends.map { it.agentId })
        // A reference no one gave reaches nothing.
        assertTrue(context.tool("readConversation", """{"ref":"s9"}""").isError)
    }

    /** A reference reaches a conversation while home lists it; gone, it reaches nothing; back, it reaches it again. */
    @Test
    fun aReferenceReachesWhatIsListedNow() = runBlocking {
        val targets = FakeCallTargets(listOf(backendTarget, docsTarget), mutableMapOf(
            "a" to CallTargetState(backendTarget), "b" to CallTargetState(docsTarget),
        ), "b")
        val context = CallContext(targets)
        context.initial()
        targets.setDirectory(listOf(backendTarget))
        for ((name, json) in listOf(
            "readConversation" to """{"ref":"s2"}""",
            "navigate" to """{"to":"happy://conversation/s2","focusRevision":0}""",
            "message" to """{"to":"s2","text":"hi"}""",
        )) {
            assertTrue(name, context.tool(name, json).isError)
        }
        targets.setDirectory(listOf(backendTarget, docsTarget))
        assertFalse(context.tool("readConversation", """{"ref":"s2"}""").isError)
    }

    /** What came since, before an update told of it, gives its reference with the first update about it, and only then. */
    @Test
    fun whatCameSinceTheStartComesWithItsReference() = runBlocking {
        val targets = FakeCallTargets(listOf(releaseTarget), mutableMapOf("t" to CallTargetState(releaseTarget)), null)
        val context = CallContext(targets)
        context.initial()
        targets.setDirectory(listOf(releaseTarget, fixTarget))
        val focus = events(context.focusChanged("c"))
        assertEquals(listOf("focus"), focus.map { it.str("event") })
        assertEquals("Fix cache race", focus[0].str("title"))
        assertEquals(listOf("Release notes"), focus[0].strings("parents"))
        assertEquals("s2", focus[0].str("ref"))
        // Its words after that: by name alone.
        context.targetChanged(CallTargetState(fixTarget, working = true))
        val words = events(context.targetChanged(CallTargetState(fixTarget, listOf(CallMessage("m", CallMessage.Role.Assistant, "Fixed.")))))
        assertEquals(listOf("assistant_text"), words.map { it.str("event") })
        assertNull(words[0]["ref"])
        // listConversations gives references too: what it listed comes without one.
        val other = CallTarget("o", "Other", CallTarget.Kind.Task, CallTarget.Status.Idle)
        targets.setDirectory(listOf(releaseTarget, fixTarget, other))
        context.tool("listConversations", """{"query":"other"}""")
        assertNull(events(context.focusChanged("o"))[0]["ref"])
    }

    /** Work deleted since: a reply that comes late from it says nothing, under its old name or any. */
    @Test
    fun aLateReplyFromWorkThatWentAwaySaysNothing() = runBlocking {
        val targets = backend(focus = "b")
        val context = CallContext(targets)
        context.initial()
        context.targetChanged(CallTargetState(docsTarget, working = true))
        targets.setDirectory(listOf(backendTarget))
        context.tool("listConversations", "{}")
        val late = context.targetChanged(CallTargetState(docsTarget, listOf(CallMessage("w", CallMessage.Role.Assistant, "Done.")),
            listOf(CallTurn("x", ended = "error", error = "Boom"))))
        assertTrue(late.isEmpty)
    }

    /** A conversation under more than the directory can show: still listed, with what it sits under on one line cut to fit, and the ones after it too. */
    @Test
    fun anEntryTooDeepForTheDirectoryStillGoes() = runBlocking {
        val chain = (0 until 80).map { CallTarget.Parent("session:p$it", "Parent $it " + "y".repeat(180), "subtask", "p$it") }
        val deep = CallTarget("deep", "Deep one", CallTarget.Kind.Subtask, CallTarget.Status.Idle, chain)
        val after = CallTarget("after", "After it", CallTarget.Kind.Task, CallTarget.Status.Idle)
        val text = CallContext(FakeCallTargets(listOf(deep, after), mutableMapOf(), null)).initial()
        assertTrue(text, text.contains("\n(under Parent 0 "))
        assertTrue(text, text.contains("\n- Deep one — subtask, ref "))
        // What comes after it is counted, for listConversations to find.
        assertTrue(text, text.contains("\n… and 1 more; listConversations finds them by title."))
        assertTrue(text.utf8Size() <= CallContext.Limits.TOTAL_BYTES)
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

    // The directory's changes

    private fun task(id: String, title: String, kind: CallTarget.Kind = CallTarget.Kind.Task, parents: List<CallTarget.Parent> = emptyList()) =
        CallTarget(id, title, kind, CallTarget.Status.Idle, parents)

    /** Home as it is now: the `directory` update of what changed, if any. */
    private suspend fun news(context: CallContext, targets: FakeCallTargets, now: List<CallTarget>): JsonObject? {
        targets.setDirectory(now)
        context.directoryChanged(now)
        val update = context.directoryUpdate()
        assertTrue(update.context.size <= 1)
        return update.context.firstOrNull()?.let(::obj)
    }

    private suspend fun refs(context: CallContext): Map<String, String> =
        obj(context.tool("listConversations", "{}").text)["conversations"]!!.jsonArray.associate { it.jsonObject.str("title")!! to it.jsonObject.str("ref")!! }

    private fun JsonObject.list(key: String) = this[key]?.jsonArray?.map { it.jsonObject }

    @Test
    fun theFirstReferencesAreAsShortAsTheListAllows() {
        assertEquals(emptyList<String>(), CallContext.spread(0))
        assertEquals(listOf("1", "2", "3"), CallContext.spread(3))
        assertEquals("9", CallContext.spread(9).last())
        assertEquals(listOf("11", "12", "13", "14", "15", "16", "17", "18", "19", "21"), CallContext.spread(10))
        assertEquals("99", CallContext.spread(81).last())
        assertEquals(listOf("101", "102", "103", "104", "105", "106", "107", "108", "109", "111"), CallContext.spread(82).take(10))
        for (count in listOf(1, 9, 10, 81, 82, 810, 811)) {
            val keys = CallContext.spread(count)
            assertEquals(count, keys.size)
            assertEquals("$count", keys.sorted(), keys)
            assertEquals(count, keys.toSet().size)
            assertFalse("$count", keys.any { it.endsWith("0") })
        }
    }

    /** One that comes later sorts into its place between its neighbours' references; none of theirs changes. */
    @Test
    fun aNewConversationSortsIntoItsPlaceAndNoReferenceChanges() = runBlocking {
        val five = listOf("A", "B", "C", "D", "E").map { task(it.lowercase(), it) }
        val targets = FakeCallTargets(five, mutableMapOf(), null)
        val context = CallContext(targets)
        val initial = context.initial()
        assertTrue(initial, initial.contains("- A — task, ref s1\n- B — task, ref s2\n- C — task, ref s3\n- D — task, ref s4\n- E — task, ref s5"))
        val now = five.toMutableList()
        now.add(4, task("x", "X"))
        val between = news(context, targets, now)!!
        assertEquals("directory", between.str("event"))
        val added = between.list("added")!!
        assertEquals(1, added.size)
        assertEquals("s49", added[0].str("ref"))
        assertEquals("X", added[0].str("title"))
        assertEquals("task", added[0].str("kind"))
        assertNull(added[0]["after"])
        assertNull(added[0]["parents"])
        assertNull(between["removed"])
        assertNull(between["more"])
        now.add(4, task("y", "Y"))
        now.add(0, task("z", "Z"))
        now.add(task("w", "W"))
        assertEquals(listOf("s09", "s48", "s6"), news(context, targets, now)!!.list("added")!!.map { it.str("ref") })
        val refs = refs(context)
        assertEquals(mapOf("A" to "s1", "B" to "s2", "C" to "s3", "D" to "s4", "E" to "s5", "X" to "s49", "Y" to "s48", "Z" to "s09", "W" to "s6"), refs)
        // Sorted as text, they are home's order.
        assertEquals(now.map { refs.getValue(it.title) }.sorted(), now.map { refs.getValue(it.title) })
        // Nothing else changed: nothing more goes.
        assertNull(news(context, targets, now))
    }

    /** Bursts of new work in one place keep their references short. */
    @Test
    fun repeatedInsertsInOnePlaceStayShort() = runBlocking {
        val two = listOf(task("a", "A"), task("b", "B"))
        val targets = FakeCallTargets(two, mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        val now = two.toMutableList()
        // New tasks go first among the tasks, under the bot, one after another: s19 to s11, then s1099.
        repeat(10) { index ->
            now.add(1, task("n$index", "New $index"))
            news(context, targets, now)
        }
        val refs = refs(context)
        assertEquals(now.map { refs.getValue(it.title) }.sorted(), now.map { refs.getValue(it.title) })
        assertTrue("$refs", refs.values.maxOf { it.length } <= 5)
        assertEquals(refs.size, refs.values.toSet().size)
    }

    /** A reference stays through a rename and a move, and comes back with its conversation; no other conversation ever gets it. */
    @Test
    fun aReferenceStaysThroughRenamesMovesAndComingBack() = runBlocking {
        val parent = CallTarget.Parent("task:b", "B", "task", "b")
        val start = listOf(task("a", "A"), task("b", "B"), task("c", "C", CallTarget.Kind.Subtask, listOf(parent)), task("d", "D"), task("e", "E"))
        val targets = FakeCallTargets(start, mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        // Renamed.
        var now = start.toMutableList()
        now[1] = now[1].copy(title = "B2")
        now[2] = now[2].copy(parents = listOf(parent.copy(title = "B2")))
        val renamed = news(context, targets, now)!!
        assertEquals(listOf(mapOf("ref" to "s2", "title" to "B2")), renamed.list("renamed")!!.map { o -> o.mapValues { it.value.jsonPrimitive.content } })
        // What sits under it isn't renamed, nor moved.
        assertNull(renamed["moved"])
        // Moved to the top: that one alone moved, under its reference.
        now = (listOf(now[4]) + now.take(4)).toMutableList()
        val moved = news(context, targets, now)!!
        assertEquals(1, moved.list("moved")!!.size)
        val move = moved.list("moved")!!.first()
        assertEquals("s5", move.str("ref"))
        assertEquals(JsonNull, move["after"])
        assertEquals(emptyList<String>(), move.strings("parents"))
        assertNull(moved["added"])
        // Gone.
        val withoutC = now.filter { it.agentId != "c" }
        assertEquals(listOf("s3"), news(context, targets, withoutC)!!.strings("removed"))
        // Something new where it was gets a key of its own, never its.
        val fresh = withoutC.toMutableList().apply { add(3, task("f", "F")) }
        assertEquals("s29", news(context, targets, fresh)!!.list("added")!!.first().str("ref"))
        // Back, under its own reference, in its place.
        val back = fresh.toMutableList().apply { add(4, now[3]) }
        val again = news(context, targets, back)!!.list("added")!!.first()
        assertEquals("s3", again.str("ref"))
        assertEquals(listOf("B2"), again.strings("parents"))
        assertNull(again["after"])
        // It reaches it again (this fake has nothing to read of it).
        val read = context.tool("readConversation", """{"ref":"s3"}""")
        assertTrue(read.text, read.text.contains("can't be read now"))
    }

    /** New work `message` started is added once home lists it, under the reference its answer gave, with where it sits: its key came before its place. */
    @Test
    fun newWorkFromMessageIsAddedOnceHomeListsIt() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val started = obj(context.tool("message", """{"to":"new-task","text":"Find papers on caching"}""").text)
        assertEquals("s3", started.str("ref"))
        // Nothing yet: home doesn't list it.
        assertFalse(context.directoryChanged(listOf(backendTarget, docsTarget)))
        val made = CallTarget("new-1", "Caching papers", CallTarget.Kind.Task, CallTarget.Status.Running)
        val update = news(context, targets, listOf(backendTarget, made, docsTarget))!!
        assertEquals(
            listOf(mapOf("after" to "s1", "kind" to "task", "ref" to "s3", "title" to "Caching papers")),
            update.list("added")!!.map { o -> o.mapValues { it.value.jsonPrimitive.content } },
        )
        assertEquals(setOf("event", "added"), update.keys)
        // Its words after that, by name alone.
        context.focusChanged("new-1")
        context.targetChanged(CallTargetState(made, working = true))
        val words = events(context.targetChanged(CallTargetState(made, listOf(CallMessage("m", CallMessage.Role.Assistant, "Found three.")))))
        assertNull(words.first()["ref"])
    }

    /** "New Task" and the name it gets a moment later settle into one entry; a status changes nothing the directory shows. */
    @Test
    fun newWorkFromHomeSettlesIntoOneEntryUnderItsName() = runBlocking {
        val targets = backend()
        val context = CallContext(targets)
        context.initial()
        val busy = CallTarget("a", "Backend", CallTarget.Kind.Bot, CallTarget.Status.Running, activityAt = 5)
        assertFalse(context.directoryChanged(listOf(busy, docsTarget)))
        assertTrue(context.directoryChanged(listOf(backendTarget, task("n", "New Task"), docsTarget)))
        val named = news(context, targets, listOf(backendTarget, task("n", "Benchmark the cache"), docsTarget))!!
        assertEquals(
            listOf(mapOf("kind" to "task", "ref" to "s19", "title" to "Benchmark the cache")),
            named.list("added")!!.map { o -> o.mapValues { it.value.jsonPrimitive.content } },
        )
        assertNull(named["renamed"])
        // Told, a rename after it is one.
        val renamed = news(context, targets, listOf(backendTarget, task("n", "Benchmark the LRU cache"), docsTarget))!!
        assertEquals(
            listOf(mapOf("ref" to "s19", "title" to "Benchmark the LRU cache")),
            renamed.list("renamed")!!.map { o -> o.mapValues { it.value.jsonPrimitive.content } },
        )
        assertNull(events(context.focusChanged("n")).first()["ref"])
    }

    /** A burst of changes within the settle goes as one flush; one after it starts the next. */
    @Test
    fun changesSettleIntoOneUpdate() = runBlocking {
        var flushes = 0
        val scope = kotlinx.coroutines.CoroutineScope(coroutineContext + kotlinx.coroutines.SupervisorJob())
        val settle = DirectorySettle(scope, delayMillis = 80) { flushes += 1 }
        settle.changed()
        delay(20)
        settle.changed()
        settle.changed()
        assertEquals(0, flushes)
        delay(200)
        assertEquals(1, flushes)
        settle.changed()
        delay(200)
        assertEquals(2, flushes)
        settle.changed()
        settle.cancel()
        delay(200)
        assertEquals(2, flushes)
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    /** Many at once: twenty in all within 4 KB, the rest counted; those not told come with their reference in the first update about them. */
    @Test
    fun anUpdateKeepsItsBudget() = runBlocking {
        val targets = FakeCallTargets(listOf(backendTarget), mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        val many = (0 until 60).map { task("m$it", "Imported $it") }
        val update = news(context, targets, listOf(backendTarget) + many)!!
        assertEquals(20, update.list("added")!!.size)
        assertEquals(40, update["more"]!!.jsonPrimitive.int)
        val project = CallTarget.Parent("p", "Parent ".repeat(25), "project")
        val long = (0 until 10).map { task("l$it", "Long title $it ".repeat(12) + "\"".repeat(40), parents = listOf(project)) }
        val all = listOf(backendTarget) + many + long
        targets.setDirectory(all)
        context.directoryChanged(all)
        val line = context.directoryUpdate().context.first()
        assertTrue(line.utf8Size() <= CallContext.Limits.DIRECTORY_UPDATE_BYTES)
        val event = obj(line)
        val listed = event.list("added")?.size ?: 0
        assertTrue(listed in 1 until 10)
        assertEquals(10, listed + (event["more"]?.jsonPrimitive?.int ?: 0))
        // Past the budget: named with its reference when it first comes up.
        assertTrue(events(context.focusChanged("l9")).first()["ref"] != null)
        assertTrue(events(context.focusChanged("m45")).first()["ref"] != null)
        assertNull(events(context.focusChanged("m0")).first()["ref"])
    }

    /** What changed of a conversation the agent was never told of says nothing; what came always does. */
    @Test
    fun onlyWhatTheAgentHasIsRenamedMovedOrRemoved() = runBlocking {
        val many = (0 until 120).map { task("x$it", "Task $it") }
        val targets = FakeCallTargets(many, mutableMapOf(), null)
        val context = CallContext(targets)
        context.initial()
        val now = many.toMutableList()
        now[110] = now[110].copy(title = "Renamed far down")
        now.removeAt(115)
        assertNull(news(context, targets, now))
        now[0] = now[0].copy(title = "Renamed on top")
        assertEquals(
            listOf(mapOf("ref" to "s101", "title" to "Renamed on top")),
            news(context, targets, now)!!.list("renamed")!!.map { o -> o.mapValues { it.value.jsonPrimitive.content } },
        )
    }

    /** Context lost before the call was live: the resync tells what home changed since the first context. */
    @Test
    fun aResyncTellsWhatTheDirectoryChangedSinceTheStart() = runBlocking {
        val targets = backend(focus = null)
        val context = CallContext(targets)
        context.initial()
        val fresh = task("n", "Benchmark the cache")
        news(context, targets, listOf(backendTarget, fresh, docsTarget))
        val resync = events(context.resync())
        assertEquals(listOf("directory", "focus"), resync.map { it.str("event") })
        assertEquals("s19", resync[0].list("added")!!.first().str("ref"))
        // Put right, nothing more goes.
        assertNull(news(context, targets, listOf(backendTarget, fresh, docsTarget)))
        // Nothing changed since the start: none.
        val quiet = CallContext(backend(focus = null))
        quiet.initial()
        assertEquals(listOf("focus"), events(quiet.resync()).map { it.str("event") })
    }

    /** Names full of quotes, backslashes, slashes and control characters keep a resync within what a call keeps waiting. */
    @Test
    fun budgetsHoldInEncodedJson() = runBlocking {
        val nasty = "\"q\" \\b\\ /s/ \u0001\u0002\u0007\u001B"
        val many = (0 until 400).map { CallTarget("x$it", "$it " + nasty.repeat(8), CallTarget.Kind.Task, CallTarget.Status.Idle) }
        val visits = many.take(4)
        val targets = FakeCallTargets(many, visits.associateTo(HashMap()) { it.agentId to CallTargetState(it) }, null)
        val context = CallContext(targets)
        assertTrue(context.initial().utf8Size() <= CallContext.Limits.TOTAL_BYTES)
        for (target in visits) {
            context.focusChanged(target.agentId)
            context.targetChanged(CallTargetState(target))
            val words = (0 until 6).map { CallMessage("${target.agentId}m$it", CallMessage.Role.Assistant, nasty.repeat(200)) }
            context.targetChanged(CallTargetState(target, words))
        }
        assertTrue(size(context.resync()) <= CallSession.PENDING_BYTES)
        // Titles from home carry no control characters at all.
        assertEquals("a b c\u200Dd", CallTarget.clean("a\u0001b\nc\u200Dd"))
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
    /** How long [state] takes: the phone reading a conversation it doesn't hold. */
    @Volatile var stateDelay = 0L
    override suspend fun state(agentId: String): CallTargetState? {
        onRead?.let { onRead = null; it() }
        if (stateDelay > 0) delay(stateDelay)
        return lock.withLock { states[agentId] }
    }
    /** How [refreshed] goes for a conversation: at once as it is (absent, the default), current after a wait, or never current within its limit. */
    sealed interface Refresh {
        data class After(val millis: Long) : Refresh
        data object Never : Refresh
    }
    val refresh = java.util.concurrent.ConcurrentHashMap<String, Refresh>()
    val refreshes = java.util.Collections.synchronizedList(ArrayList<String>())
    override suspend fun refreshed(agentId: String, limitMillis: Long): CallTargetState? {
        refreshes += agentId
        return when (val how = refresh[agentId]) {
            null -> state(agentId)
            is Refresh.After -> { delay(how.millis); lock.withLock { states[agentId] }?.copy(fresh = true) }
            Refresh.Never -> { delay(limitMillis); lock.withLock { states[agentId] }?.copy(fresh = false) }
        }
    }
    override suspend fun focused() = focus
    override suspend fun open(agentId: String): Boolean { opened += agentId; return states[agentId] != null }
    override suspend fun send(agentId: String, text: String, id: String, change: CallModeChange?): CallSendOutcome {
        if (sendDelay > 0) try { delay(sendDelay) } catch (e: kotlinx.coroutines.CancellationException) { sends += Sent(agentId, text, id, change); throw e }
        sends += Sent(agentId, text, id, change)
        return CallSendOutcome.Queued
    }
    override suspend fun follow(agentId: String, following: Boolean) { follows += agentId to following }

    /** New work started off screen: unlisted until its first message. */
    val made = java.util.Collections.synchronizedList(ArrayList<Pair<CallTarget.Kind, String>>())
    val discarded = java.util.Collections.synchronizedList(ArrayList<String>())
    private val unlistedWork = java.util.concurrent.ConcurrentHashMap<String, CallTarget>()
    /** What new work starts on, and may switch to, as compose's pickers have them. */
    @Volatile var newWorkMode: CallMode? = null
    @Volatile var newWorkModels: List<CallModel> = emptyList()
    /** Screens over home, the top last: what `back` and `home` take away. */
    @Volatile var screens = 0
    override suspend fun draft(kind: CallTarget.Kind, name: String): CallTarget {
        made += kind to name
        val draft = CallTarget("new-${made.size}", name.ifEmpty { if (kind == CallTarget.Kind.Bot) "New Bot" else "New Task" }, kind, CallTarget.Status.Idle)
        unlistedWork[draft.agentId] = draft
        lock.withLock { states[draft.agentId] = CallTargetState(draft, mode = newWorkMode, models = newWorkModels) }
        return draft
    }
    override suspend fun discard(agentId: String) {
        discarded += agentId
        unlistedWork.remove(agentId)
        lock.withLock { states.remove(agentId) }
    }
    /** Compose opened by the person: new work on a screen of its own. */
    suspend fun composeByHand() {
        made += CallTarget.Kind.Task to ""
        val draft = CallTarget("new-${made.size}", "New Task", CallTarget.Kind.Task, CallTarget.Status.Idle)
        unlistedWork[draft.agentId] = draft
        lock.withLock { states[draft.agentId] = CallTargetState(draft) }
        screens++
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
