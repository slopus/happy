package com.slopus.happy.conversation

import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A paired agent answering conversation routes from memory, recording every request. */
private class FakeAgent {
    val requests = ArrayList<Triple<String, String, JsonObject?>>()
    var bootstrap = """{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Fix it"},"mode":$MODE,"draft":{"value":null,"updatedAt":null},"pending":[]}"""
    var page = """{"runs":[],"hasMore":false}"""
    var failSends = 0
    var failOlder = false
    var sendStatus = 202
    var beforeBootstrap: suspend () -> Unit = {}

    val request: AgentRequest = { method, path, body ->
        requests += Triple(method, path, body as? JsonObject)
        val route = path.substringBefore('?')
        when {
            route == "/v0/tasks" -> ok("""{"task":{"id":${(body as JsonObject)["id"]},"agent":{"id":"${(body as JsonObject)["agentId"]!!.toString().trim('"')}","workspaceId":"w","status":"idle"}},"membership":{}}""")
            route.endsWith("/bootstrap") -> { beforeBootstrap(); ok(bootstrap) }
            route.endsWith("/messages") && failOlder && "before=" in path -> TransportResponse(503, body = "{}".toByteArray())
            route.endsWith("/messages") -> ok(page)
            route.endsWith("/send") && failSends > 0 -> { failSends--; TransportResponse(503, body = """{"error":"busy"}""".toByteArray()) }
            route.endsWith("/send") -> TransportResponse(sendStatus, body = """{"error":"Unknown model.","code":"invalid_request"}""".toByteArray())
            route == "/v0/config" -> ok(CONFIG)
            route.endsWith("/draft") -> ok("""{"draft":${(body as JsonObject).let { """{"value":${it["draft"]},"updatedAt":${it["updatedAt"]}}""" }}}""")
            else -> ok("{}")
        }
    }

    fun paths(method: String) = requests.filter { it.first == method }.map { it.second.substringBefore('?') }

    companion object {
        const val MODE = """{"providerId":"codex","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"auto"}"""
        const val CONFIG = """{"config":{
            "defaults":{"providerId":"claude","modelId":"anthropic/opus-5","permissionMode":"auto"},
            "models":{
                "anthropic/opus-5":{"name":"Opus 5 1M","efforts":["low","medium","high","max"],"defaultEffort":"high","serviceTiers":[]},
                "openai/gpt-5.6-sol":{"name":"GPT-5.6 Sol","efforts":["low","medium","high","xhigh"],"defaultEffort":"medium","serviceTiers":["priority"]},
                "openai/gpt-5.6-luna":{"name":"GPT-5.6 Luna","efforts":["low"],"defaultEffort":"low","serviceTiers":[]},
                "xai/grok-4.5":{"name":"Grok 4.5","efforts":["high"],"defaultEffort":"high","serviceTiers":[]}
            },
            "providers":{
                "claude":{"name":"Current CLI","type":"claude","enabled":true,"hidden":false,"models":[{"id":"anthropic/opus-5","enabled":true},{"id":"anthropic/opus-4-8","enabled":false}]},
                "codex":{"type":"codex","enabled":true,"hidden":false,"models":[{"id":"openai/gpt-5.6-sol","enabled":true},{"id":"openai/gpt-5.6-luna","enabled":true}]},
                "grok":{"type":"grok","enabled":false,"hidden":false,"models":[{"id":"xai/grok-4.5","enabled":true}]}
            }}}"""
        fun ok(text: String) = TransportResponse(200, body = text.toByteArray())
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ConversationTest {
    private val signals = MutableSharedFlow<ConversationSignal>(extraBufferCapacity = 64)
    private val jobs = ArrayList<Job>()

    @After fun cancel() = jobs.forEach { it.cancel() }

    private fun TestScope.conversation(agent: FakeAgent, newTask: NewTask? = null, created: (JsonObject) -> Unit = {}) = Conversation(
        api = ConversationApi(agent.request),
        signals = signals,
        // Not backgroundScope: advanceUntilIdle leaves its work alone. Cancelled after each test.
        scope = CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob().also { jobs += it }),
        agentId = newTask?.agentId ?: "a1",
        newTask = newTask,
        onTaskCreated = created,
        lane = StandardTestDispatcher(testScheduler),
        now = { 1000 },
        retryDelayMillis = 1,
    ).also { it.start() }

    private fun event(type: String, payload: String) = ConversationSignal.Event(type, Json.parseToJsonElement(payload).jsonObject)

    @Test fun `initial history and reconnect stay syncing until bootstrap completes or fails`() = runTest {
        val agent = FakeAgent()
        var gate = CompletableDeferred<Unit>()
        agent.beforeBootstrap = { gate.await() }
        val chat = conversation(agent)
        advanceUntilIdle()
        assertTrue(chat.state.value.syncing)
        assertFalse(chat.state.value.loaded)
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue(chat.state.value.loaded)
        assertFalse(chat.state.value.syncing)

        gate = CompletableDeferred()
        signals.emit(ConversationSignal.Resync)
        advanceUntilIdle()
        assertTrue(chat.state.value.syncing)
        assertTrue(chat.state.value.loaded)
        gate.completeExceptionally(IllegalStateException("fixture unavailable"))
        advanceUntilIdle()
        assertFalse(chat.state.value.syncing)
        assertTrue(chat.state.value.error != null)
    }

    @Test fun `reads history and pending messages in run order`() = runTest {
        val agent = FakeAgent()
        agent.page = """{"runs":[{"id":"r1","status":"completed","messages":[
            {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Hi"}],"metadata":{}},
            {"id":"m2","role":"agent","createdAt":2,"content":[{"type":"reasoning","text":"hmm"},{"type":"tool_call","id":"c1","name":"Bash","status":"completed","presentation":{"type":"exec_command","command":"ls"}},{"type":"text","text":"Done"}],"metadata":{}}
        ]}],"hasMore":true}"""
        agent.bootstrap = agent.bootstrap.replace("\"pending\":[]", """"pending":[{"id":"m3","role":"user","status":"pending","createdAt":3,"content":[{"type":"text","text":"Next"}],"metadata":{}}]""")
        val chat = conversation(agent)
        advanceUntilIdle()
        val state = chat.state.value
        assertTrue(state.loaded)
        assertTrue(state.hasMore)
        assertEquals("Fix it", state.title)
        // Newest first.
        assertEquals(listOf("m3:user", "m2:2", "m2:1", "m2:0", "m1:user"), state.rows.map { it.key })
        assertEquals(Delivery.Pending, (state.rows[0] as ConversationRow.User).delivery)
        assertEquals("ls", (state.rows[2] as ConversationRow.Tool).detail)
    }

    @Test fun `home's name is the title before anything is read, and the computer's title wins once it is`() = runTest {
        val agent = FakeAgent()
        val chat = Conversation(
            api = ConversationApi(agent.request),
            signals = signals,
            scope = CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob().also { jobs += it }),
            agentId = "a1",
            knownTitle = "Chief of Staff",
            lane = StandardTestDispatcher(testScheduler),
            now = { 1000 },
        )
        // The very first state, before start(): nothing has been asked yet.
        assertEquals("Chief of Staff", chat.state.value.title)
        assertTrue(!chat.state.value.loaded)
        assertTrue(agent.requests.isEmpty())

        chat.start()
        advanceUntilIdle()
        assertEquals("Fix it", chat.state.value.title)
    }

    @Test fun `streams deltas exactly and reloads on a gap`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        signals.emit(event("run.started", """{"agentId":"a1","run":{"id":"r1","status":"running","startedAt":5},"acceptedMessageIds":[]}"""))
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"text","text":"Hel"}],"metadata":{}}}"""))
        signals.emit(event("message.delta", """{"agentId":"a1","runId":"r1","messageId":"m","blockIndex":0,"offset":3,"append":"lo"}"""))
        // A replay of what is already there changes nothing.
        signals.emit(event("message.delta", """{"agentId":"a1","runId":"r1","messageId":"m","blockIndex":0,"offset":3,"append":"lo"}"""))
        advanceUntilIdle()
        assertEquals("Hello", (chat.state.value.rows.single() as ConversationRow.Text).text)
        assertTrue(chat.state.value.working)
        val reads = agent.paths("GET").count { it.endsWith("/bootstrap") }
        signals.emit(event("message.delta", """{"agentId":"a1","runId":"r1","messageId":"m","blockIndex":0,"offset":9,"append":"x"}"""))
        advanceUntilIdle()
        assertEquals(reads + 1, agent.paths("GET").count { it.endsWith("/bootstrap") })
    }

    @Test fun `a failed older page waits for Retry`() = runTest {
        val agent = FakeAgent()
        agent.page = """{"runs":[{"id":"r2","status":"completed","messages":[{"id":"m","role":"user","createdAt":1,"content":[{"type":"text","text":"Hi"}],"metadata":{}}]}],"hasMore":true}"""
        agent.failOlder = true
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.loadOlder()
        advanceUntilIdle()
        assertTrue(chat.state.value.olderFailed)
        val asked = agent.requests.count { "before=" in it.second }
        chat.loadOlder()
        advanceUntilIdle()
        assertEquals(asked, agent.requests.count { "before=" in it.second })
        agent.failOlder = false
        agent.page = """{"runs":[{"id":"r1","status":"completed","messages":[{"id":"o","role":"user","createdAt":0,"content":[{"type":"text","text":"Older"}],"metadata":{}}]}],"hasMore":false}"""
        chat.loadOlder(retry = true)
        advanceUntilIdle()
        assertFalse(chat.state.value.olderFailed)
        assertEquals(listOf("m:user", "o:user"), chat.state.value.rows.map { it.key })
    }

    @Test fun `grow follows the API's delta rules`() {
        val message = Message("m", "agent", 0, listOf(Block.Text("abc")))
        assertEquals("abcd", (Conversation.grow(message, 0, 3, "d")!!.content[0] as Block.Text).text)
        assertEquals("abc", (Conversation.grow(message, 0, 1, "bc")!!.content[0] as Block.Text).text)
        assertEquals("abcde", (Conversation.grow(message, 0, 2, "cde")!!.content[0] as Block.Text).text)
        assertNull(Conversation.grow(message, 0, 2, "x"))
        assertNull(Conversation.grow(message, 0, 4, "x"))
        assertNull(Conversation.grow(message, 1, 0, "x"))
    }

    @Test fun `a send shows at once, is delivered under its id and leaves when echoed`() = runTest {
        val agent = FakeAgent()
        agent.sendStatus = 202
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.setDraft("Hello")
        chat.send("Hello")
        advanceUntilIdle()
        val sends = agent.requests.filter { it.second.endsWith("/send") }
        assertEquals(1, sends.size)
        val body = sends.single().third!!
        assertEquals("steer", body["delivery"].toString().trim('"'))
        assertEquals(Json.parseToJsonElement(FakeAgent.MODE), body["mode"])
        val id = body["id"].toString().trim('"')
        assertEquals("", chat.state.value.draft)
        val row = chat.state.value.rows.single() as ConversationRow.User
        assertEquals(Delivery.Pending, row.delivery)
        // The row drawn at once is keyed by the id the send carried, so the
        // agent's own copy takes its place rather than arriving beside it:
        // the list keeps its anchor and nothing jumps.
        assertEquals("$id:user", row.key)
        signals.emit(event("message.created", """{"agentId":"a1","runId":null,"message":{"id":"$id","role":"user","status":"pending","createdAt":5,"content":[{"type":"text","text":"Hello"}],"metadata":{}}}"""))
        signals.emit(event("run.started", """{"agentId":"a1","run":{"id":"r1","status":"running","startedAt":5},"acceptedMessageIds":["$id"]}"""))
        advanceUntilIdle()
        assertEquals(listOf("$id:user"), chat.state.value.rows.map { it.key })
        assertEquals(Delivery.Sent, (chat.state.value.rows.single() as ConversationRow.User).delivery)
    }

    @Test fun `a refused send fails, retries under the same id, and discards back to the composer`() = runTest {
        val agent = FakeAgent()
        agent.sendStatus = 400
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.send("Hello")
        advanceUntilIdle()
        val row = chat.state.value.rows.single() as ConversationRow.User
        assertEquals(Delivery.Failed("Unknown model."), row.delivery)
        agent.sendStatus = 202
        chat.retrySend(row.messageId)
        advanceUntilIdle()
        val ids = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!!["id"] }
        assertEquals(2, ids.size)
        assertEquals(ids[0], ids[1])
        agent.sendStatus = 400
        chat.send("Again")
        advanceUntilIdle()
        val failed = chat.state.value.rows.first() as ConversationRow.User
        chat.discardSend(failed.messageId)
        advanceUntilIdle()
        assertEquals("Again", chat.state.value.draft)
        assertEquals(1, chat.state.value.draftArrivals)
    }

    @Test fun `transient send failures are retried`() = runTest {
        val agent = FakeAgent()
        agent.failSends = 2
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.send("Hello")
        advanceUntilIdle()
        assertEquals(3, agent.requests.count { it.second.endsWith("/send") })
        assertEquals(Delivery.Pending, (chat.state.value.rows.single() as ConversationRow.User).delivery)
    }

    @Test fun `a new chat makes its task on the first send, then becomes the real chat in place`() = runTest {
        val agent = FakeAgent()
        val task = NewTask("t1", "w1", "a9", "m1")
        var made: JsonObject? = null
        val chat = conversation(agent, task) { made = it }
        advanceUntilIdle()
        assertFalse(chat.state.value.created)
        assertTrue(chat.state.value.loaded)
        // Only the picker's models are read.
        assertEquals(listOf("/v0/config"), agent.paths("GET"))
        assertTrue(agent.paths("POST").isEmpty())
        chat.setDraft("typed")
        advanceUntilIdle()
        // Nothing is saved for an agent that doesn't exist yet.
        assertEquals(listOf("/v0/config"), agent.requests.map { it.second })
        chat.send("First")
        chat.send("Second")
        advanceUntilIdle()
        assertEquals(1, agent.requests.count { it.second == "/v0/tasks" })
        val createBody = agent.requests.first { it.second == "/v0/tasks" }.third!!
        assertEquals("\"t1\"", createBody["id"].toString())
        assertEquals("\"a9\"", createBody["agentId"].toString())
        assertEquals(listOf("/v0/agents/a9/send", "/v0/agents/a9/send"), agent.paths("POST").filter { it.endsWith("/send") })
        // The default model at its own effort, as nothing was picked.
        assertEquals("\"high\"", agent.requests.first { it.second.endsWith("/send") }.third!!["mode"]!!.jsonObject["effort"].toString())
        assertTrue(chat.state.value.created)
        assertEquals("t1", made!!["task"]!!.jsonObject["id"].toString().trim('"'))
        assertEquals(listOf("Second", "First"), chat.state.value.rows.map { (it as ConversationRow.User).text })
    }

    @Test fun `a prefix goes above the agent's draft once, unsaved, with the cursor after it`() = runTest {
        val agent = FakeAgent()
        agent.bootstrap = agent.bootstrap.replace(
            """"draft":{"value":null,"updatedAt":null}""",
            """"draft":{"value":{"text":"keep me","providerId":"claude","modelId":"anthropic/opus-5","effort":"high","serviceTier":null,"permissionMode":"auto"},"updatedAt":900}""",
        )
        val prefix = "Change this agent connection's name to "
        val chat = conversation(agent)
        chat.prefill(prefix)
        advanceUntilIdle()
        assertEquals(prefix + "\n\nkeep me", chat.state.value.draft)
        assertEquals(prefix.length, chat.state.value.composerFocus?.cursor)
        // Opening saves nothing over the agent's draft.
        assertTrue(agent.requests.none { it.second.endsWith("/draft") })
        // Asked again (the draft already starts with it): not doubled, focus asked again.
        val serial = chat.state.value.composerFocus!!.serial
        chat.prefill(prefix)
        advanceUntilIdle()
        assertEquals(prefix + "\n\nkeep me", chat.state.value.draft)
        assertEquals(serial + 1, chat.state.value.composerFocus?.serial)
    }

    @Test fun `a prefix alone fills a blank draft`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        chat.prefill("Change this agent connection's avatar: ")
        advanceUntilIdle()
        assertEquals("Change this agent connection's avatar: ", chat.state.value.draft)
        assertEquals(1, chat.state.value.draftArrivals)
    }

    @Test fun `the chief of staff is the active bot with its system key`() = runTest {
        val bots = """{"bots":[
            {"id":"b0","name":"Chief of Staff","systemKey":null,"status":"active","agent":{"id":"wrong"}},
            {"id":"b1","name":"Old","systemKey":"chief_of_staff","status":"archived","agent":{"id":"archived"}},
            {"id":"b2","name":"Renamed","systemKey":"chief_of_staff","status":"active","agent":{"id":"chief"}}
        ]}"""
        assertEquals("chief", ConversationApi { _, _, _ -> FakeAgent.ok(bots) }.chiefOfStaffAgentId())
        assertNull(ConversationApi { _, _, _ -> FakeAgent.ok("""{"bots":[]}""") }.chiefOfStaffAgentId())
    }

    @Test fun `a chat that could not be read reads again on retry`() = runTest {
        val agent = FakeAgent()
        val good = agent.bootstrap
        agent.bootstrap = "{}"
        val chat = conversation(agent)
        advanceUntilIdle()
        assertTrue(chat.state.value.error != null)
        agent.bootstrap = good
        chat.retryLoad()
        advanceUntilIdle()
        assertNull(chat.state.value.error)
        assertEquals("Fix it", chat.state.value.title)
    }

    @Test fun `draft from another device replaces this one only when newer`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        signals.emit(event("agent.draft.updated", """{"agentId":"a1","draft":{"value":{"text":"from desktop","providerId":"claude","modelId":"anthropic/opus-5","effort":"high","serviceTier":null,"permissionMode":"auto"},"updatedAt":5000}}"""))
        advanceUntilIdle()
        assertEquals("from desktop", chat.state.value.draft)
        assertEquals(1, chat.state.value.draftArrivals)
        assertEquals("anthropic/opus-5", chat.state.value.mode?.modelId)
        signals.emit(event("agent.draft.updated", """{"agentId":"a1","draft":{"value":{"text":"stale","providerId":"claude","modelId":"anthropic/opus-5","effort":"high","serviceTier":null,"permissionMode":"auto"},"updatedAt":10}}"""))
        advanceUntilIdle()
        assertEquals("from desktop", chat.state.value.draft)
    }

    @Test fun `typing saves the draft with its mode after a pause`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.setDraft("h")
        chat.setDraft("he")
        advanceUntilIdle()
        val saves = agent.requests.filter { it.first == "PUT" }
        assertEquals(1, saves.size)
        assertEquals("\"he\"", saves.single().third!!["draft"]!!.jsonObject["text"].toString())
    }

    @Test fun `questions show, answer and clear`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        signals.emit(event("question.created", """{"question":{"id":"q1","agentId":"a1","status":"pending","questions":[{"id":"p1","header":"DB","question":"Which?","multiSelect":false,"options":[{"label":"Postgres"}]}]}}"""))
        advanceUntilIdle()
        assertEquals(Activity.AwaitingAnswer, chat.state.value.activity)
        val question = chat.state.value.question!!
        assertTrue(question.answerable)
        chat.answer(question.id, mapOf("p1" to listOf("Postgres")))
        advanceUntilIdle()
        assertNull(chat.state.value.question)
        val answer = agent.requests.single { it.second.endsWith("/answer") }
        assertEquals("/v0/agents/a1/question/q1/answer", answer.second)
        assertEquals(Json.parseToJsonElement("""{"p1":["Postgres"]}"""), answer.third!!["answers"])
    }

    @Test fun `working line follows the agent's status`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        assertNull(chat.state.value.activity)
        signals.emit(event("run.started", """{"agentId":"a1","run":{"id":"r1","status":"running","startedAt":5},"acceptedMessageIds":[]}"""))
        advanceUntilIdle()
        assertEquals(Activity.WaitingForModel, chat.state.value.activity)
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"text","text":"x"}],"metadata":{}}}"""))
        signals.emit(event("agent.updated", """{"agentId":"a1","changes":{"status":"running_tools","updatedAt":6}}"""))
        advanceUntilIdle()
        assertEquals(Activity.RunningTools, chat.state.value.activity)
        signals.emit(event("run.finished", """{"agentId":"a1","run":{"id":"r1","status":"completed"}}"""))
        advanceUntilIdle()
        assertNull(chat.state.value.activity)
        assertFalse(chat.state.value.working)
    }

    @Test fun `failures read as desktop's card and retry`() = runTest {
        val agent = FakeAgent()
        agent.page = """{"runs":[{"id":"r1","status":"failed","messages":[
            {"id":"f1","role":"service","createdAt":1,"content":[{"type":"text","text":"Claude usage limit reached."}],"metadata":{},"failure":{"kind":"usage_limit","message":"x","provider":{"id":"claude","vendorName":"Claude","label":"claude"},"fallbackProviders":[]}}
        ]}],"hasMore":false}"""
        val chat = conversation(agent)
        advanceUntilIdle()
        val failure = chat.state.value.rows.single() as ConversationRow.Failure
        assertEquals("Claude usage limit reached.", failure.reason)
        assertTrue(failure.retryable)
        chat.retryFailure(failure.messageId)
        advanceUntilIdle()
        assertTrue(agent.paths("POST").contains("/v0/agents/a1/messages/f1/retry"))
    }

    @Test fun `a subagent's messages and collaborators`() {
        val fromOther = Message("m", "agent", 1, listOf(Block.Text("Message from agent x9: done")), senderAgentId = "x9")
        val row = ConversationRowBuilder.build(fromOther, "a1", null, false).single() as ConversationRow.Collaborator
        assertEquals("done", row.text)
        val fromParent = Message("m", "agent", 1, listOf(Block.Text("Message from agent p: do this")), senderAgentId = "p")
        assertEquals("do this", (ConversationRowBuilder.build(fromParent, "a1", "p", false).single() as ConversationRow.User).text)
        val media = Message("m", "agent", 1, listOf(Block.ToolCall("c", "show", "completed", Presentation.Media(listOf(MediaItem("image", "a.png", "image/png"))))))
        assertEquals(MediaRef("c", 0, MediaItem("image", "a.png", "image/png")), (ConversationRowBuilder.build(media, "a1", null, false).single() as ConversationRow.Media).items.single())
    }

    @Test fun `the catalog lists enabled models of enabled providers`() {
        val catalog = ModeCatalog.parse(Json.parseToJsonElement(FakeAgent.CONFIG).jsonObject)
        assertEquals(
            listOf("claude/anthropic/opus-5", "codex/openai/gpt-5.6-sol", "codex/openai/gpt-5.6-luna"),
            catalog.models.map { "${it.providerId}/${it.modelId}" },
        )
        assertEquals(listOf("Current CLI", "Codex", "Codex"), catalog.models.map { it.providerName })
        assertEquals("Opus 5 1M", catalog.models[0].name)
        assertEquals(Mode("claude", "anthropic/opus-5", "high", null, "auto"), catalog.defaults)
    }

    @Test fun `another model keeps the effort and tier it runs, else its defaults`() {
        val catalog = ModeCatalog.parse(Json.parseToJsonElement(FakeAgent.CONFIG).jsonObject)
        val sol = Mode("codex", "openai/gpt-5.6-sol", "xhigh", "priority", "auto")
        assertEquals(Mode("claude", "anthropic/opus-5", "high", null, "auto"), catalog.pick(sol, "claude", "anthropic/opus-5"))
        assertEquals(Mode("codex", "openai/gpt-5.6-luna", "low", null, "auto"), catalog.pick(sol, "codex", "openai/gpt-5.6-luna"))
        assertEquals(sol.copy(effort = "low"), catalog.pick(sol.copy(effort = "low"), "codex", "openai/gpt-5.6-sol"))
        assertEquals(sol, catalog.pick(sol, "grok", "xai/grok-4.5"))
    }

    @Test fun `a picked mode is kept with the draft at once and sends with the next message`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        assertEquals(3, chat.state.value.catalog?.models?.size)
        val picked = Mode("claude", "anthropic/opus-5", "max", null, "read_only")
        chat.setMode(picked)
        advanceUntilIdle()
        assertEquals(picked, chat.state.value.mode)
        val saved = agent.requests.last { it.second.endsWith("/draft") }.third!!
        assertEquals(picked.json(), JsonObject(saved["draft"]!!.jsonObject - "text"))
        chat.send("Go")
        advanceUntilIdle()
        assertEquals(picked.json(), agent.requests.last { it.second.endsWith("/send") }.third!!["mode"])
    }

    @Test fun `pictures go inline with the words, in order`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        val files = listOf(java.io.File("a.jpg"))
        assertTrue(chat.send("Look", files) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        chat.send("After")
        advanceUntilIdle()
        val sends = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!! }
        assertEquals(listOf("Look", "After"), sends.map { it["text"]!!.toString().trim('"') })
        assertEquals("""[{"type":"image","mimeType":"image/jpeg","data":"a.jpg"}]""", sends[0]["content"].toString())
    }

    @Test fun `unreadable pictures send nothing and give the words back`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.send("Look", listOf(java.io.File("gone.jpg"))) { throw java.io.IOException("gone") }
        advanceUntilIdle()
        assertTrue(agent.requests.none { it.second.endsWith("/send") })
        assertEquals("Look", chat.state.value.draft)
        assertEquals("Couldn't read the pictures to send.", chat.state.value.alert)
    }

    @Test fun `pictures fit one message up to the inline limits`() {
        val mib = 1024L * 1024
        assertTrue(InlinePictures.fit(List(5) { 5 * mib }))
        assertTrue(InlinePictures.fit(List(5) { 9 * mib }))
        assertFalse(InlinePictures.fit(List(6) { 5 * mib }))
    }

    @Test fun `default mode reads config defaults`() {
        val config = Json.parseToJsonElement("""{"config":{"defaults":{"providerId":"codex","modelId":"m","effort":"low","permissionMode":"auto"}}}""").jsonObject
        assertEquals(Mode("codex", "m", "low", null, "auto"), ConversationApi.defaultModeOf(config))
    }
}
