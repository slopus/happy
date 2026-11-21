package com.slopus.happy.conversation

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `/btw` threads a connection keeps (sideQuestionThreads.ts): one
 * question at a time per chat, a follow-up asked meanwhile in its turn with
 * the earlier answers as history, only close ends a thread and drops the
 * question it waits on, and nothing of it hangs on a screen.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SideThreadsTest {
    private val jobs = ArrayList<Job>()

    @After fun cancel() = jobs.forEach { it.cancel() }

    /** A computer answering the side question routes as each test says, recording every request. */
    private class Computer {
        val requests = ArrayList<Triple<String, String, JsonObject?>>()
        /** Each `POST`'s answer in turn: held until its gate opens, if it has one. */
        val posts = ArrayDeque<Pair<CompletableDeferred<Unit>?, () -> TransportResponse>>()
        /** Each `GET`'s answer in turn. */
        val gets = ArrayDeque<Pair<CompletableDeferred<Unit>?, () -> TransportResponse>>()

        val request: AgentRequest = { method, path, body, _ ->
            requests += Triple(method, path, body as? JsonObject)
            when (method) {
                "POST" -> posts.removeFirst().let { (gate, answer) -> gate?.await(); answer() }
                "GET" -> gets.removeFirst().let { (gate, answer) -> gate?.await(); answer() }
                "DELETE" -> TransportResponse(200, body = """{"cancelled":true}""".toByteArray())
                else -> error("unexpected $method $path")
            }
        }

        fun post(gate: CompletableDeferred<Unit>? = null, answer: () -> TransportResponse) = posts.addLast(gate to answer)
        fun get(gate: CompletableDeferred<Unit>? = null, answer: () -> TransportResponse) = gets.addLast(gate to answer)
        fun paths(method: String) = requests.filter { it.first == method }.map { it.second }
    }

    private fun answering(id: String) = TransportResponse(200, body = """{"sideQuestion":{"id":"$id","status":"answering"}}""".toByteArray())
    private fun answered(id: String, response: String?, synthetic: Boolean = false) = TransportResponse(
        200,
        body = """{"sideQuestion":{"id":"$id","status":"answered","response":${response?.let { "\"$it\"" } ?: "null"},"synthetic":$synthetic}}""".toByteArray(),
    )
    private fun refused(status: Int, code: String, error: String) = TransportResponse(status, body = """{"error":"$error","code":"$code"}""".toByteArray())

    private fun TestScope.threads(computer: Computer, online: StateFlow<Boolean> = MutableStateFlow(true)) = SideThreads(
        // Not backgroundScope: advanceUntilIdle leaves its work alone. Cancelled after each test.
        CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob().also { jobs += it }),
        ConversationApi(computer.request),
        online = online,
        retryDelayMillis = 1,
    )

    private fun SideThreads.answers(agentId: String = "a1") = threads.value[agentId]?.exchanges?.map { it.answer }

    @Test fun `a question's answer lands in its thread, read as Markdown`() = runTest {
        val computer = Computer()
        computer.post { answered("q1", "The retry loop in `uploader.ts`.") }
        val threads = threads(computer)
        threads.ask("a1", "  Which file?  ")
        assertEquals(listOf<SideAnswer>(SideAnswer.Asking), threads.answers())
        advanceUntilIdle()
        val answer = threads.answers()!!.single() as SideAnswer.Answered
        assertEquals("The retry loop in `uploader.ts`.", answer.response)
        assertTrue(answer.blocks.isNotEmpty())
        assertEquals("Which file?", threads.threads.value["a1"]!!.exchanges.single().question)
        assertEquals(listOf("/v0/agents/a1/side-questions"), computer.paths("POST"))
        assertEquals("Which file?", computer.requests.single().third!!["question"]!!.jsonPrimitive.content)
        assertNull("a first question has no history", computer.requests.single().third!!["history"])
    }

    @Test fun `one still answering is collected until it is answered`() = runTest {
        val computer = Computer()
        computer.post { answering("q1") }
        computer.get { answering("q1") }
        computer.get { answered("q1", "Retrying failed uploads.") }
        val threads = threads(computer)
        threads.ask("a1", "What are you working on?")
        advanceUntilIdle()
        assertEquals(listOf("/v0/agents/a1/side-questions/q1", "/v0/agents/a1/side-questions/q1"), computer.paths("GET"))
        assertEquals("Retrying failed uploads.", (threads.answers()!!.single() as SideAnswer.Answered).response)
        assertTrue("nothing to cancel once collected", computer.paths("DELETE").isEmpty())
    }

    @Test fun `a follow-up asked meanwhile waits its turn, then goes with the answers before it as history`() = runTest {
        val computer = Computer()
        val first = CompletableDeferred<Unit>()
        computer.post(first) { answered("q1", "Retrying failed uploads.") }
        computer.post { answered("q2", "uploader.ts") }
        val threads = threads(computer)
        threads.ask("a1", "What are you working on?")
        advanceUntilIdle()
        threads.ask("a1", "Which file?")
        advanceUntilIdle()
        assertEquals(listOf(SideAnswer.Asking, SideAnswer.Queued), threads.answers())
        assertEquals("one question at a time", 1, computer.paths("POST").size)
        first.complete(Unit)
        advanceUntilIdle()
        assertEquals(2, computer.paths("POST").size)
        val history = computer.requests.filter { it.first == "POST" }[1].third!!["history"]!!.jsonArray
        assertEquals(1, history.size)
        assertEquals("What are you working on?", history[0].jsonObject["question"]!!.jsonPrimitive.content)
        assertEquals("Retrying failed uploads.", history[0].jsonObject["response"]!!.jsonPrimitive.content)
        assertEquals(listOf("Retrying failed uploads.", "uploader.ts"), threads.answers()!!.map { (it as SideAnswer.Answered).response })
    }

    @Test fun `a canned answer, no answer and a notice are no history, and the newest fifty go`() {
        val turns = listOf(
            SideExchange("a", SideAnswer.Answered("first", synthetic = false)),
            SideExchange("b", SideAnswer.Answered("I can't answer that.", synthetic = true)),
            SideExchange("c", SideAnswer.Answered(null, synthetic = false)),
            SideExchange("d", SideAnswer.Notice(Problem.SideQuestionUnready)),
            SideExchange("e", SideAnswer.Failed(Problem.Said("Rate limited."))),
            SideExchange("f", SideAnswer.Answered("second", synthetic = false)),
        )
        assertEquals(listOf(SideTurn("a", "first"), SideTurn("f", "second")), SideThreads.history(turns))
        val many = (1..60).map { SideExchange("q$it", SideAnswer.Answered("r$it", synthetic = false)) }
        val sent = SideThreads.history(many)
        assertEquals(SideThreads.HISTORY_LIMIT, sent.size)
        assertEquals("q11", sent.first().question)
        assertEquals("q60", sent.last().question)
        // One the computer would refuse whole is left out.
        val long = "x".repeat(SideThreads.TEXT_LIMIT + 1)
        assertEquals(listOf(SideTurn("a", "first")), SideThreads.history(listOf(turns[0], SideExchange("long", SideAnswer.Answered(long, false)))))
    }

    @Test fun `close drops the question being answered on the computer, and the thread is gone`() = runTest {
        val computer = Computer()
        computer.post { answering("q1") }
        computer.get(CompletableDeferred()) { answered("q1", "Never seen.") }
        val threads = threads(computer)
        threads.ask("a1", "Which file?")
        advanceUntilIdle()
        assertEquals(listOf<SideAnswer>(SideAnswer.Asking), threads.answers())
        threads.close("a1")
        advanceUntilIdle()
        assertNull(threads.threads.value["a1"])
        assertEquals(listOf("/v0/agents/a1/side-questions/q1"), computer.paths("DELETE"))
    }

    @Test fun `closed while its first request is on its way, the question is dropped once the computer names it`() = runTest {
        val computer = Computer()
        val posted = CompletableDeferred<Unit>()
        computer.post(posted) { answering("q1") }
        val threads = threads(computer)
        threads.ask("a1", "Which file?")
        advanceUntilIdle()
        threads.close("a1")
        advanceUntilIdle()
        assertTrue("nothing to drop before the computer names it", computer.paths("DELETE").isEmpty())
        posted.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf("/v0/agents/a1/side-questions/q1"), computer.paths("DELETE"))
        assertTrue("never collected", computer.paths("GET").isEmpty())
        assertNull(threads.threads.value["a1"])
    }

    @Test fun `a thread opened again never takes the answer of the one closed`() = runTest {
        val computer = Computer()
        val old = CompletableDeferred<Unit>()
        computer.post(old) { answered("q1", "old") }
        computer.post { answered("q2", "new") }
        val threads = threads(computer)
        threads.ask("a1", "First?")
        advanceUntilIdle()
        threads.close("a1")
        threads.ask("a1", "Second?")
        advanceUntilIdle()
        old.complete(Unit)
        advanceUntilIdle()
        val exchange = threads.threads.value["a1"]!!.exchanges.single()
        assertEquals("Second?", exchange.question)
        assertEquals("new", (exchange.answer as SideAnswer.Answered).response)
    }

    @Test fun `each chat's thread asks on its own`() = runTest {
        val computer = Computer()
        val held = CompletableDeferred<Unit>()
        computer.post(held) { answered("q1", "one") }
        computer.post { answered("q2", "two") }
        val threads = threads(computer)
        threads.ask("a1", "One?")
        threads.ask("a2", "Two?")
        advanceUntilIdle()
        assertEquals("two", (threads.answers("a2")!!.single() as SideAnswer.Answered).response)
        assertEquals(listOf<SideAnswer>(SideAnswer.Asking), threads.answers("a1"))
        held.complete(Unit)
        advanceUntilIdle()
        assertEquals("one", (threads.answers("a1")!!.single() as SideAnswer.Answered).response)
    }

    @Test fun `leaving the chat leaves its thread running, and coming back shows what was answered meanwhile`() = runTest {
        val computer = Computer()
        val held = CompletableDeferred<Unit>()
        computer.post { answering("q1") }
        computer.get(held) { answered("q1", "Retrying failed uploads.") }
        val threads = threads(computer)
        // The chat's screen follows its thread, then goes.
        val seen = ArrayList<SideThread?>()
        val screen = launch { threads.thread("a1").collect { seen += it } }
        threads.ask("a1", "What are you working on?")
        advanceUntilIdle()
        screen.cancel()
        held.complete(Unit)
        advanceUntilIdle()
        assertEquals("Retrying failed uploads.", (threads.answers()!!.single() as SideAnswer.Answered).response)
        // The chat shown again starts from the thread as it is.
        assertEquals("Retrying failed uploads.", ((threads.thread("a1").first()!!.exchanges.single().answer) as SideAnswer.Answered).response)
        assertTrue(seen.last()!!.exchanges.single().answer is SideAnswer.Asking)
        assertTrue(computer.paths("DELETE").isEmpty())
    }

    @Test fun `the follow-up being typed is kept with the thread and asked from it`() = runTest {
        val computer = Computer()
        computer.post { answered("q1", "one") }
        computer.post { answered("q2", "two") }
        val threads = threads(computer)
        threads.setDraft("a1", "no thread, nothing kept")
        assertNull(threads.threads.value["a1"])
        threads.ask("a1", "One?")
        advanceUntilIdle()
        threads.setDraft("a1", "  Two?  ")
        assertEquals("  Two?  ", threads.threads.value["a1"]!!.draft)
        threads.askDraft("a1")
        assertEquals("", threads.threads.value["a1"]!!.draft)
        advanceUntilIdle()
        assertEquals(listOf("One?", "Two?"), threads.threads.value["a1"]!!.exchanges.map { it.question })
        // Nothing typed asks nothing.
        threads.askDraft("a1")
        threads.ask("a1", "   ")
        assertEquals(2, threads.threads.value["a1"]!!.exchanges.size)
    }

    @Test fun `each refusal reads as the person can act on it`() = runTest {
        val computer = Computer()
        computer.post { refused(409, "harness_not_running", "No conversation to answer from yet.") }
        computer.post { refused(501, "unsupported", "This model answers no side questions.") }
        computer.post { answering("q3") }
        computer.get { refused(404, "not_found", "Side question not found.") }
        computer.post { TransportResponse(200, body = """{"sideQuestion":{"id":"q4","status":"failed","error":"Rate limited."}}""".toByteArray()) }
        computer.post { refused(503, "unavailable", "The harness is restarting.") }
        computer.post { refused(409, "conflict", "Busy.") }
        val threads = threads(computer)
        listOf("One?", "Two?", "Three?", "Four?", "Five?", "Six?").forEach { threads.ask("a1", it) }
        advanceUntilIdle()
        assertEquals(
            listOf(
                SideAnswer.Notice(Problem.SideQuestionUnready),
                SideAnswer.Notice(Problem.SideQuestionUnsupported),
                SideAnswer.Notice(Problem.SideQuestionGone),
                SideAnswer.Failed(Problem.Said("Rate limited.")),
                // A daemon's own fault on the first request is said, never asked again: a second would be a second question.
                SideAnswer.Failed(Problem.Said("The harness is restarting.")),
                // A 409 that isn't harness_not_running is the daemon's words.
                SideAnswer.Failed(Problem.Said("Busy.")),
            ),
            threads.answers(),
        )
        assertEquals(6, computer.paths("POST").size)
    }

    @Test fun `offline, a question says so at once and nothing is asked`() = runTest {
        val computer = Computer()
        val online = MutableStateFlow(false)
        computer.post { answered("q1", "Here.") }
        val threads = threads(computer, online)
        threads.ask("a1", "Which file?")
        threads.ask("a1", "And then?")
        val offline = SideAnswer.Notice(Problem.Link(AgentConnectionException.Reason.Unavailable))
        assertEquals(listOf(offline, offline), threads.answers())
        assertTrue(computer.requests.isEmpty())
        online.value = true
        threads.ask("a1", "Now?")
        advanceUntilIdle()
        assertEquals("Here.", (threads.answers()!!.last() as SideAnswer.Answered).response)
        // A link lost on the way says the same.
        computer.post { throw AgentConnectionException(AgentConnectionException.Reason.Unavailable) }
        threads.ask("a1", "Still there?")
        advanceUntilIdle()
        assertEquals(offline, threads.answers()!!.last())
    }

    @Test fun `collecting is asked again after a transient failure`() = runTest {
        val computer = Computer()
        computer.post { answering("q1") }
        computer.get { refused(503, "unavailable", "Restarting.") }
        // The link still says it is up, but this request didn't get through.
        computer.get { throw AgentConnectionException(AgentConnectionException.Reason.Unavailable) }
        computer.get { answered("q1", "Back.") }
        val threads = threads(computer)
        threads.ask("a1", "One?")
        advanceUntilIdle()
        assertEquals("Back.", (threads.answers()!!.single() as SideAnswer.Answered).response)
        assertEquals(3, computer.paths("GET").size)
        assertTrue(computer.paths("DELETE").isEmpty())
    }

    @Test fun `a link that drops while Claude answers is waited for, and the answer still lands`() = runTest {
        val computer = Computer()
        val online = MutableStateFlow(true)
        computer.post { answering("q1") }
        computer.get {
            online.value = false
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        }
        computer.get { answered("q1", "Still here.") }
        val threads = threads(computer, online)
        threads.ask("a1", "Which file?")
        // A minute without the link: nothing is asked meanwhile, and the question is still being answered.
        advanceTimeBy(60_000)
        assertEquals(1, computer.paths("GET").size)
        assertEquals(listOf<SideAnswer>(SideAnswer.Asking), threads.answers())
        online.value = true
        advanceTimeBy(SideThreads.MAX_RETRY_DELAY_MILLIS)
        runCurrent()
        assertEquals("Still here.", (threads.answers()!!.single() as SideAnswer.Answered).response)
        assertTrue(computer.paths("DELETE").isEmpty())
    }

    @Test fun `ten minutes without the answer, the question is let go, on the computer too`() = runTest {
        val computer = Computer()
        val online = MutableStateFlow(true)
        computer.post { answering("q1") }
        computer.get {
            online.value = false
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        }
        val threads = threads(computer, online)
        threads.ask("a1", "Which file?")
        advanceTimeBy(SideThreads.EXPIRY_MILLIS - 1_000)
        assertEquals(listOf<SideAnswer>(SideAnswer.Asking), threads.answers())
        assertTrue(computer.paths("DELETE").isEmpty())
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(listOf<SideAnswer>(SideAnswer.Notice(Problem.SideQuestionGone)), threads.answers())
        assertEquals(listOf("/v0/agents/a1/side-questions/q1"), computer.paths("DELETE"))
    }

    @Test fun `a refusal while collecting reads as one while asking, and a question given up on is dropped there`() = runTest {
        val computer = Computer()
        computer.post { answering("q1") }
        computer.get { refused(409, "harness_not_running", "The conversation was compacted.") }
        computer.post { answering("q2") }
        computer.get { refused(501, "unsupported", "This model answers no side questions.") }
        computer.post { answering("q3") }
        computer.get { refused(400, "bad_request", "Bad side question id.") }
        computer.post { answering("q4") }
        computer.get { refused(404, "not_found", "Side question not found.") }
        val threads = threads(computer)
        listOf("One?", "Two?", "Three?", "Four?").forEach { threads.ask("a1", it) }
        advanceUntilIdle()
        assertEquals(
            listOf(
                SideAnswer.Notice(Problem.SideQuestionUnready),
                SideAnswer.Notice(Problem.SideQuestionUnsupported),
                SideAnswer.Failed(Problem.Said("Bad side question id.")),
                SideAnswer.Notice(Problem.SideQuestionGone),
            ),
            threads.answers(),
        )
        // One the computer let go of already needs nothing.
        assertEquals(listOf("q1", "q2", "q3").map { "/v0/agents/a1/side-questions/$it" }, computer.paths("DELETE"))
    }

    @Test fun `a canned answer is kept as said, and blank words are no answer`() = runTest {
        val computer = Computer()
        computer.post { answered("q1", "I can't answer that here.", synthetic = true) }
        computer.post { answered("q2", "   ") }
        computer.post { answered("q3", null) }
        val threads = threads(computer)
        listOf("One?", "Two?", "Three?").forEach { threads.ask("a1", it) }
        advanceUntilIdle()
        assertEquals(
            listOf(
                SideAnswer.Answered("I can't answer that here.", synthetic = true),
                SideAnswer.Answered(null, synthetic = false),
                SideAnswer.Answered(null, synthetic = false),
            ),
            threads.answers(),
        )
    }
}
