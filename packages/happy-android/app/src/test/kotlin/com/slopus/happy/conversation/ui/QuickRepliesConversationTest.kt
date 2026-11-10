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
 * Suggested replies through a conversation (STAGE1-CONTRACT "Quick
 * replies"): each stack under all its turn's agent wrote before a person's
 * message, for good, the option sent marked from `quickReply`, only the
 * newest tappable until someone writes; a tap an ordinary steered send
 * naming the option.
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

    private fun Conversation.stacks() = state.value.rows.filterIsInstance<ConversationRow.Replies>()
    private fun Conversation.replies(): ConversationRow.Replies = stacks().single()
    private fun sent() = requests.filter { it.first.endsWith("/send") }.map { it.second!! }

    @Test fun `a suggest_replies call's options stand under its message, and a tap sends the option naming it`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val answer = sends
        sends = { body -> gate.await(); answer(body) }
        val chat = conversation()
        advanceUntilIdle()
        val replies = chat.replies()
        assertEquals(listOf("Fix the login redirect", "Run the tests"), replies.options)
        assertTrue(replies.live)
        assertEquals(null, replies.chosen)
        // Under the message's words, though the call came first; newest first, so just before them.
        val rows = chat.state.value.rows
        assertEquals(rows.indexOfFirst { it is ConversationRow.Text } - 1, rows.indexOf(replies))
        assertTrue("no tool line for the call", rows.none { it is ConversationRow.Tool })

        chat.sendReply(replies, 1)
        runCurrent()
        val body = sent().single()
        assertEquals("\"Run the tests\"", body["text"].toString())
        assertEquals("""{"messageId":"m1","toolCallId":"c1","index":1}""", body["quickReply"].toString())
        assertEquals("\"steer\"", body["delivery"].toString())
        val bubble = chat.state.value.rows.first() as ConversationRow.User
        assertEquals("Run the tests", bubble.text)
        assertTrue(bubble.suggested)
        assertEquals(Delivery.Sending, bubble.delivery)
        // Sent, they stay where they were, the option sent marked, and take no more taps.
        assertEquals(replies.copy(chosen = 1, live = false), chat.replies())
        assertEquals(rows.indexOf(replies) + 1, chat.state.value.rows.indexOf(chat.replies()))
        chat.sendReply(replies, 0)
        chat.sendReply(chat.replies(), 0)
        runCurrent()
        assertEquals("a second tap sends nothing", 1, sent().size)

        gate.complete(Unit)
        advanceUntilIdle()
        val echoed = chat.state.value.rows.first() as ConversationRow.User
        assertTrue("the echo keeps where it came from", echoed.suggested)
        assertEquals("marked from the message's quickReply", 1, chat.replies().chosen)
        assertFalse(chat.replies().live)
        assertEquals("", chat.state.value.draft)
    }

    @Test fun `a block's options send without a tool call`() = runTest {
        page = runs(OPENING)
        val chat = conversation()
        advanceUntilIdle()
        val replies = chat.replies()
        assertEquals(listOf("Look at my recent work", "Skip for now"), replies.options)
        chat.sendReply(replies, 0)
        advanceUntilIdle()
        assertEquals("""{"messageId":"m0","index":0}""", sent().single()["quickReply"].toString())
    }

    @Test fun `an option that is not there sends nothing`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        chat.sendReply(chat.replies(), 2)
        advanceUntilIdle()
        assertTrue(sent().isEmpty())
        assertTrue(chat.replies().live)
    }

    @Test fun `a reply that could not be sent leaves the composer's draft alone when it is discarded`() = runTest {
        sends = { TransportResponse(400, body = """{"error":"Refused."}""".toByteArray()) }
        val chat = conversation()
        advanceUntilIdle()
        chat.sendReply(chat.replies(), 0)
        advanceUntilIdle()
        val failed = chat.state.value.rows.first() as ConversationRow.User
        assertTrue(failed.delivery is Delivery.Failed)
        chat.discardSend(failed.messageId)
        advanceUntilIdle()
        assertEquals("", chat.state.value.draft)
        assertTrue(chat.state.value.rows.none { it is ConversationRow.User })
        assertTrue("with nothing on its way, the stack takes a tap again", chat.replies().live)
        assertEquals(null, chat.replies().chosen)
    }

    @Test fun `every stack stays, only the newest takes a tap, and only until someone writes`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OPENING]},
            {"id":"r2","status":"completed","startedAt":4,"endedAt":6,"messages":[${person("t1", "Look at my recent work", """{"messageId":"m0","index":0}""")},$SUGGESTED]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        val stacks = { chat.stacks().associateBy { it.messageId } }
        assertEquals(setOf("m0", "m1"), stacks().keys)
        assertEquals(0, stacks().getValue("m0").chosen)
        assertFalse(stacks().getValue("m0").live)
        assertTrue(stacks().getValue("m1").live)
        signals.emit(event("message.created", """{"message":${person("t2", "Something else", null, "pending")}}"""))
        advanceUntilIdle()
        assertEquals(setOf("m0", "m1"), stacks().keys)
        assertFalse(stacks().getValue("m1").live)
        assertEquals(null, stacks().getValue("m1").chosen)
        assertFalse((chat.state.value.rows.first() as ConversationRow.User).suggested)
    }

    @Test fun `a steer and its answer in the same turn go under the stack, which stays above how the turn ended`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":9,"messages":[$SUGGESTED,
            ${person("p1", "Run the tests", """{"messageId":"m1","toolCallId":"c1","index":1}""")},
            {"id":"m2","role":"agent","createdAt":5,"metadata":{},"content":[{"type":"text","text":"Running them now."}]}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        chat.toggleTurn("r1")
        advanceUntilIdle()
        // Oldest first: the words that offered them, the stack, the steer, its answer, how the turn ended.
        val rows = chat.state.value.rows.asReversed().filter { it !is ConversationRow.Trace }
        assertEquals(listOf("m1:0", "m1:1", "p1:user", "m2:0", "r1:status"), rows.map { it.key })
        assertEquals(1, (rows[1] as ConversationRow.Replies).chosen)
    }

    @Test fun `words the agent goes on with before anyone writes come above the stack`() = runTest {
        page = """{"runs":[{"id":"r1","status":"running","startedAt":1,"messages":[$SUGGESTED,
            {"id":"m2","role":"agent","createdAt":5,"metadata":{},"content":[{"type":"text","text":"Or tell me something else."}]}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertEquals(listOf("m1:0", "m2:0", "m1:1"), chat.state.value.rows.asReversed().map { it.key })
        assertTrue(chat.replies().live)
    }

    @Test fun `a folded turn keeps its stack under the words that offered it`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":9,"messages":[
            {"id":"m0","role":"agent","createdAt":1,"metadata":{},"content":[{"type":"tool_call","id":"t0","name":"shell","status":"completed","arguments":{"command":"ls"}}]},
            $SUGGESTED]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        val keys = chat.state.value.rows.asReversed().map { it.key }
        assertTrue(keys.toString(), keys.containsAll(listOf("m1:0", "m1:1", "r1:status")))
        assertEquals(keys.indexOf("m1:0") + 1, keys.indexOf("m1:1"))
        assertEquals(keys.indexOf("m1:1") + 1, keys.indexOf("r1:status"))
    }

    @Test fun `a person's message sent from a reply elsewhere says so`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$SUGGESTED]},
            {"id":"r2","status":"completed","startedAt":4,"endedAt":6,"messages":[${person("p1", "Run the tests", """{"messageId":"m1","toolCallId":"c1","index":1}""")}]}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertTrue(chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().suggested)
        assertEquals(1, chat.replies().chosen)
        assertFalse(chat.replies().live)
    }

    @Test fun `a call without an id is a tool line, for no reply could name it`() = runTest {
        page = runs("""{"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[
            {"type":"tool_call","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Run the tests"]}}]}""")
        val chat = conversation()
        advanceUntilIdle()
        assertTrue(chat.stacks().isEmpty())
        assertEquals(1, chat.state.value.rows.count { it is ConversationRow.Tool })
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
