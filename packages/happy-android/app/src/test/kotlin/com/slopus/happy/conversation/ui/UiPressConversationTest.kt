package com.slopus.happy.conversation.ui

import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.conversation.Problem
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
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A chat UI press through a conversation (STAGE1-CONTRACT "A click",
 * "Attempt records"): one request to the actions route under one attempt
 * ID, no bubble, the component busy and then refused or not from what the
 * server answered and the attempt records that come in, each in a
 * standalone run ("The standalone run marker"), which is no turn.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class UiPressConversationTest {
    private val signals = MutableSharedFlow<ConversationSignal>(extraBufferCapacity = 64)
    private val jobs = ArrayList<Job>()
    private val requests = ArrayList<Pair<String, JsonObject?>>()
    /** Every read of history, as asked. */
    private val reads = ArrayList<String>()
    private var page = runs(OFFER)

    /** What `POST …/actions` answers: the attempt accepted, unless a test says otherwise. */
    private var actions: suspend (JsonObject) -> TransportResponse = { body -> ok("""{"record":${record(id(body), "accepted", body["componentId"]!!.jsonPrimitive.content)},"result":null,"cursor":"c2"}""") }

    /** Runs before `GET /v0/config` answers. */
    private var config: suspend () -> Unit = {}

    @After fun cancel() = jobs.forEach { it.cancel() }

    private val request: AgentRequest = { _, path, body, _ ->
        val route = path.substringBefore('?')
        requests += route to (body as? JsonObject)
        if (route.endsWith("/messages")) reads += path
        when {
            route.endsWith("/bootstrap") -> ok("""{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Setup"},"mode":${QuickRepliesConversationTest.MODE},"draft":{"value":null,"updatedAt":null},"pending":[]}""")
            route.endsWith("/messages") -> ok(page)
            route.endsWith("/actions") -> actions(body as JsonObject)
            route.endsWith("/config") -> { config(); ok("{}") }
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

    private fun Conversation.component(id: String = "model"): ConversationRow.Ui = state.value.rows.filterIsInstance<ConversationRow.Ui>().single { it.offer.componentId == id }
    private fun pressed() = requests.filter { it.first.endsWith("/actions") }.map { it.second!! }
    private fun id(body: JsonObject) = body["id"]!!.jsonPrimitive.content
    private fun catalogReads() = requests.count { it.first.endsWith("/config") }
    private fun event(type: String, payload: String) = ConversationSignal.Event(type, Json.parseToJsonElement(payload).jsonObject)

    /** An attempt [record] as the server announces it: its standalone run finished, then the record in it. */
    private suspend fun announce(run: String, record: String, type: String = "message.created") {
        if (type == "message.created") signals.emit(event("run.finished", """{"run":${standalone(run)}}"""))
        signals.emit(event(type, """{"runId":"$run","message":$record}"""))
    }

    private val high = UiActions.setDefaultModel("claude", "opus", "high")
    private val low = UiActions.setDefaultModel("claude", "opus", "low")

    @Test fun `a press is one request to the actions route, draws no bubble, and busies its component until it is answered`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val answer = actions
        actions = { body -> gate.await(); answer(body) }
        val chat = conversation()
        advanceUntilIdle()
        assertEquals(UiWork.Idle, chat.component().work)
        chat.press(chat.component().offer, high)
        runCurrent()
        assertEquals(UiWork(sending = high), chat.component().work)
        assertTrue(chat.component().work.busy)
        val body = pressed().single()
        // Exactly the request the route takes: an action carries no mode and no text.
        assertEquals(listOf("id", "messageId", "uiId", "componentId", "action"), body.keys.toList())
        assertTrue(UiContract.passes(UiContract.schema.getValue("wire").jsonObject.getValue("actionRequest").jsonObject, body))
        assertEquals("""{"messageId":"m1","uiId":"u1","componentId":"model","action":{"type":"default_model.set","payload":{"providerId":"claude","modelId":"opus","effort":"high"}}}""", JsonObject(body - "id").toString())
        // One press of an offer at a time; another offer's goes beside it.
        chat.press(chat.component().offer, low)
        chat.press(chat.component("other").offer, low)
        runCurrent()
        assertEquals(listOf("model", "other"), pressed().map { it["componentId"]!!.jsonPrimitive.content })

        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(UiWork.Idle, chat.component().work)
        assertEquals(UiWork.Idle, chat.component("other").work)
        val rows = chat.state.value.rows
        assertTrue("no bubble, and no row of the record's own", rows.none { it is ConversationRow.User || it is ConversationRow.Notice || it is ConversationRow.Failure })
        assertEquals("the record's run is no turn", listOf("r1"), rows.filterIsInstance<ConversationRow.TurnEnd>().map { it.turn })
        assertFalse(chat.state.value.working)
    }

    @Test fun `a press that is not answered keeps its attempt ID for the same press again, and no other`() = runTest {
        actions = { TransportResponse(503, body = """{"error":"Busy.","code":"unavailable"}""".toByteArray()) }
        val chat = conversation()
        advanceUntilIdle()
        val offer = chat.component().offer
        chat.press(offer, high)
        advanceUntilIdle()
        // The request's own retries are one attempt.
        assertEquals(3, pressed().size)
        val first = id(pressed()[0])
        assertEquals(setOf(first), pressed().map(::id).toSet())
        assertEquals(UiWork(problem = Problem.Said("Busy.")), chat.component().work)
        // Pressed again after they ran out: the same attempt, which the server answers as it answered the first.
        chat.press(offer, high)
        advanceUntilIdle()
        assertEquals(6, pressed().size)
        assertEquals(setOf(first), pressed().map(::id).toSet())
        // Another action is another attempt, and so is the first one after it.
        chat.press(offer, low)
        advanceUntilIdle()
        val second = id(pressed().last())
        assertNotEquals(first, second)
        chat.press(offer, high)
        advanceUntilIdle()
        assertTrue(id(pressed().last()) !in setOf(first, second))
    }

    @Test fun `an attempt the server answered is done with, so the same press again is a new one`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        val offer = chat.component().offer
        chat.press(offer, high)
        advanceUntilIdle()
        chat.press(offer, high)
        advanceUntilIdle()
        assertEquals(2, pressed().map(::id).toSet().size)

        // Unanswered here, yet its record came in: the computer has it, so it is no longer this press.
        actions = { TransportResponse(503, body = "{}".toByteArray()) }
        chat.press(offer, low)
        advanceUntilIdle()
        val lost = id(pressed().last())
        announce("r7", record(lost, "accepted", effort = "low"))
        advanceUntilIdle()
        chat.press(offer, low)
        advanceUntilIdle()
        assertNotEquals(lost, id(pressed().last()))
    }

    @Test fun `a request the server turns down records nothing, is not sent again, and says why on the component`() = runTest {
        actions = { TransportResponse(400, body = """{"error":"That model isn't offered here.","code":"invalid_request"}""".toByteArray()) }
        val chat = conversation()
        advanceUntilIdle()
        val offer = chat.component().offer
        chat.press(offer, high)
        advanceUntilIdle()
        assertEquals(1, pressed().size)
        assertEquals(UiWork(problem = Problem.Said("That model isn't offered here.")), chat.component().work)
        assertTrue(chat.state.value.rows.none { it is ConversationRow.User || it is ConversationRow.Failure })

        // A role without the permission is told in the phone's own words.
        val gate = CompletableDeferred<Unit>()
        actions = { gate.await(); TransportResponse(403, body = """{"error":"This needs the config.manage permission.","code":"forbidden"}""".toByteArray()) }
        chat.press(offer, high)
        runCurrent()
        assertEquals("pressed again, the old refusal goes", UiWork(sending = high), chat.component().work)
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(UiWork(problem = Problem.Forbidden), chat.component().work)
        assertEquals("turned down is answered: each press its own attempt", 2, pressed().map(::id).toSet().size)
    }

    @Test fun `a refused attempt shows on its component until the default model is read again`() = runTest {
        actions = { body -> ok("""{"record":${record(id(body), "rejected", reason = "That model is switched off.")},"result":null,"cursor":"c2"}""") }
        val chat = conversation()
        advanceUntilIdle()
        chat.press(chat.component().offer, high)
        advanceUntilIdle()
        assertEquals(UiWork(problem = Problem.Said("That model is switched off.")), chat.component().work)
        assertTrue(chat.state.value.rows.none { it is ConversationRow.User })
        // What is read after the refusal is newer than it: the refusal no longer stands over it.
        val before = catalogReads()
        signals.emit(event("config.updated", "{}"))
        advanceUntilIdle()
        assertEquals(before + 1, catalogReads())
        assertEquals(UiWork.Idle, chat.component().work)
    }

    @Test fun `a read of the default model already under way when a refusal comes says nothing of it`() = runTest {
        actions = { body -> ok("""{"record":${record(id(body), "rejected", reason = "That model is switched off.")},"result":null,"cursor":"c2"}""") }
        val chat = conversation()
        advanceUntilIdle()
        val reading = CompletableDeferred<Unit>()
        config = { reading.await() }
        signals.emit(event("config.updated", "{}"))
        runCurrent()
        chat.press(chat.component().offer, high)
        runCurrent()
        val refused = UiWork(problem = Problem.Said("That model is switched off."))
        assertEquals(refused, chat.component().work)
        reading.complete(Unit)
        advanceUntilIdle()
        assertEquals("asked for before the refusal, it is no newer", refused, chat.component().work)
        config = {}
        signals.emit(event("config.updated", "{}"))
        advanceUntilIdle()
        assertEquals(UiWork.Idle, chat.component().work)
    }

    @Test fun `a refusal history holds from before is not news, one that comes in while the chat is open is`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OFFER]},
            ${standalone("r2", record("k1", "rejected", reason = "That model is switched off."))}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        assertEquals(UiWork.Idle, chat.component().work)
        assertTrue("the record's run draws nothing", chat.state.value.rows.none { it is ConversationRow.TurnEnd && it.turn == "r2" })
        // The same record told again says nothing new.
        announce("r2", record("k1", "rejected", reason = "That model is switched off."), type = "message.updated")
        advanceUntilIdle()
        assertEquals(UiWork.Idle, chat.component().work)
        // Another device's attempt, refused while this chat is open.
        announce("r3", record("k2", "failed"))
        advanceUntilIdle()
        assertEquals(UiWork(problem = Problem.Unknown), chat.component().work)
        // A later attempt that went through settles it.
        announce("r4", record("k3", "accepted"))
        advanceUntilIdle()
        assertEquals(UiWork.Idle, chat.component().work)
    }

    @Test fun `an attempt still pending busies its component, from any device, until its outcome`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        announce("r5", record("k1", "pending"))
        advanceUntilIdle()
        assertEquals(UiWork(pending = true), chat.component().work)
        assertEquals("the other component is not its", UiWork.Idle, chat.component("other").work)
        announce("r5", record("k1", "failed", reason = "Timed out."), type = "message.updated")
        advanceUntilIdle()
        assertEquals(UiWork(problem = Problem.Said("Timed out.")), chat.component().work)
    }

    @Test fun `a standalone run ends beside a turn going on, which goes on, and is no turn itself`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        signals.emit(event("run.started", """{"run":{"id":"r10","status":"running","startedAt":7},"acceptedMessageIds":[]}"""))
        signals.emit(event("message.created", """{"runId":"r10","message":{"id":"m5","role":"agent","createdAt":8,"metadata":{},"content":[{"type":"text","text":"Working on it"}]}}"""))
        advanceUntilIdle()
        assertTrue(chat.state.value.working)
        announce("r11", record("k1", "pending"))
        // A message the server wrote itself with no run open is in one too.
        announce("r12", """{"id":"m6","role":"agent","createdAt":9,"metadata":{},"content":[{"type":"text","text":"Your trial ends tomorrow."}]}""")
        advanceUntilIdle()
        assertTrue("the turn goes on", chat.state.value.working)
        assertTrue(chat.component().work.pending)
        val rows = chat.state.value.rows
        assertEquals("no standalone run ends like a turn", listOf("r1"), rows.filterIsInstance<ConversationRow.TurnEnd>().map { it.turn })
        assertEquals("what the server wrote stands as it is", "Your trial ends tomorrow.", (rows.first { it.key == "m6:0" } as ConversationRow.Text).text)
        assertTrue("the turn's words still stream under the standalone runs", (rows.first { it.key == "m5:0" } as ConversationRow.Text).live != null)
        // The turn's own end ends it.
        signals.emit(event("run.finished", """{"run":{"id":"r10","status":"completed","startedAt":7,"endedAt":12,"reason":"completed"}}"""))
        advanceUntilIdle()
        assertFalse(chat.state.value.working)
        assertEquals(listOf("r1", "r10"), chat.state.value.rows.asReversed().filterIsInstance<ConversationRow.TurnEnd>().map { it.turn })
    }

    @Test fun `a press's answer waits for its run to be announced, and is one message when it is`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        chat.press(chat.component().offer, high)
        advanceUntilIdle()
        val id = id(pressed().single())
        val before = chat.state.value.rows
        announce("r20", record(id, "accepted"))
        advanceUntilIdle()
        assertEquals(before, chat.state.value.rows)
        assertEquals(UiWork.Idle, chat.component().work)
    }

    @Test fun `a catch-up reads a turn still going again whole, though a standalone run came after it`() = runTest {
        page = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[$OFFER]},
            {"id":"r10","status":"running","startedAt":7,"messages":[{"id":"m5","role":"agent","createdAt":8,"metadata":{},"content":[{"type":"text","text":"Working on it"}]}]},
            ${standalone("r11", record("k1", "accepted"))}],"hasMore":false}"""
        val chat = conversation()
        advanceUntilIdle()
        signals.emit(ConversationSignal.Resync)
        advanceUntilIdle()
        // From the last message before the turn going on, not from the record after it.
        assertTrue(reads.last(), reads.last().endsWith("after=m1"))
    }

    @Test fun `nothing goes for an action its component does not take, and nothing of it is kept`() = runTest {
        val chat = conversation()
        advanceUntilIdle()
        val token = "sk-ant-oat01-example"
        // Another component's action, with a secret; a payload that isn't the action's; an offer that isn't here.
        chat.press(chat.component().offer, UiAction("provider_sign_in.submit_token", buildJsonObject { put("token", token) }))
        chat.press(chat.component().offer, UiAction("default_model.set", buildJsonObject { put("providerId", "claude"); put("modelId", "opus"); put("effort", "high"); put("token", token) }))
        chat.press(chat.component("files").offer, high)
        chat.press(UiOffer("m1", "u1", "gone"), high)
        advanceUntilIdle()
        assertTrue(pressed().isEmpty())
        assertTrue(chat.state.value.rows.filterIsInstance<ConversationRow.Ui>().all { it.work == UiWork.Idle })
        assertFalse(chat.state.value.toString().contains(token))
    }

    companion object {
        /** An agent message the daemon wrote: two default models and a file tree. */
        const val OFFER = """{"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"ui","ui":{"id":"u1","components":[
            {"id":"model","type":"default_model","fallback":"Change the default model in Settings.","props":{}},
            {"id":"other","type":"default_model","fallback":"Change the default model in Settings.","props":{}},
            {"id":"files","type":"file_tree","fallback":"1 file","props":{"paths":["a.ts"]}}]}}]}"""

        /** An attempt record: a service message of one `action` block. */
        fun record(id: String, status: String, component: String = "model", reason: String? = null, effort: String = "high"): String {
            val outcome = """{"status":"$status"${reason?.let { ""","reason":"$it"""" } ?: ""}}"""
            return """{"id":"$id","role":"service","createdAt":3,"metadata":{},"content":[{"type":"action","messageId":"m1","uiId":"u1","componentId":"$component",
                "action":{"type":"default_model.set","payload":{"providerId":"claude","modelId":"opus","effort":"$effort"}},"outcome":$outcome}]}"""
        }

        /** A run the server stored already finished, outside any turn, holding [messages]. */
        fun standalone(id: String, vararg messages: String) = """{"id":"$id","kind":"standalone","status":"completed","startedAt":8,"endedAt":8,"reason":"completed","messages":[${messages.joinToString(",")}]}"""

        fun runs(vararg messages: String) = """{"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[${messages.joinToString(",")}]}],"hasMore":false}"""

        fun ok(text: String) = TransportResponse(200, body = text.toByteArray())
    }
}
