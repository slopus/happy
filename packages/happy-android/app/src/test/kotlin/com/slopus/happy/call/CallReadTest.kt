package com.slopus.happy.call

import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.FailureReason
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `readConversation`'s paging and cuts ([CallRead]): backwards by turn, each with its `t:` reference, messages cut in
 * the middle past their words, the whole within the wire's limit. iOS `CallReadTests` holds the same cases.
 */
class CallReadTest {
    private val target = CallTarget("a", "Backend", CallTarget.Kind.Bot, CallTarget.Status.Idle)

    /** Eight finished turns, `run-11` to `run-88`, oldest first. */
    private fun eight(reply: (Int) -> String = { "answer $it" }) =
        (1..8).map { CallTurn("run-${"%02d".format(it * 11)}", "ask $it", reply(it)) }

    private suspend fun context(state: CallTargetState): Pair<CallContext, FakeCallTargets> {
        val targets = FakeCallTargets(listOf(target), mutableMapOf("a" to state), null)
        val context = CallContext(targets)
        context.initial()
        return context to targets
    }

    private var calls = 0
    private suspend fun read(context: CallContext, arguments: String = "") =
        context.handle(CallToolCall("r${calls++}", "readConversation", obj("""{"ref":"s1"$arguments}""")))

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.turns() = this["turns"]?.jsonArray?.map { it.jsonObject } ?: emptyList()
    private fun JsonObject.refs() = turns().map { it.str("ref") }
    private fun JsonObject.cut(side: String) = this["cut"]?.jsonObject?.get(side)?.jsonObject?.let {
        mapOf("words" to it["words"]!!.jsonPrimitive.int, "leftOut" to it["leftOut"]!!.jsonPrimitive.int)
    }

    // Paging

    /** No arguments: the five newest turns, as before paging, each with its reference, and where a read further back starts. */
    @Test
    fun noArgumentsIsTheFiveNewestEachWithItsRef() = runBlocking {
        val (context) = context(CallTargetState(target, turns = eight()))
        val value = obj(read(context).text)
        assertEquals(listOf("ask 4", "ask 5", "ask 6", "ask 7", "ask 8"), value.turns().map { it.str("user") })
        assertEquals(listOf("t:44", "t:55", "t:66", "t:77", "t:88"), value.refs())
        assertEquals(true, value["olderTurns"]!!.jsonPrimitive.boolean)
        assertEquals("t:33", value.str("continueFrom"))
    }

    /** Only a start: five back from it, given as a ref, as digits or as a JSON integer alike. */
    @Test
    fun fromAloneReadsFiveBackFromIt() = runBlocking {
        val (context) = context(CallTargetState(target, turns = eight()))
        for (from in listOf("\"t:66\"", "\"2\"", "2", "\" T:66 \"")) {
            val value = obj(read(context, ""","from":$from""").text)
            assertEquals(from, listOf("t:22", "t:33", "t:44", "t:55", "t:66"), value.refs())
            assertEquals(from, "t:11", value.str("continueFrom"))
        }
        val oldest = obj(read(context, ""","from":"t:33"""").text)
        assertEquals(listOf("t:11", "t:22", "t:33"), oldest.refs())
        assertEquals(false, oldest["olderTurns"]!!.jsonPrimitive.boolean)
        assertNull(oldest["continueFrom"])
    }

    /** Both: that range, its ends in either order; back past the oldest reads to the oldest; never more than fifty. */
    @Test
    fun fromAndBackToReadThatRange() = runBlocking {
        val (context, targets) = context(CallTargetState(target, turns = eight()))
        val range = obj(read(context, ""","from":"t:77","backTo":"t:22"""").text)
        assertEquals(listOf("t:22", "t:33", "t:44", "t:55", "t:66", "t:77"), range.refs())
        val reversed = obj(read(context, ""","from":"t:22","backTo":"t:77"""").text)
        assertEquals(range.refs(), reversed.refs())
        val all = obj(read(context, ""","from":0,"backTo":"100"""").text)
        assertEquals(8, all.turns().size)
        assertEquals(false, all["olderTurns"]!!.jsonPrimitive.boolean)
        targets.states["a"] = CallTargetState(target, turns = (1..80).map { CallTurn("x$it", "ask $it") })
        val capped = obj(read(context, ""","backTo":79""").text)
        assertEquals(CallRead.MAX_TURNS, capped.turns().size)
        assertEquals("ask 31", capped.turns().first().str("user"))
        assertEquals("t:30", capped.str("continueFrom"))
    }

    /** The message still waiting for an answer is the newest turn, 0 back, with its own ref; a read from further back leaves it out. */
    @Test
    fun theWaitingMessageIsTheNewestTurn() = runBlocking {
        val waiting = CallMessage("msg-9z", CallMessage.Role.User, "and now?", delivery = CallMessage.Delivery.Queued)
        val (context) = context(CallTargetState(target, turns = eight(), unanswered = waiting))
        val newest = obj(read(context).text)
        assertEquals(4, newest.turns().size)
        val pending = newest["pendingUserMessage"]!!.jsonObject
        assertEquals("t:9z", pending.str("ref"))
        assertEquals("and now?", pending.str("text"))
        assertEquals("queued", pending.str("delivery"))
        val back = obj(read(context, ""","from":1""").text)
        assertNull(back["pendingUserMessage"])
        assertEquals(listOf("t:44", "t:55", "t:66", "t:77", "t:88"), back.refs())
    }

    /** Two characters, or as many more as tell one ID from the others. */
    @Test
    fun refsGrowWhereTwoCharactersFitAnother() {
        assertEquals(listOf("t:a13f", "t:b13f", "t:77", "t:7"), CallRead.references(listOf("aa13f", "bb13f", "cc77", "7")))
        assertEquals(listOf("t:x13f", "t:13f"), CallRead.references(listOf("x13f", "13f")))
    }

    /** A ref that fits several turns or none, a conversation's ref, a start past the oldest and words that aren't a number are refused, each saying why. */
    @Test
    fun unclearArgumentsAreRefusedSayingWhy() = runBlocking {
        val (context) = context(CallTargetState(target, turns = listOf("aa13f", "bb13f", "cc77").map { CallTurn(it, "ask $it") }))
        val cases = listOf(
            ""","from":"t:3f"""" to "t:3f fits several turns: t:a13f, t:b13f. Use one of those.",
            ""","backTo":"t:zz"""" to "No turn t:zz in this conversation. Use a ref from one of its reads.",
            ""","from":"s1"""" to "s1 is a conversation's ref; from takes a turn's ref, such as t:3f, or a number of turns back.",
            ""","from":"3"""" to "from 3 is past the oldest of the 3 turns (0 to 2 back).",
            ""","from":"latest"""" to "from is a turn's ref from a read, such as t:3f, or a number of turns back from the newest (0 is the newest).",
            ""","backTo":-1""" to "backTo is a turn's ref from a read, such as t:3f, or a number of turns back from the newest (0 is the newest).",
            ""","words":"lots"""" to "words must be a number of words, 20 to 5000.",
        )
        for ((arguments, reason) in cases) {
            val result = read(context, arguments)
            assertTrue(arguments, result.isError)
            assertEquals(arguments, reason, obj(result.text).str("reason"))
        }
        val full = obj(read(context, ""","from":"t:a13f","backTo":"t:a13f"""").text)
        assertEquals(listOf("ask aa13f"), full.turns().map { it.str("user") })
    }

    // Exchanges

    private fun ask(id: String, text: String, delivery: Delivery = Delivery.Sent) = ConversationRow.User("$id:user", id, text, emptyList(), emptyList(), delivery)
    private fun said(key: String, text: String) = ConversationRow.Text(key, text, emptyList())
    private fun end(turn: String, reason: String = "completed", copy: String? = null) = ConversationRow.TurnEnd("$turn:end", turn, reason, 5, 0, copy)

    /** [rows] oldest first, published newest first as the conversation does, read by the call. */
    private fun state(rows: List<ConversationRow>, working: Boolean = true) =
        CallTargetState.from(ConversationState(created = true, loaded = true, working = working, rows = rows.asReversed()), target) { "Rate limited" }

    /**
     * Steering doesn't start a turn: the exchange keeps the message that started it, and its answer is the last words
     * of the run that ended it, as it ended. While it runs, its message is the one waiting.
     */
    @Test
    fun aSteeredExchangeIsOneTurnWithTheFirstMessageAndTheLastWords() = runBlocking {
        val steered = listOf(ask("ur1", "Fix the build"), said("a1:0", "Looking at the logs."), end("r1", "steering", "Looking at the logs."))
        val going = state(steered + ask("ur2", "And add a test") + said("a2:0", "On it"))
        assertEquals(emptyList<CallTurn>(), going.exchanges)
        assertEquals("ur1", going.unanswered?.id)
        assertEquals("Fix the build", going.unanswered?.text)
        // Queued on the phone before the run took it: still the first.
        assertEquals("ur1", state(listOf(ask("ur1", "Fix the build"), said("a1:0", "Looking"), ask("q", "and a test", Delivery.Sending))).unanswered?.id)
        val failure = ConversationRow.Failure("f", "f", FailureReason.RateLimited("Claude"), retryable = true, resolved = false)
        val done = state(steered + ask("ur2", "And add a test") + said("a2:0", "Fixed, with a test.") + failure + end("r2", "error", "Fixed, with a test."), working = false)
        assertEquals(listOf(CallTurn("r1", "Fix the build", "Fixed, with a test.", "error", "Rate limited")), done.exchanges)
        assertNull(done.unanswered)
        val (context) = context(done)
        val value = obj(read(context).text)
        assertEquals(listOf("t:r1"), value.refs())
        val turn = value.turns().single()
        assertEquals("Fix the build", turn.str("user"))
        assertEquals("Fixed, with a test.", turn.str("assistant"))
        assertEquals("error", turn.str("ended"))
        assertEquals("Rate limited", turn.str("error"))
    }

    /**
     * The agent's own runs after an answer go on with that exchange: its answer is their last words, or stays when
     * they have none. The person's steering of one starts a new exchange, the first having its answer.
     */
    @Test
    fun theAgentsOwnRunsGoOnWithTheExchangeBeforeThem() {
        val exchanges = CallTurn.exchanges(listOf(
            CallTurn("r1", "Start the subagent", "Started.", endedAt = 1),
            CallTurn("r2", reply = "It reported: all green.", endedAt = 2),
            CallTurn("r3", endedAt = 3),
            CallTurn("r4", "Deploy", "Deploying.", endedAt = 4),
            CallTurn("r5", reply = "Checking the rollout", ended = "steering", endedAt = 5),
            CallTurn("r6", "Stop it", "Stopped.", endedAt = 6),
        ))
        assertEquals(
            listOf(
                CallTurn("r1", "Start the subagent", "It reported: all green.", endedAt = 3),
                CallTurn("r4", "Deploy", "Deploying.", endedAt = 4),
                CallTurn("r6", "Stop it", "Stopped.", endedAt = 6),
            ),
            exchanges.answered,
        )
        assertFalse(exchanges.open)
        // An error answered, then the agent's own run answered again.
        assertEquals(listOf(CallTurn("r1", "go", "Recovered.")),
            CallTurn.exchanges(listOf(CallTurn("r1", "go", ended = "error", error = "Boom"), CallTurn("r2", reply = "Recovered."))).answered)
        // The oldest the phone has is the agent's own: no message, then the person's steering takes it.
        assertEquals(listOf(CallTurn("r1", "and?", "Done.")),
            CallTurn.exchanges(listOf(CallTurn("r1", reply = "Half", ended = "compaction"), CallTurn("r2", "and?", "Done."))).answered)
    }

    /**
     * Five turns back from the newest are five exchanges, each the person's message and the agent's last words,
     * however much came between: steered runs, the agent's own runs, a run with no words.
     */
    @Test
    fun fiveTurnsAreFiveExchangesWhateverCameBetween() = runBlocking {
        val runs = ArrayList<CallTurn>()
        for (n in 1..7) {
            runs += CallTurn("r${n}a", "ask $n", "commentary $n", "steering")
            runs += CallTurn("r${n}b", "steer $n", "answer $n")
            runs += CallTurn("r${n}c")
            if (n % 2 == 0) runs += CallTurn("r${n}d", reply = "later $n")
        }
        val waiting = CallMessage("u8", CallMessage.Role.User, "ask 8", delivery = CallMessage.Delivery.Accepted)
        val (context) = context(CallTargetState(target, turns = runs, unanswered = waiting))
        val value = obj(read(context, ""","backTo":"t:3a"""").text)
        assertEquals(listOf("t:3a", "t:4a", "t:5a", "t:6a", "t:7a"), value.refs())
        assertEquals(listOf("ask 3", "ask 4", "ask 5", "ask 6", "ask 7"), value.turns().map { it.str("user") })
        assertEquals(listOf("answer 3", "later 4", "answer 5", "later 6", "answer 7"), value.turns().map { it.str("assistant") })
        assertEquals(List(5) { "completed" }, value.turns().map { it.str("ended") })
        assertEquals("t:2a", value.str("continueFrom"))
        val newest = obj(read(context).text)
        assertEquals(listOf("ask 4", "ask 5", "ask 6", "ask 7"), newest.turns().map { it.str("user") })
        assertEquals("ask 8", newest["pendingUserMessage"]!!.jsonObject.str("text"))
        // The first context's turns are the same.
        assertEquals(listOf("answer 3", "later 4", "answer 5", "later 6", "answer 7"), CallContext.recent(CallTargetState(target, turns = runs)).map { it.reply })
    }

    // Words

    /** Past its words a message is cut in the middle, half its start and half its end, saying how many words it has and how many went; read again with more words, it comes whole. */
    @Test
    fun aMessagePastItsWordsIsCutInTheMiddleWithItsWholeSize() = runBlocking {
        val long = (1..1200).joinToString(" ") { "w$it" }
        val (context) = context(CallTargetState(target, turns = listOf(CallTurn("r1", "tell me all", long))))
        val turn = obj(read(context).text).turns().first()
        val expected = (1..250).map { "w$it" } + "… (700 words left out) …" + (951..1200).map { "w$it" }
        assertEquals(expected.joinToString(" "), turn.str("assistant"))
        assertEquals("tell me all", turn.str("user"))
        assertEquals(mapOf("words" to 1200, "leftOut" to 700), turn.cut("assistant"))
        assertNull(turn.cut("user"))
        val whole = obj(read(context, ""","from":"t:r1","words":2000""").text).turns().first()
        assertEquals(long, whole.str("assistant"))
        assertNull(whole["cut"])
        // Fewer than twenty is twenty, more than five thousand five thousand.
        val least = obj(read(context, ""","words":1""").text).turns().first()
        assertEquals(mapOf("words" to 1200, "leftOut" to 1180), least.cut("assistant"))
    }

    /** The cut itself: whole within its words and ten bytes a word; a text with no spaces cut between characters, half its bytes each side. */
    @Test
    fun theCutKeepsWholeWordsOrHalfTheBytes() {
        assertNull(CallRead.cut("a few words", 20))
        assertEquals("one … (3 words left out) … five", CallRead.cut("one two three four five", 2)?.text)
        val cut = CallRead.cut("x".repeat(600), 20)!!
        assertEquals("x".repeat(100) + " … (1 word left out) … " + "x".repeat(100), cut.text)
        assertEquals(1, cut.words)
        assertEquals(1, cut.leftOut)
        assertEquals("start … (1 word left out) … end", CallRead.cut("start " + "é".repeat(300) + " end", 20)?.text)
    }

    // The wire

    /** Within 56 KB as escaped on the wire: the oldest of the range give way first and `continueFrom` names the newest of those left out; a turn alone too big has its words halved until it fits. */
    @Test
    fun theWireLimitDropsTheOldestThenHalvesTheWords() = runBlocking {
        val heavy = "<<<< ".repeat(1600)
        val (context, targets) = context(CallTargetState(target, turns = eight { heavy }))
        val result = read(context, ""","backTo":7,"words":5000""")
        assertTrue(CallContext.escapedSize(result.text) <= CallContext.Limits.READ_BYTES)
        val value = obj(result.text)
        assertEquals(listOf("t:88"), value.refs())
        assertEquals(heavy, value.turns().first().str("assistant"))
        assertEquals("t:77", value.str("continueFrom"))
        targets.states["a"] = CallTargetState(target, turns = listOf(CallTurn("r1", heavy, heavy + heavy)))
        val alone = read(context, ""","words":5000""")
        assertTrue(CallContext.escapedSize(alone.text) <= CallContext.Limits.READ_BYTES)
        val turn = obj(alone.text).turns().first()
        assertEquals(3200, turn.cut("assistant")?.get("words"))
        assertEquals(1600, turn.cut("user")?.get("words"))
    }

    // Not current

    /** A read of a conversation that isn't current is paged as asked at once, marked `refreshing`; what the refresh finds new comes as one cue, its turns cut by the most words a read of it asked for. */
    @Test
    fun aNotCurrentReadIsPagedAtOnceAndItsUpdateCutAsRead() = runBlocking {
        val targets = FakeCallTargets(listOf(target), mutableMapOf("a" to CallTargetState(target, turns = eight(), fresh = false)), null)
        targets.refresh["a"] = FakeCallTargets.Refresh.After(150)
        val context = CallContext(targets, refreshMillis = 2_000)
        val cues = java.util.Collections.synchronizedList(ArrayList<String>())
        context.onReading { if (it is CallReading.Update) cues += it.cue.text }
        context.initial()
        val answer = obj(read(context, ""","from":"t:66","words":30""").text)
        assertEquals(true, answer["refreshing"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("t:22", "t:33", "t:44", "t:55", "t:66"), answer.refs())
        assertEquals("t:11", answer.str("continueFrom"))
        assertTrue(read(context, ""","from":"t:zz"""").isError)
        val long = (1..100).joinToString(" ") { "w$it" }
        targets.states["a"] = CallTargetState(target, turns = eight() + CallTurn("run-99", "more", long))
        withTimeout(5_000) { while (cues.isEmpty()) delay(20) }
        delay(100)
        assertEquals(1, cues.size)
        val update = obj(cues.first())
        assertEquals("conversation_update", update.str("event"))
        assertEquals(listOf("t:99"), update.refs())
        assertEquals(mapOf("words" to 100, "leftOut" to 70), update.turns().first().cut("assistant"))
        assertEquals("t:88", update.str("continueFrom"))
    }
}
