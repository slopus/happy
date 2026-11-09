package com.slopus.happy.conversation.ui

import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.conversation.UiWork
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A live component's silent action through a conversation (happy-agent
 * API.md "Chat UI", `transcript: "silent"`): no bubble, the component busy
 * and then refused or not from its attempt records, and the result to the
 * caller alone.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveUiConversationTest {
    private val signals = MutableSharedFlow<ConversationSignal>(extraBufferCapacity = 64)
    private val jobs = ArrayList<Job>()
    private val requests = ArrayList<Pair<String, JsonObject?>>()
    private var actions: suspend (JsonObject) -> TransportResponse = { TransportResponse(404, body = """{"error":"No such offer.","code":"not_found"}""".toByteArray()) }

    @After fun cancel() = jobs.forEach { it.cancel() }

    private val request: AgentRequest = { _, path, body, _ ->
        val route = path.substringBefore('?')
        requests += route to (body as? JsonObject)
        when {
            route.endsWith("/bootstrap") -> QuickRepliesConversationTest.ok("""{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Team"},"mode":${QuickRepliesConversationTest.MODE},"draft":{"value":null,"updatedAt":null},"pending":[]}""")
            route.endsWith("/messages") -> QuickRepliesConversationTest.ok("""{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OFFER]}],"hasMore":false}""")
            route.endsWith("/actions") -> actions(body as JsonObject)
            else -> QuickRepliesConversationTest.ok("{}")
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

    private fun Conversation.invite(): ConversationRow.Ui = state.value.rows.filterIsInstance<ConversationRow.Ui>().single { it.component.type == "invite" }

    private val create = UiAction("invite.create", buildJsonObject { put("role", "member") })

    @Test fun `a silent action draws no bubble, busies its component, and its result goes to the caller alone`() = runTest {
        val gate = CompletableDeferred<Unit>()
        actions = { body ->
            gate.await()
            QuickRepliesConversationTest.ok("""{"record":${record(body["id"].toString(), "accepted")},"message":null,
                "result":{"inviteId":"i1","code":"$CODE","expiresAt":9,"serverName":"Acme"},"cursor":"c2"}""")
        }
        val chat = conversation()
        advanceUntilIdle()
        val answer = chat.press(chat.invite().offer, create)!!
        runCurrent()
        assertEquals(UiWork(sending = create), chat.invite().work)
        assertTrue(chat.state.value.rows.none { it is ConversationRow.User })
        val body = requests.last { it.first.endsWith("/actions") }.second!!
        // An action takes no mode.
        assertEquals(listOf("id", "messageId", "uiId", "componentId", "action"), body.keys.toList())

        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(CODE, answer.await()?.get("code").toString().trim('"'))
        assertEquals(UiWork.Idle, chat.invite().work)
        val rows = chat.state.value.rows
        assertTrue(rows.none { it is ConversationRow.User })
        // The code is nowhere in what the screen draws from.
        assertFalse(chat.state.value.toString().contains(CODE))
    }

    @Test fun `a refused silent action shows on its component, not as a bubble`() = runTest {
        actions = { body -> QuickRepliesConversationTest.ok("""{"record":${record(body["id"].toString(), "rejected", reason = "Invites are off here.")},"message":null,"result":null}""") }
        val chat = conversation()
        advanceUntilIdle()
        assertNull(chat.press(chat.invite().offer, create)!!.await())
        advanceUntilIdle()
        assertEquals(UiWork(refused = true, reason = "Invites are off here."), chat.invite().work)
        assertTrue(chat.state.value.rows.none { it is ConversationRow.User })
    }

    @Test fun `a silent action refused outright says the server's words, a permission refusal the phone's`() = runTest {
        actions = { TransportResponse(400, body = """{"error":"That role doesn't exist.","code":"invalid_request"}""".toByteArray()) }
        val chat = conversation()
        advanceUntilIdle()
        chat.press(chat.invite().offer, create)!!.await()
        advanceUntilIdle()
        assertEquals(UiWork(refused = true, reason = "That role doesn't exist."), chat.invite().work)

        actions = { TransportResponse(403, body = """{"error":"This needs the members.manage permission.","code":"forbidden"}""".toByteArray()) }
        chat.press(chat.invite().offer, create)!!.await()
        advanceUntilIdle()
        assertEquals(UiWork(refused = true, reason = null), chat.invite().work)
    }

    @Test fun `another device's attempt busies the component until its outcome`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        signals.emit(event("run.finished", """{"run":{"id":"r5","status":"completed","startedAt":5,"endedAt":5,"reason":"completed"}}"""))
        signals.emit(event("message.created", """{"runId":"r5","message":${record("\"k1\"", "pending")}}"""))
        advanceUntilIdle()
        assertEquals(UiWork(pending = true), chat.invite().work)
        signals.emit(event("message.updated", """{"runId":"r5","message":${record("\"k1\"", "failed", reason = "Timed out")}}"""))
        advanceUntilIdle()
        assertEquals(UiWork(refused = true, reason = "Timed out"), chat.invite().work)
        assertTrue(chat.state.value.rows.none { it is ConversationRow.User })
    }

    private fun event(type: String, payload: String) = ConversationSignal.Event(type, Json.parseToJsonElement(payload).jsonObject)

    companion object {
        private const val CODE = "INV-7F3K-SECRET"

        /** An agent message whose ui block holds an invite. */
        const val OFFER = """{"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[
            {"type":"ui","ui":{"id":"u1","components":[{"id":"inv","type":"invite","fallback":"Invite a teammate in Settings.","props":{}}]}}]}"""

        fun record(id: String, status: String, reason: String? = null): String {
            val outcome = buildString {
                append("""{"status":"$status"""")
                reason?.let { append(""","reason":"$it"""") }
                append("}")
            }
            return """{"id":$id,"role":"service","createdAt":3,"metadata":{},"content":[{"type":"action","messageId":"m1","uiId":"u1","componentId":"inv",
                "action":{"type":"invite.create","payload":{"role":"member"}},"outcome":$outcome}]}"""
        }
    }
}
