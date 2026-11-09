package com.slopus.happy.conversation.ui

import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.UiAnswer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A chat UI press through a conversation (happy-agent API.md "Chat UI"):
 * drawn at once as the person's words, sent to the actions route under
 * its own id, then the person's message or a greyed refusal.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatUiConversationTest {
    private val signals = MutableSharedFlow<ConversationSignal>(extraBufferCapacity = 64)
    private val jobs = ArrayList<Job>()
    private val requests = ArrayList<Pair<String, JsonObject?>>()

    /** What `POST …/actions` answers, once let go. */
    private var actions: suspend (JsonObject) -> TransportResponse = { TransportResponse(404, body = """{"error":"No such offer.","code":"not_found"}""".toByteArray()) }
    private var page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OFFER]}],"hasMore":false}"""

    @After fun cancel() = jobs.forEach { it.cancel() }

    private val request: AgentRequest = { method, path, body, _ ->
        requests += path.substringBefore('?') to (body as? JsonObject)
        val route = path.substringBefore('?')
        when {
            route.endsWith("/bootstrap") -> ok("""{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Pick"},"mode":$MODE,"draft":{"value":null,"updatedAt":null},"pending":[]}""")
            route.endsWith("/messages") -> ok(page)
            route.endsWith("/actions") -> actions(body as JsonObject)
            else -> ok("{}")
        }
    }

    private fun TestScope.conversation() = Conversation(
        api = ConversationApi(request),
        signals = signals,
        scope = CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob().also { jobs += it }),
        agentId = "a1",
        lane = StandardTestDispatcher(testScheduler),
        io = StandardTestDispatcher(testScheduler),
        now = { 1000 },
        retryDelayMillis = 1,
        record = {},
        errorShown = { _, _ -> },
    ).also { it.start() }

    private fun Conversation.ui(): ConversationRow.Ui = state.value.rows.filterIsInstance<ConversationRow.Ui>().single()

    private fun Conversation.press(optionId: String) {
        val row = ui()
        act(row.offer, row.component, UiAction.choose(optionId))
    }

    @Test fun `a press is the person's words at once, then the message it became`() = runTest {
        val gate = CompletableDeferred<Unit>()
        actions = { body ->
            gate.await()
            ok("""{"record":${record(body["id"].toString(), "accepted", messageId = "p1")},"message":$PERSON,"result":null,"cursor":"c2"}""")
        }
        val chat = conversation()
        advanceUntilIdle()
        assertEquals(UiAnswer.Open, chat.ui().answer)
        chat.press("a")
        runCurrent()
        val bubble = chat.state.value.rows.first() as ConversationRow.User
        assertEquals("Go with A", bubble.text)
        assertEquals(Delivery.Sending, bubble.delivery)
        assertEquals(UiAnswer.Sending(UiAction.choose("a")), chat.ui().answer)
        val sent = requests.last { it.first.endsWith("/actions") }
        assertEquals("/v0/agents/a1/actions", sent.first)
        val body = sent.second!!
        assertEquals(listOf("id", "messageId", "uiId", "componentId", "action", "mode"), body.keys.toList())
        assertEquals("\"m1\"", body["messageId"].toString())
        assertEquals("\"u1\"", body["uiId"].toString())
        assertEquals("\"pick\"", body["componentId"].toString())
        assertEquals("""{"type":"choice.choose","payload":{"optionId":"a"}}""", body["action"].toString())

        gate.complete(Unit)
        advanceUntilIdle()
        val rows = chat.state.value.rows
        assertEquals(listOf("p1:user"), rows.filterIsInstance<ConversationRow.User>().map { it.key })
        assertEquals("Go with A", (rows.first() as ConversationRow.User).text)
        assertEquals(UiAnswer.Answered(UiAction.choose("a")), chat.ui().answer)
        assertTrue(rows.none { it is ConversationRow.Unsent })
    }

    @Test fun `the press's record arriving still pending keeps its bubble`() = runTest {
        val gate = CompletableDeferred<Unit>()
        var id = ""
        actions = { body ->
            id = body["id"].toString().trim('"')
            gate.await()
            ok("""{"record":${record("\"$id\"", "accepted", messageId = "p1")},"message":$PERSON,"result":null}""")
        }
        val chat = conversation()
        advanceUntilIdle()
        chat.press("a")
        runCurrent()
        signals.emit(event("message.created", """{"message":${record("\"$id\"", "pending")}}"""))
        advanceUntilIdle()
        assertEquals("Go with A", (chat.state.value.rows.first() as ConversationRow.User).text)
        assertEquals(id, (chat.state.value.rows.first() as ConversationRow.User).messageId)
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals("p1", (chat.state.value.rows.first() as ConversationRow.User).messageId)
    }

    @Test fun `a refused press stays as its words greyed, with why`() = runTest {
        actions = { body -> ok("""{"record":${record(body["id"].toString(), "rejected", option = "b", reason = "Already answered")},"message":null,"result":null}""") }
        val chat = conversation()
        advanceUntilIdle()
        chat.press("b")
        advanceUntilIdle()
        val rows = chat.state.value.rows
        assertTrue(rows.none { it is ConversationRow.User })
        val unsent = rows.first() as ConversationRow.Unsent
        assertEquals("Go with B", unsent.text)
        assertEquals("Already answered", unsent.record.outcome.reason)
        // Nothing accepted: the offer stays open.
        assertEquals(UiAnswer.Open, chat.ui().answer)
    }

    @Test fun `an offer answered elsewhere is closed on what was sent`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OFFER,${record("\"k1\"", "accepted", option = "b", messageId = "p1")},${PERSON.replace("Go with A", "Go with B").replace("\"a\"}", "\"b\"}")}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertEquals(UiAnswer.Answered(UiAction.choose("b")), chat.ui().answer)
        assertEquals(listOf("Go with B"), chat.state.value.rows.filterIsInstance<ConversationRow.User>().map { it.text })
    }

    @Test fun `a press refused outright fails its bubble, and Discard leaves the composer alone`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        chat.press("a")
        advanceUntilIdle()
        val failed = chat.state.value.rows.first() as ConversationRow.User
        assertTrue(failed.delivery is Delivery.Failed)
        assertEquals(UiAnswer.Open, chat.ui().answer)
        chat.discardSend(failed.messageId)
        advanceUntilIdle()
        assertTrue(chat.state.value.rows.none { it is ConversationRow.User })
        assertEquals("", chat.state.value.draft)
    }

    @Test fun `an offer pressed from here goes once at a time`() = runTest {
        val gate = CompletableDeferred<Unit>()
        actions = { body -> gate.await(); ok("""{"record":${record(body["id"].toString(), "accepted", messageId = "p1")},"message":$PERSON,"result":null}""") }
        val chat = conversation()
        advanceUntilIdle()
        val row = chat.ui()
        chat.act(row.offer, row.component, UiAction.choose("a"))
        chat.act(row.offer, row.component, UiAction.choose("b"))
        runCurrent()
        assertEquals(1, chat.state.value.rows.count { it is ConversationRow.User })
        assertNull(requests.lastOrNull { it.first.endsWith("/actions") && it.second?.get("action").toString().contains("\"b\"") })
        gate.complete(Unit)
        advanceUntilIdle()
    }

    @Test fun `a person's message after an unanswered offer closes it`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OFFER]},
            {"id":"r2","status":"completed","startedAt":4,"endedAt":6,"messages":[{"id":"t1","role":"user","createdAt":4,"metadata":{},"content":[{"type":"text","text":"Something else"}]}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertEquals(UiAnswer.Closed, chat.ui().answer)
    }

    @Test fun `a refused press's record run is no turn, and a run going on goes on`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OFFER]},
            {"id":"r9","status":"completed","startedAt":5,"endedAt":5,"messages":[${record("\"k1\"", "rejected", reason = "Already answered")}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        val rows = chat.state.value.rows
        assertTrue(rows.first() is ConversationRow.Unsent)
        assertTrue(rows.none { it is ConversationRow.TurnEnd && it.turn == "r9" })
        // A model turn starts; another press is refused meanwhile, in a run of its own.
        signals.emit(event("run.started", """{"run":{"id":"r10","status":"running","startedAt":7},"acceptedMessageIds":[]}"""))
        signals.emit(event("run.finished", """{"run":{"id":"r11","status":"completed","startedAt":8,"endedAt":8,"reason":"completed"}}"""))
        signals.emit(event("message.created", """{"runId":"r11","message":${record("\"k2\"", "rejected", option = "b", reason = "Already answered")}}"""))
        advanceUntilIdle()
        assertTrue(chat.state.value.working)
        assertEquals(listOf("Go with B", "Go with A"), chat.state.value.rows.filterIsInstance<ConversationRow.Unsent>().map { it.text })
    }

    private fun event(type: String, payload: String) = ConversationSignal.Event(type, Json.parseToJsonElement(payload).jsonObject)

    companion object {
        const val MODE = """{"providerId":"claude","modelId":"anthropic/opus-5","effort":"high","serviceTier":null,"permissionMode":"auto"}"""

        /** An agent message whose show_ui call offers a choice. */
        const val OFFER = """{"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[
            {"type":"tool_call","id":"c1","name":"show_ui","status":"completed","presentation":{"type":"ui","items":[],"ui":{"id":"u1","components":[
              {"id":"pick","type":"choice","fallback":"Go with A · Go with B","props":{"options":[{"id":"a","label":"Go with A"},{"id":"b","label":"Go with B","primary":true}]}}
            ]}}}]}"""

        /** The person's message a press of "a" became. */
        const val PERSON = """{"id":"p1","role":"user","status":"pending","createdAt":4,"metadata":{},"content":[{"type":"text","text":"Go with A"},
            {"type":"action","messageId":"m1","uiId":"u1","componentId":"pick","action":{"type":"choice.choose","payload":{"optionId":"a"}},"outcome":{"status":"accepted"}}]}"""

        /** [id] as JSON (quoted). */
        fun record(id: String, status: String, option: String = "a", reason: String? = null, messageId: String? = null): String {
            val outcome = buildString {
                append("""{"status":"$status"""")
                reason?.let { append(""","code":"offer_closed","reason":"$it"""") }
                messageId?.let { append(""","messageId":"$it"""") }
                append("}")
            }
            return """{"id":$id,"role":"service","createdAt":3,"metadata":{},"content":[{"type":"action","messageId":"m1","uiId":"u1","componentId":"pick",
                "action":{"type":"choice.choose","payload":{"optionId":"$option"}},"outcome":$outcome}]}"""
        }

        fun ok(text: String) = TransportResponse(200, body = text.toByteArray())
    }
}
