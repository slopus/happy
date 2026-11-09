package com.slopus.happy.conversation.ui

import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.conversation.Delivery
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Suggested replies through a conversation (happy-agent API.md "Quick
 * replies"): pills under the latest agent message until a person's
 * message follows, and a tap an ordinary send naming the option.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class QuickRepliesConversationTest {
    private val signals = MutableSharedFlow<ConversationSignal>(extraBufferCapacity = 64)
    private val jobs = ArrayList<Job>()
    private val requests = ArrayList<Pair<String, JsonObject?>>()

    /** What `POST …/send` answers, once let go. */
    private var sends: suspend (JsonObject) -> TransportResponse = { body -> ok("""{"message":${person(body["id"]!!.toString().trim('"'), body["text"]!!.toString().trim('"'), body["quickReply"]?.toString(), "pending")}}""") }
    private var page = runs(SUGGESTED)

    @After fun cancel() = jobs.forEach { it.cancel() }

    private val request: AgentRequest = { _, path, body, _ ->
        val route = path.substringBefore('?')
        requests += route to (body as? JsonObject)
        when {
            route.endsWith("/bootstrap") -> ok("""{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Onboarding"},"mode":$MODE,"draft":{"value":null,"updatedAt":null},"pending":[]}""")
            route.endsWith("/messages") -> ok(page)
            route.endsWith("/send") -> sends(body as JsonObject)
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

    private fun Conversation.replies(): ConversationRow.Replies? = state.value.rows.filterIsInstance<ConversationRow.Replies>().singleOrNull()

    @Test fun `a suggest_replies call's options are pills under its message, and a tap sends the option naming it`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val answer = sends
        sends = { body -> gate.await(); answer(body) }
        val chat = conversation()
        advanceUntilIdle()
        val replies = chat.replies()!!
        assertEquals(listOf("Fix the login redirect", "Run the tests"), replies.options)
        // Under the message's words, though the call came first; newest first, so just before them.
        val rows = chat.state.value.rows
        assertEquals(rows.indexOfFirst { it is ConversationRow.Text } - 1, rows.indexOf(replies))
        assertTrue("no tool line for the call", rows.none { it is ConversationRow.Tool })

        assertTrue(chat.sendReply(replies, 1))
        runCurrent()
        val body = requests.last { it.first.endsWith("/send") }.second!!
        assertEquals("\"Run the tests\"", body["text"].toString())
        assertEquals("""{"messageId":"m1","toolCallId":"c1","index":1}""", body["quickReply"].toString())
        val bubble = chat.state.value.rows.first() as ConversationRow.User
        assertEquals("Run the tests", bubble.text)
        assertTrue(bubble.suggested)
        assertEquals(Delivery.Sending, bubble.delivery)
        // Sent, they go at once.
        assertEquals(null, chat.replies())

        gate.complete(Unit)
        advanceUntilIdle()
        val sent = chat.state.value.rows.first() as ConversationRow.User
        assertTrue("the echo keeps where it came from", sent.suggested)
        assertEquals(null, chat.replies())
        assertEquals("", chat.state.value.draft)
    }

    @Test fun `a block's options send without a tool call`() = runTest {
        page = runs(OPENING)
        val chat = conversation()
        advanceUntilIdle()
        val replies = chat.replies()!!
        assertEquals(listOf("Look at my recent work", "Skip for now"), replies.options)
        chat.sendReply(replies, 0)
        advanceUntilIdle()
        assertEquals("""{"messageId":"m0","index":0}""", requests.last { it.first.endsWith("/send") }.second!!["quickReply"].toString())
    }

    @Test fun `only the latest agent message's replies show, and a person's message after them hides them`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OPENING]},
            {"id":"r2","status":"completed","startedAt":4,"endedAt":6,"messages":[${person("t1", "Hi", null)},$SUGGESTED]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertEquals("m1", chat.replies()!!.messageId)
        signals.emit(event("message.created", """{"message":${person("t2", "Something else", null, "pending")}}"""))
        advanceUntilIdle()
        assertEquals(null, chat.replies())
        assertFalse((chat.state.value.rows.first() as ConversationRow.User).suggested)
    }

    @Test fun `a person's message sent from a reply elsewhere says so`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$SUGGESTED]},
            {"id":"r2","status":"completed","startedAt":4,"endedAt":6,"messages":[${person("p1", "Run the tests", """{"messageId":"m1","toolCallId":"c1","index":1}""")}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertTrue(chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().suggested)
        assertEquals(null, chat.replies())
    }

    @Test fun `an attempt record's run is no turn, and a run going on goes on`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[${LiveUiConversationTest.OFFER}]},
            {"id":"r9","status":"completed","startedAt":5,"endedAt":5,"messages":[${LiveUiConversationTest.record("\"k1\"", "rejected", reason = "Invites are off here.")}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertTrue(chat.state.value.rows.none { it is ConversationRow.TurnEnd && it.turn == "r9" })
        signals.emit(event("run.started", """{"run":{"id":"r10","status":"running","startedAt":7},"acceptedMessageIds":[]}"""))
        signals.emit(event("run.finished", """{"run":{"id":"r11","status":"completed","startedAt":8,"endedAt":8,"reason":"completed"}}"""))
        signals.emit(event("message.created", """{"runId":"r11","message":${LiveUiConversationTest.record("\"k2\"", "pending")}}"""))
        advanceUntilIdle()
        assertTrue(chat.state.value.working)
        assertTrue(chat.state.value.rows.filterIsInstance<ConversationRow.Ui>().single().work.pending)
    }

    private fun event(type: String, payload: String) = ConversationSignal.Event(type, Json.parseToJsonElement(payload).jsonObject)

    companion object {
        const val MODE = """{"providerId":"claude","modelId":"anthropic/opus-5","effort":"high","serviceTier":null,"permissionMode":"auto"}"""

        /** An agent message that suggests replies with a suggest_replies call, then asks in words. */
        const val SUGGESTED = """{"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[
            {"type":"text","text":"What next?"},
            {"type":"tool_call","id":"c1","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Fix the login redirect","Run the tests"]}}]}"""

        /** The daemon's own opening, with replies in a block. */
        const val OPENING = """{"id":"m0","role":"agent","createdAt":1,"metadata":{},"content":[
            {"type":"text","text":"Hi! Shall I look around?"},{"type":"quick_replies","options":["Look at my recent work","Skip for now"]}]}"""

        fun person(id: String, text: String, quickReply: String?, status: String = "accepted"): String =
            """{"id":"$id","role":"user","status":"$status","createdAt":4,"metadata":{},"content":[{"type":"text","text":"$text"}]${quickReply?.let { ""","quickReply":$it""" } ?: ""}}"""

        fun runs(vararg messages: String) = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[${messages.joinToString(",")}]}],"hasMore":false}"""

        fun ok(text: String) = TransportResponse(200, body = text.toByteArray())
    }
}
