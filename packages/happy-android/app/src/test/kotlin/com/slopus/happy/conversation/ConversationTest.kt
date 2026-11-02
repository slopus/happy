package com.slopus.happy.conversation

import com.slopus.happy.connection.AgentConnectionException
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
    /** `POST /v0/tasks` and `/v0/bots` answer with this status and error instead. */
    var refuseCreate: Int? = null
    /** Every request waits for this first: the network held. */
    var gate: CompletableDeferred<Unit>? = null
    /** What `messages?after=` answers; null answers [page], as a daemon that ignores `after` would. */
    var afterPage: String? = null
    /** What `PUT /v0/workspaces/:id/file` wrote, by workspace and path. */
    val written = LinkedHashMap<String, ByteArray>()
    /** The next file writes refused with this status. */
    var refuseFiles = 0
    /** A question's answer is refused with this status. */
    var answerStatus: Int? = null

    val request: AgentRequest = { method, path, body, _ ->
        requests += Triple(method, path, body as? JsonObject)
        gate?.await()
        val route = path.substringBefore('?')
        when {
            (route == "/v0/tasks" || route == "/v0/bots") && refuseCreate != null -> TransportResponse(refuseCreate!!, body = """{"error":"Name already taken.","code":"conflict"}""".toByteArray())
            route == "/v0/bots" -> ok("""{"bot":{"id":${(body as JsonObject)["id"]},"agent":{"id":"${body["agentId"]!!.toString().trim('"')}","workspaceId":"w","status":"idle"}}}""")
            route == "/v0/tasks" -> ok("""{"task":{"id":${(body as JsonObject)["id"]},"agent":{"id":"${(body as JsonObject)["agentId"]!!.toString().trim('"')}","workspaceId":"w","status":"idle"}},"membership":{}}""")
            route.endsWith("/bootstrap") -> { beforeBootstrap(); ok(bootstrap) }
            method == "PUT" && route.startsWith("/v0/workspaces/") && route.endsWith("/file") -> {
                val o = body as JsonObject
                val key = route.removePrefix("/v0/workspaces/").removeSuffix("/file") + ":" + o["path"]!!.toString().trim('"')
                val bytes = java.util.Base64.getDecoder().decode(o["content"]!!.toString().trim('"'))
                fun hash(b: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
                val existing = written[key]
                when {
                    refuseFiles > 0 -> { refuseFiles--; TransportResponse(403, body = """{"error":"denied","code":"denied"}""".toByteArray()) }
                    existing != null -> TransportResponse(409, body = """{"code":"hash_mismatch","hash":"${hash(existing)}"}""".toByteArray())
                    else -> { written[key] = bytes; ok("""{"hash":"${hash(bytes)}"}""") }
                }
            }
            route.endsWith("/messages") && failOlder && "before=" in path -> TransportResponse(503, body = "{}".toByteArray())
            route.endsWith("/messages") && "after=" in path && afterPage != null -> ok(afterPage!!)
            route.endsWith("/messages") -> ok(page)
            route.endsWith("/send") && failSends > 0 -> { failSends--; TransportResponse(503, body = """{"error":"busy"}""".toByteArray()) }
            route.endsWith("/send") -> TransportResponse(sendStatus, body = """{"error":"Unknown model.","code":"invalid_request"}""".toByteArray())
            route.endsWith("/answer") && answerStatus != null -> TransportResponse(answerStatus!!, body = """{"error":"busy"}""".toByteArray())
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

    private fun TestScope.conversation(agent: FakeAgent, newTask: NewTask? = null, choice: WorkChoice = WorkChoice(), keeper: ConversationKeeper? = null, created: (JsonObject) -> Unit = {}) = Conversation(
        api = ConversationApi(agent.request),
        signals = signals,
        // Not backgroundScope: advanceUntilIdle leaves its work alone. Cancelled after each test.
        scope = CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob().also { jobs += it }),
        agentId = newTask?.agentId ?: "a1",
        newTask = newTask,
        initialChoice = choice,
        onTaskCreated = created,
        lane = StandardTestDispatcher(testScheduler),
        io = StandardTestDispatcher(testScheduler),
        now = { 1000 },
        retryDelayMillis = 1,
        keeper = keeper,
        disk = StandardTestDispatcher(testScheduler),
    ).also { it.start() }

    private fun event(type: String, payload: String) = ConversationSignal.Event(type, Json.parseToJsonElement(payload).jsonObject)

    @Test fun `covered conversation unsubscribes and catches up once on reveal`() = runTest {
        val agent = FakeAgent()
        val conversation = conversation(agent)
        advanceUntilIdle()
        assertEquals(1, signals.subscriptionCount.value)
        conversation.setObserving(false)
        advanceUntilIdle()
        assertEquals(0, signals.subscriptionCount.value)
        val before = agent.requests.size
        signals.emit(ConversationSignal.Resync)
        advanceUntilIdle()
        assertEquals(before, agent.requests.size)
        conversation.setObserving(true)
        conversation.setObserving(true)
        advanceUntilIdle()
        assertEquals(1, signals.subscriptionCount.value)
        assertEquals(2, agent.paths("GET").count { it.endsWith("/bootstrap") })
        assertTrue(conversation.state.value.loaded)
        assertFalse(conversation.state.value.syncing)
    }

    @Test fun `covering during bootstrap cancels the read and reveal retries it`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val agent = FakeAgent().apply { beforeBootstrap = { gate.await() } }
        val conversation = conversation(agent)
        testScheduler.runCurrent()
        assertTrue(conversation.state.value.syncing)
        conversation.setObserving(false)
        testScheduler.runCurrent()
        assertFalse(conversation.state.value.syncing)
        gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(conversation.state.value.loaded)
        conversation.setObserving(true)
        advanceUntilIdle()
        assertTrue(conversation.state.value.loaded)
        assertEquals(2, agent.paths("GET").count { it.endsWith("/bootstrap") })
    }

    @Test fun `a covered conversation still saves accepted draft writes`() = runTest {
        val agent = FakeAgent()
        val conversation = conversation(agent)
        advanceUntilIdle()
        conversation.setObserving(false)
        advanceUntilIdle()
        conversation.setDraft("kept while covered")
        advanceUntilIdle()
        assertTrue(agent.paths("PUT").any { it.endsWith("/draft") })
        assertEquals("kept while covered", conversation.state.value.draft)
        assertEquals(0, signals.subscriptionCount.value)
    }

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
        assertEquals("Hello", (chat.state.value.rows.single() as ConversationRow.Text).current)
        assertTrue(chat.state.value.working)
        val reads = agent.paths("GET").count { it.endsWith("/bootstrap") }
        signals.emit(event("message.delta", """{"agentId":"a1","runId":"r1","messageId":"m","blockIndex":0,"offset":9,"append":"x"}"""))
        advanceUntilIdle()
        assertEquals(reads + 1, agent.paths("GET").count { it.endsWith("/bootstrap") })
    }

    @Test fun `a delta goes to its streaming row alone, and the end of the run gives the rows the final words`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        signals.emit(event("run.started", """{"agentId":"a1","run":{"id":"r1","status":"running","startedAt":5},"acceptedMessageIds":[]}"""))
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"text","text":"One"}],"metadata":{}}}"""))
        advanceUntilIdle()
        val streaming = chat.state.value
        val row = streaming.rows.single() as ConversationRow.Text
        val live = checkNotNull(row.live) { "a streaming block has its live words" }
        val before = live.content.value
        for (word in listOf(" two", " **three**", "\n\n- four")) {
            signals.emit(event("message.delta", """{"agentId":"a1","runId":"r1","messageId":"m","blockIndex":0,"append":${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(word))}}"""))
        }
        advanceUntilIdle()
        // No new state: the bar, the composer and the list are given exactly what they had.
        assertTrue(streaming === chat.state.value)
        assertEquals("One two **three**\n\n- four", live.content.value.text)
        assertEquals(2, live.content.value.blocks.size)
        assertEquals("One two **three**\n\n- four", row.current)
        assertTrue(before !== live.content.value)

        signals.emit(event("run.finished", """{"agentId":"a1","runId":"r1"}"""))
        advanceUntilIdle()
        val done = chat.state.value.rows.single() as ConversationRow.Text
        assertNull(done.live)
        assertEquals("One two **three**\n\n- four", done.text)
        assertEquals(2, done.blocks.size)
    }

    @Test fun `a delta keeps the blocks it left alone`() {
        val first = com.slopus.happy.chat.markdown.parseMarkdown("Intro\n\n```kotlin\nval a = 1\n```\n\nTail")
        val next = com.slopus.happy.chat.markdown.parseMarkdown("Intro\n\n```kotlin\nval a = 1\n```\n\nTail grows")
        val kept = LiveText.reuse(first, next)
        assertTrue(kept[0] === first[0])
        assertTrue(kept[1] === first[1])
        assertTrue(kept[2] !== first[2])
        assertEquals(next, kept)
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
        assertEquals(Delivery.Failed(Problem.Said("Unknown model.")), row.delivery)
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
        // A task unless a bot is picked, unnamed, and the keyboard up in the composer.
        assertEquals(NewWork(WorkChoice(WorkKind.Task, "")), chat.state.value.newWork)
        assertEquals(ComposerFocus(1, 0), chat.state.value.composerFocus)
        // Only the picker's models are read.
        assertEquals(listOf("/v0/config"), agent.paths("GET"))
        assertTrue(agent.paths("POST").isEmpty())
        chat.setDraft("typed")
        advanceUntilIdle()
        // Nothing is saved for an agent that doesn't exist yet.
        assertEquals(listOf("/v0/config"), agent.requests.map { it.second })
        // The first send waits in the composer while the task is made, and a second meanwhile is dropped.
        assertFalse(chat.send("First"))
        assertFalse(chat.send("Dropped"))
        advanceUntilIdle()
        assertEquals("First", chat.state.value.taken?.text)
        chat.send("Second")
        advanceUntilIdle()
        assertEquals(1, agent.requests.count { it.second == "/v0/tasks" })
        val createBody = agent.requests.first { it.second == "/v0/tasks" }.third!!
        assertEquals("\"t1\"", createBody["id"].toString())
        assertEquals("\"a9\"", createBody["agentId"].toString())
        // Unnamed: the computer names it from its first message.
        assertFalse("name" in createBody)
        assertNull(chat.state.value.newWork)
        assertEquals(listOf("/v0/agents/a9/send", "/v0/agents/a9/send"), agent.paths("POST").filter { it.endsWith("/send") })
        // The default model at its own effort, as nothing was picked.
        assertEquals("\"high\"", agent.requests.first { it.second.endsWith("/send") }.third!!["mode"]!!.jsonObject["effort"].toString())
        assertTrue(chat.state.value.created)
        assertEquals("t1", made!!["task"]!!.jsonObject["id"].toString().trim('"'))
        assertEquals(listOf("Second", "First"), chat.state.value.rows.map { (it as ConversationRow.User).text })
    }

    @Test fun `Bot and a name make a bot under that name, then the message goes into it`() = runTest {
        val agent = FakeAgent()
        var made: JsonObject? = null
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1")) { made = it }
        advanceUntilIdle()
        chat.setChoice(WorkChoice(WorkKind.Bot, "  Release Bot "))
        advanceUntilIdle()
        assertEquals(WorkChoice(WorkKind.Bot, "  Release Bot "), chat.state.value.newWork?.choice)
        chat.send("Ship it")
        advanceUntilIdle()
        assertEquals(listOf("/v0/bots", "/v0/agents/a9/send"), agent.paths("POST").filter { it.startsWith("/v0/bots") || it.endsWith("/send") || it.startsWith("/v0/tasks") })
        val body = agent.requests.first { it.second == "/v0/bots" }.third!!
        assertEquals("\"Release Bot\"", body["name"].toString())
        assertEquals("\"t1\"", body["id"].toString())
        assertEquals("\"m1\"", body["mutationId"].toString())
        assertEquals("t1", made!!["bot"]!!.jsonObject["id"].toString().trim('"'))
        assertTrue(chat.state.value.created)
        // Made: nothing here changes it now.
        chat.setChoice(WorkChoice(WorkKind.Task, "Other"))
        advanceUntilIdle()
        assertNull(chat.state.value.newWork)
        assertEquals(listOf("Ship it"), chat.state.value.rows.map { (it as ConversationRow.User).text })
    }

    @Test fun `a refused new work sends nothing, keeps the words, says why, and tries again under the same ids`() = runTest {
        val agent = FakeAgent()
        agent.refuseCreate = 409
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"), WorkChoice(WorkKind.Bot, "Taken"))
        advanceUntilIdle()
        chat.setDraft("Hello")
        assertFalse(chat.send("Hello"))
        advanceUntilIdle()
        assertEquals(WorkFailure(WorkKind.Bot, Problem.Said("Name already taken.")), chat.state.value.workFailure)
        assertFalse(chat.state.value.created)
        assertTrue(chat.state.value.rows.isEmpty())
        assertNull(chat.state.value.taken)
        assertEquals("Hello", chat.state.value.draft)
        // Unlocked again: the name can change, and the next send asks again with the same ids.
        assertEquals(NewWork(WorkChoice(WorkKind.Bot, "Taken"), making = false), chat.state.value.newWork)
        chat.dismissAlert()
        chat.setChoice(WorkChoice(WorkKind.Bot, "Free"))
        agent.refuseCreate = null
        chat.send("Hello")
        advanceUntilIdle()
        assertNull(chat.state.value.workFailure)
        val bodies = agent.requests.filter { it.second == "/v0/bots" }.map { it.third!! }
        assertEquals(2, bodies.size)
        assertEquals(bodies[0]["mutationId"], bodies[1]["mutationId"])
        assertEquals("\"Free\"", bodies[1]["name"].toString())
        assertTrue(chat.state.value.created)
        assertEquals("Hello", chat.state.value.taken?.text)
    }

    @Test fun `while new work is being made its choice is fixed`() = runTest {
        val agent = FakeAgent()
        val gate = CompletableDeferred<Unit>()
        val request = agent.request
        val chat = Conversation(
            api = ConversationApi { method, path, body, category -> if (path == "/v0/tasks") gate.await(); request(method, path, body, category) },
            signals = signals,
            scope = CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob().also { jobs += it }),
            agentId = "a9",
            newTask = NewTask("t1", "w1", "a9", "m1"),
            lane = StandardTestDispatcher(testScheduler),
            now = { 1000 },
            retryDelayMillis = 1,
        ).also { it.start() }
        advanceUntilIdle()
        chat.send("Go")
        advanceUntilIdle()
        assertEquals(true, chat.state.value.newWork?.making)
        chat.setChoice(WorkChoice(WorkKind.Bot, "Late"))
        advanceUntilIdle()
        assertEquals(WorkChoice(), chat.state.value.newWork?.choice)
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue(chat.state.value.created)
        assertEquals(0, agent.requests.count { it.second == "/v0/bots" })
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
        assertEquals("chief", ConversationApi { _, _, _, _ -> FakeAgent.ok(bots) }.chiefOfStaffAgentId())
        assertNull(ConversationApi { _, _, _, _ -> FakeAgent.ok("""{"bots":[]}""") }.chiefOfStaffAgentId())
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

    @Test fun `a question waits at the end and settles answered in its turn`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        val args = """{"questions":[{"id":"p1","header":"DB","question":"Which?","multiSelect":false,"options":[{"label":"Postgres"},{"label":"SQLite"}]}]}"""
        signals.emit(event("run.started", """{"agentId":"a1","run":{"id":"r1","status":"running","startedAt":5},"acceptedMessageIds":[]}"""))
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"text","text":"Picking storage."},{"type":"tool_call","id":"q1","name":"request_user_input","status":"running","arguments":$args}],"metadata":{}}}"""))
        advanceUntilIdle()
        // Asked, not yet read as a question: the call's row is left out rather than shown as a tool.
        assertTrue(chat.state.value.rows.none { it is ConversationRow.Tool })
        signals.emit(event("question.created", """{"question":{"id":"q1","agentId":"a1","status":"pending","questions":[{"id":"p1","header":"DB","question":"Which?","multiSelect":false,"options":[{"label":"Postgres"},{"label":"SQLite"}]}]}}"""))
        advanceUntilIdle()
        // Waiting: pinned to the end, under the work (rows are newest first).
        val waiting = chat.state.value.rows.first() as ConversationRow.Ask
        assertEquals(AskPhase.Pending, waiting.phase)
        assertEquals(1, chat.state.value.rows.count { it is ConversationRow.Ask })
        chat.answer("q1", mapOf("p1" to listOf("Postgres")))
        advanceUntilIdle()
        // Answered: it stays where it was asked, under the words before it, saying what was answered.
        val rows = chat.state.value.rows.asReversed()
        val settled = rows.single { it is ConversationRow.Ask } as ConversationRow.Ask
        assertEquals(AskPhase.Answered, settled.phase)
        assertEquals(mapOf("p1" to listOf("Postgres")), settled.question.answers)
        assertEquals(waiting.key, settled.key)
        assertEquals(rows.indexOfFirst { it is ConversationRow.Text } + 1, rows.indexOf(settled))
        // History read again says the same from the call's result.
        val output = "Request q1:\nWhich?\nStatus: Answered\nAnswer:\nSelected: Postgres"
        signals.emit(event("message.updated", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"text","text":"Picking storage."},{"type":"tool_call","id":"q1","name":"request_user_input","status":"completed","arguments":$args,"result":{"output":${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(output))}}}],"metadata":{}}}"""))
        advanceUntilIdle()
        val read = chat.state.value.rows.single { it is ConversationRow.Ask } as ConversationRow.Ask
        assertEquals(AskPhase.Answered, read.phase)
        assertEquals(listOf("Postgres"), read.question.answers?.get("p1"))
    }

    @Test fun `a refused answer says why and may go again`() = runTest {
        val agent = FakeAgent()
        agent.answerStatus = 500
        val chat = conversation(agent)
        advanceUntilIdle()
        signals.emit(event("question.created", """{"question":{"id":"q1","agentId":"a1","status":"pending","questions":[{"id":"p1","question":"Which?","options":[{"label":"Postgres"}]}]}}"""))
        advanceUntilIdle()
        runCatching { chat.answer("q1", mapOf("p1" to listOf("Postgres"))) }
        advanceUntilIdle()
        val ask = chat.state.value.rows.first() as ConversationRow.Ask
        assertTrue(ask.phase is AskPhase.Failed)
        assertEquals("q1", chat.state.value.question?.id)
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

    @Test fun `a subtask the person can talk to is sendable`() = runTest {
        val agent = FakeAgent()
        agent.bootstrap = """{"agent":{"id":"a1","workspaceId":"w1","parentAgentId":"p1","subtask":true,"canSendMessages":true,"status":"idle"},"pending":[]}"""
        val chat = conversation(agent)
        advanceUntilIdle()
        assertTrue(chat.state.value.canSend)
    }

    @Test fun `an internal subagent driven by its parent is not sendable`() = runTest {
        val agent = FakeAgent()
        agent.bootstrap = """{"agent":{"id":"a1","workspaceId":"w1","parentAgentId":"p1","canSendMessages":false,"status":"idle"},"pending":[]}"""
        val chat = conversation(agent)
        advanceUntilIdle()
        assertFalse(chat.state.value.canSend)
    }

    @Test fun `archiving stops sends and restoring brings them back, live`() = runTest {
        val agent = FakeAgent()
        agent.bootstrap = """{"agent":{"id":"a1","workspaceId":"w1","parentAgentId":"p1","subtask":true,"canSendMessages":true,"status":"idle"},"pending":[]}"""
        val chat = conversation(agent)
        advanceUntilIdle()
        assertTrue(chat.state.value.canSend)
        signals.emit(event("agent.updated", """{"agentId":"a1","changes":{"archivedAt":7,"canSendMessages":false,"updatedAt":7}}"""))
        advanceUntilIdle()
        assertFalse(chat.state.value.canSend)
        signals.emit(event("agent.updated", """{"agentId":"a1","changes":{"archivedAt":null,"canSendMessages":true,"updatedAt":8}}"""))
        advanceUntilIdle()
        assertTrue(chat.state.value.canSend)
    }

    @Test fun `without canSendMessages, the daemon's rule decides`() {
        fun info(json: String) = AgentInfo.parse(Json.parseToJsonElement(json))!!
        assertTrue(info("""{"id":"a"}""").sendable)
        assertTrue(info("""{"id":"a","parentAgentId":"p","subtask":true}""").sendable)
        assertFalse(info("""{"id":"a","parentAgentId":"p"}""").sendable)
        assertFalse(info("""{"id":"a","archivedAt":5}""").sendable)
        assertFalse(info("""{"id":"a","parentAgentId":"p","subtask":true,"archivedAt":5}""").sendable)
        // The field wins over the fallback either way.
        assertTrue(info("""{"id":"a","parentAgentId":"p","canSendMessages":true}""").sendable)
        assertFalse(info("""{"id":"a","canSendMessages":false}""").sendable)
        // An archive without the field falls back to archivedAt.
        assertFalse(info("""{"id":"a"}""").merge(Json.parseToJsonElement("""{"archivedAt":5}""").jsonObject).sendable)
    }

    @Test fun `failures read as desktop's card and retry`() = runTest {
        val agent = FakeAgent()
        agent.page = """{"runs":[{"id":"r1","status":"failed","messages":[
            {"id":"f1","role":"service","createdAt":1,"content":[{"type":"text","text":"Claude usage limit reached."}],"metadata":{},"failure":{"kind":"usage_limit","message":"x","provider":{"id":"claude","vendorName":"Claude","label":"claude"},"fallbackProviders":[]}}
        ]}],"hasMore":false}"""
        val chat = conversation(agent)
        advanceUntilIdle()
        val failure = chat.state.value.rows.single() as ConversationRow.Failure
        assertEquals(FailureReason.UsageLimit("Claude"), failure.reason)
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
        val files = listOf(preview("a.jpg", "image/jpeg", 10))
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
        chat.send("Look", listOf(preview("gone.jpg", "image/jpeg", 10))) { throw java.io.IOException("gone") }
        advanceUntilIdle()
        assertTrue(agent.requests.none { it.second.endsWith("/send") })
        assertEquals("Look", chat.state.value.draft)
        assertEquals(Problem.PicturesUnreadable, chat.state.value.alert)
    }

    @Test fun `files go into the workspace first and the message names them`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val video = java.io.File(dir, "clip.mp4").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val doc = java.io.File(dir, "notes.pdf").apply { writeBytes(byteArrayOf(4, 5)) }
        val attachments = listOf(
            preview("a.jpg", "image/jpeg", 10),
            preview(video.toURI().toString(), "video/mp4", 3, name = "clip.mp4"),
            preview(doc.toURI().toString(), "application/pdf", 2, name = "notes.pdf"),
        )
        assertTrue(chat.send("Look", attachments) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        advanceUntilIdle()
        val send = agent.requests.last { it.second.endsWith("/send") }
        val id = send.third!!["id"]!!.toString().trim('"')
        assertEquals(listOf("w1:.happy-uploads/$id/1-clip.mp4", "w1:.happy-uploads/$id/2-notes.pdf"), agent.written.keys.toList())
        assertEquals(listOf<Byte>(1, 2, 3), agent.written.values.first().toList())
        val puts = agent.requests.indexOfFirst { it.first == "PUT" }
        assertTrue("uploads before the send", puts < agent.requests.indexOf(send))
        assertEquals(
            "Look\n\nAttached files:\n- ./.happy-uploads/$id/1-clip.mp4\n- ./.happy-uploads/$id/2-notes.pdf",
            (send.third!!["text"] as kotlinx.serialization.json.JsonPrimitive).content,
        )
        assertEquals(1, (send.third!!["content"] as kotlinx.serialization.json.JsonArray).size)
        val row = chat.state.value.rows.filterIsInstance<ConversationRow.User>().first()
        assertTrue(row.text.contains("./.happy-uploads/$id/1-clip.mp4"))
    }

    @Test fun `a refused upload fails the send and a retry writes only what is missing`() = runTest {
        val agent = FakeAgent()
        agent.refuseFiles = 1
        val chat = conversation(agent)
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val doc = java.io.File(dir, "notes.txt").apply { writeText("hi") }
        assertTrue(chat.send("", listOf(preview(doc.toURI().toString(), "text/plain", 2, name = "notes.txt"))))
        advanceUntilIdle()
        assertTrue(agent.requests.none { it.second.endsWith("/send") })
        val failed = chat.state.value.rows.filterIsInstance<ConversationRow.User>().single()
        assertTrue(failed.delivery is Delivery.Failed)
        chat.retrySend(failed.messageId)
        advanceUntilIdle()
        assertEquals(1, agent.written.size)
        assertEquals(1, agent.requests.count { it.second.endsWith("/send") })
    }

    @Test fun `a lost upload answer counts as written when the same bytes are there`() = runTest {
        val agent = FakeAgent()
        val api = ConversationApi(agent.request)
        api.uploadFile("w1", "a.txt", "hi".toByteArray())
        api.uploadFile("w1", "a.txt", "hi".toByteArray())
        val refused = runCatching { api.uploadFile("w1", "a.txt", "other".toByteArray()) }.exceptionOrNull()
        assertTrue(refused is ConversationApiException && refused.status == 409)
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

    // Offline first: the kept history opens the chat from disk; the agent is asked only for what came after it.

    private class MemoryKeeper(var value: JsonObject? = null) : ConversationKeeper {
        var writes = 0
        override fun read(): JsonObject? = value
        override fun write(value: JsonObject) {
            writes++
            this.value = value
        }
    }

    private fun message(id: String, role: String, text: String) =
        """{"id":"$id","role":"$role","createdAt":1,"content":[{"type":"text","text":"$text"}],"metadata":{}}"""

    private fun run(id: String, status: String, vararg messages: String) =
        """{"id":"$id","status":"$status","startedAt":1,"messages":[${messages.joinToString(",")}]}"""

    private fun kept(hasMore: Boolean, vararg runs: String): JsonObject =
        Json.parseToJsonElement("""{"version":1,"hasMore":$hasMore,"pending":[],"runs":[${runs.joinToString(",")}]}""").jsonObject

    private val keptTwoRuns get() = kept(
        true,
        run("r1", "completed", message("m1", "user", "Hi"), message("m2", "agent", "Hello")),
        run("r2", "completed", message("m3", "user", "Fix it"), message("m4", "agent", "Fixed")),
    )

    @Test fun `a kept chat shows from disk before the agent answers anything`() = runTest {
        val agent = FakeAgent().apply { gate = CompletableDeferred() }
        val chat = conversation(agent, keeper = MemoryKeeper(keptTwoRuns))
        advanceUntilIdle()
        val state = chat.state.value
        assertTrue(state.loaded)
        assertTrue(state.syncing)
        assertTrue(state.hasMore)
        assertEquals(listOf("m4:0", "m3:user", "m2:0", "m1:user"), state.rows.map { it.key })
        assertEquals("Fixed", (state.rows[0] as ConversationRow.Text).text)
        agent.gate!!.complete(Unit)
    }

    @Test fun `a kept chat catches up after its newest finished run and keeps the older runs`() = runTest {
        val agent = FakeAgent()
        agent.afterPage = """{"runs":[${run("r3", "completed", message("m5", "user", "More"), message("m6", "agent", "Done"))}],"hasMore":false}"""
        val keeper = MemoryKeeper(keptTwoRuns)
        val chat = conversation(agent, keeper = keeper)
        advanceUntilIdle()
        val reads = agent.requests.map { it.second }.filter { "/messages" in it }
        assertEquals(1, reads.size)
        assertTrue(reads.single(), "after=m4" in reads.single())
        assertEquals(listOf("m6:0", "m5:user", "m4:0", "m3:user", "m2:0", "m1:user"), chat.state.value.rows.map { it.key })
        // Older history is still on the agent, as it was before the catch-up.
        assertTrue(chat.state.value.hasMore)
        // And what it shows now is kept for next time.
        assertTrue(keeper.writes > 0)
        assertEquals(listOf("r1", "r2", "r3"), KeptConversation.parse(keeper.value)!!.runs.map { it.id })
    }

    @Test fun `a newest run that was still going is read again whole`() = runTest {
        val agent = FakeAgent()
        agent.afterPage = """{"runs":[${run("r2", "completed", message("m3", "user", "Fix it"), message("m4", "agent", "Fixed"))}],"hasMore":false}"""
        val keeper = MemoryKeeper(kept(false, run("r1", "completed", message("m1", "user", "Hi"), message("m2", "agent", "Hello")), run("r2", "running", message("m3", "user", "Fix it"))))
        val chat = conversation(agent, keeper = keeper)
        advanceUntilIdle()
        val read = agent.requests.map { it.second }.single { "/messages" in it }
        assertTrue(read, "after=m2" in read)
        assertEquals(listOf("m4:0", "m3:user", "m2:0", "m1:user"), chat.state.value.rows.map { it.key })
    }

    @Test fun `a daemon that ignores after is read as the newest page`() = runTest {
        val agent = FakeAgent()
        // No afterPage: the daemon answers the newest page, the anchor in it.
        agent.page = """{"runs":[${run("r2", "completed", message("m3", "user", "Fix it"), message("m4", "agent", "Fixed"))}],"hasMore":true}"""
        val chat = conversation(agent, keeper = MemoryKeeper(keptTwoRuns))
        advanceUntilIdle()
        assertEquals(listOf("m4:0", "m3:user"), chat.state.value.rows.map { it.key })
        assertTrue(chat.state.value.hasMore)
    }

    @Test fun `offline, a kept chat stays on screen and says why it could not catch up`() = runTest {
        val agent = FakeAgent()
        agent.beforeBootstrap = { throw AgentConnectionException(AgentConnectionException.Reason.Unavailable) }
        val chat = conversation(agent, keeper = MemoryKeeper(keptTwoRuns))
        advanceUntilIdle()
        val state = chat.state.value
        assertTrue(state.loaded)
        assertFalse(state.syncing)
        assertTrue(state.error != null)
        assertEquals(4, state.rows.size)
    }

    @Test fun `a kept conversation reads back as it was written`() {
        val kept = KeptConversation(
            runs = listOf(
                Run(
                    "r1", "completed", 5,
                    listOf(
                        Message("m1", "user", 1, listOf(Block.Text("Hi"), Block.Image("image/png", "AAAA"))),
                        Message(
                            "m2", "agent", 2,
                            listOf(
                                Block.Reasoning("hmm"),
                                Block.ToolCall("c1", "Bash", "completed", Presentation.Command("ls", "a\nb")),
                                Block.ToolCall("c2", "Shot", "completed", Presentation.Media(listOf(MediaItem("image", "a.png", "image/png", 10.0, 20.0, 2.0, "th", 99.0)), columns = 2)),
                                Block.ToolCall("c3", "Art", "completed", Presentation.Artifact("ar1", "markdown", "Notes", 3, "page")),
                                Block.Compaction("completed"),
                                Block.Unknown("future"),
                            ),
                            senderAgentId = "a2",
                        ),
                    ),
                ),
            ),
            pending = listOf(Message("m3", "user", 3, listOf(Block.Text("Next")), status = "pending")),
            hasMore = true,
            agent = AgentInfo("a1", "w1", null, "Fix it", "idle", null, null, 1, 2, 0, 1, canSendMessages = true, subtask = false),
            mode = Mode("codex", "m", "low", null, "auto"),
        )
        assertEquals(kept, KeptConversation.parse(Json.parseToJsonElement(kept.json().toString()).jsonObject))
    }
}

private fun preview(uri: String, mimeType: String, size: Long, name: String = uri.substringAfterLast('/')) =
    com.slopus.happy.attachments.AttachmentPreview(id = uri, uri = uri, width = 0, height = 0, mimeType = mimeType, size = size, name = name)
