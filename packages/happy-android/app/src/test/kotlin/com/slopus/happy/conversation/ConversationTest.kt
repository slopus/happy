package com.slopus.happy.conversation

import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.Effort
import com.slopus.happy.analytics.ErrorArea
import com.slopus.happy.analytics.ErrorCode
import com.slopus.happy.analytics.MessageSource
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
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import kotlinx.coroutines.test.runCurrent
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
    /** A slash command's invocation answers this status; accepted, with [commandsAfter] as the catalog. */
    var commandStatus = 202
    /** A send writes half its body, then waits for this before writing the rest and answering. */
    var halfway: CompletableDeferred<Unit>? = null
    /** Happy Cloud attachments uploaded (`PUT /v0/agents/:id/attachments?name=`): name, type and bytes; null answers 404, a server without the route. */
    var attachments: ArrayList<Triple<String, String, ByteArray>>? = ArrayList()
    /** A computer's attachments routes (`…/attachments/:sha256`); null answers them 404, as an older computer does. */
    var daemon: FakeAttachments? = null
    /** Sends to [attachments]' route, and to [daemon]'s. */
    val fileRequest: AgentFileRequest = { method, path, body, headers ->
        requests += Triple(method, path, null)
        val uploads = attachments
        val contentType = headers["Content-Type"].orEmpty()
        val chunked = daemon
        when {
            chunked != null && "/attachments/" in path -> chunked.request(method, path, body, headers)
            method != "PUT" || !path.substringBefore('?').endsWith("/attachments") -> TransportResponse(404, body = "{}".toByteArray())
            uploads == null -> TransportResponse(404, body = """{"error":"Not found.","code":"not_found"}""".toByteArray())
            else -> {
                val name = java.net.URLDecoder.decode(path.substringAfter("name="), "UTF-8")
                uploads += Triple(name, contentType, body)
                val id = java.security.MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
                TransportResponse(201, body = """{"attachment":{"id":"$id","name":"$name","mimeType":"$contentType","size":${body.size}}}""".toByteArray())
            }
        }
    }
    /** What `GET /v0/config` answers. */
    var config = CONFIG
    var commandsAfter = """[{"name":"compact","hasArguments":false,"description":"Summarize.","kind":"compaction"}]"""
    /** `GET /v0/skills`'s pages by `pageCursor`, null the first; with none it answers 404, a computer without skills. */
    var skillPages: Map<String?, String> = emptyMap()
    /** The next reads of a later skills page answer 409: the catalog changed under them. */
    var skillConflicts = 0

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
            route.endsWith("/send") && halfway != null -> {
                val bytes = body.toString().toByteArray()
                val progress = kotlinx.coroutines.currentCoroutineContext()[com.slopus.happy.connection.BodyProgress]
                progress?.report(bytes, bytes.size / 2)
                halfway!!.await()
                progress?.report(bytes, bytes.size)
                TransportResponse(202, body = "{}".toByteArray())
            }
            route.endsWith("/send") && failSends > 0 -> { failSends--; TransportResponse(503, body = """{"error":"busy"}""".toByteArray()) }
            route.endsWith("/send") -> TransportResponse(sendStatus, body = """{"error":"Unknown model.","code":"invalid_request"}""".toByteArray())
            route.endsWith("/answer") && answerStatus != null -> TransportResponse(answerStatus!!, body = """{"error":"busy"}""".toByteArray())
            method == "POST" && "/slash-commands/" in route -> if (commandStatus == 202) {
                TransportResponse(202, body = """{"agent":{"id":"a1","workspaceId":"w1","status":"working","title":"Fix it"},"profiles":[],"slashCommands":$commandsAfter,"command":{"name":"compact","hasArguments":false,"description":"Summarize."},"cursor":"c1"}""".toByteArray())
            } else {
                TransportResponse(commandStatus, body = """{"error":"The daemon's own words.","code":"conflict"}""".toByteArray())
            }
            route == "/v0/config" -> ok(config)
            route == "/v0/skills" -> {
                val cursor = path.substringAfter("pageCursor=", "").takeIf { it.isNotEmpty() }
                when {
                    cursor != null && skillConflicts > 0 -> { skillConflicts--; TransportResponse(409, body = """{"error":"Changed.","code":"conflict"}""".toByteArray()) }
                    else -> skillPages[cursor]?.let(::ok) ?: TransportResponse(404, body = """{"error":"Not found.","code":"not_found"}""".toByteArray())
                }
            }
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
    /** What the conversations record for analytics, `error_shown` included. */
    private val recorded = ArrayList<AnalyticsEvent>()

    @After fun cancel() = jobs.forEach { it.cancel() }

    private fun TestScope.conversation(
        agent: FakeAgent,
        newTask: NewTask? = null,
        choice: WorkChoice = WorkChoice(),
        keeper: ConversationKeeper? = null,
        typesetter: RowTypesetter? = null,
        preferences: kotlinx.coroutines.flow.StateFlow<ModelPreferences>? = null,
        started: (Mode) -> Unit = {},
        cloudFiles: Boolean = false,
        // An older computer unless a test says otherwise: pictures inline, files in the workspace.
        route: AttachmentRoute = AttachmentRoute().apply { missing = true },
        kept: MutableMap<String, java.io.File> = HashMap(),
        created: (JsonObject) -> Unit = {},
    ) = Conversation(
        api = ConversationApi(null, agent.request, fileRequest = agent.fileRequest),
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
        typesetter = typesetter,
        preferences = preferences,
        onStarted = started,
        record = { recorded += it },
        errorShown = { area, code -> recorded += AnalyticsEvent.ErrorShown(area, code) },
        cloudFiles = cloudFiles,
        attachmentRoute = route,
        keepAttachment = { id, file -> kept[id] = file },
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

    /** The call reads the rows the chat draws, newest first, as turns oldest first: each answer with its own question. */
    @Test fun `a call reads a conversation's turns each with its own message`() = runTest {
        val agent = FakeAgent()
        agent.page = """{"runs":[
          {"id":"r1","status":"completed","startedAt":1,"endedAt":3,"messages":[
            {"id":"u1","role":"user","createdAt":1,"content":[{"type":"text","text":"First question"}],"metadata":{}},
            {"id":"a1","role":"agent","createdAt":2,"content":[{"type":"text","text":"First answer"}],"metadata":{}}]},
          {"id":"r2","status":"completed","startedAt":4,"endedAt":6,"messages":[
            {"id":"u2","role":"user","createdAt":4,"content":[{"type":"text","text":"Second question"}],"metadata":{}},
            {"id":"a2","role":"agent","createdAt":5,"content":[{"type":"text","text":"Second answer"}],"metadata":{}}]}
        ],"hasMore":false}"""
        val chat = conversation(agent)
        advanceUntilIdle()
        val target = com.slopus.happy.call.CallTarget("a1", "Fix it", com.slopus.happy.call.CallTarget.Kind.Task, com.slopus.happy.call.CallTarget.Status.Idle)
        val read = com.slopus.happy.call.CallTargetState.from(chat.state.value, target)
        assertEquals(
            listOf(
                com.slopus.happy.call.CallTurn("r1", "First question", "First answer", endedAt = 3),
                com.slopus.happy.call.CallTurn("r2", "Second question", "Second answer", endedAt = 6),
            ),
            read.turns,
        )
        assertNull(read.unanswered)
        assertEquals(listOf("First question", "First answer", "Second question", "Second answer"), read.messages.map { it.text })
        assertEquals(listOf(null, "r1", null, "r2"), read.messages.map { it.turn })
        // The person's next message, taken but not answered yet, is the one waiting.
        agent.bootstrap = agent.bootstrap.replace("\"pending\":[]", """"pending":[{"id":"u3","role":"user","status":"pending","createdAt":7,"content":[{"type":"text","text":"Third question"}],"metadata":{}}]""")
        val waiting = conversation(agent)
        advanceUntilIdle()
        val later = com.slopus.happy.call.CallTargetState.from(waiting.state.value, target)
        assertEquals(listOf("First question", "Second question"), later.turns.map { it.user })
        assertEquals("Third question", later.unanswered?.text)
    }

    /**
     * The call reads the conversation as exchanges (iOS `CallReadTests`): each run's last words are its answer, tool
     * calls after them or not, never its earlier words; a steered run and the agent's own run go on with the exchange
     * before them; the person's message still being answered is the one waiting.
     */
    @Test fun `a call reads a conversation as exchanges of the person's message and the last words`() = runTest {
        fun run(id: String, user: String?, reason: String?, vararg content: String): String {
            val blocks = content.mapIndexed { index, part ->
                if (part.startsWith("call:")) """{"type":"tool_call","id":"$id-$index","name":"exec_command","status":"completed"}"""
                else """{"type":"text","text":"$part"}"""
            }
            val messages = listOfNotNull(
                user?.let { """{"id":"u-$id","role":"user","createdAt":1,"content":[{"type":"text","text":"$it"}],"metadata":{}}""" },
                """{"id":"m-$id","role":"agent","createdAt":2,"content":[${blocks.joinToString(",")}],"metadata":{}}""",
            )
            val status = when (reason) { null -> "running"; "steering" -> "aborted"; "error" -> "failed"; else -> "completed" }
            val ended = reason?.let { ""","reason":"$it","endedAt":2""" }.orEmpty()
            return """{"id":"$id","status":"$status","startedAt":1$ended,"messages":[${messages.joinToString(",")}]}"""
        }
        val agent = FakeAgent()
        agent.page = """{"runs":[${listOf(
            run("r1", "Fix the build", "completed", "Looking.", "call:", "Fixed it.", "call:"),
            run("r2", "Why did it fail?", "steering", "Checking the logs.", "call:"),
            run("r3", "And add a test", "completed", "The lockfile changed; the test is in.", "call:"),
            run("r4", null, "completed", "The subagent's checks are green.", "call:"),
            run("r5", "Ship it", "completed", "Shipped."),
            run("r6", "Now the docs", null, "Writing"),
        ).joinToString(",")}],"hasMore":false}"""
        val chat = conversation(agent)
        advanceUntilIdle()
        val target = com.slopus.happy.call.CallTarget("a1", "Fix it", com.slopus.happy.call.CallTarget.Kind.Task, com.slopus.happy.call.CallTarget.Status.Idle)
        val read = com.slopus.happy.call.CallTargetState.from(chat.state.value, target)
        assertEquals(listOf("r1", "r2", "r5"), read.exchanges.map { it.id })
        assertEquals(listOf("Fix the build", "Why did it fail?", "Ship it"), read.exchanges.map { it.user })
        assertEquals(listOf("Fixed it.", "The subagent's checks are green.", "Shipped."), read.exchanges.map { it.reply })
        assertEquals("Now the docs", read.unanswered?.text)
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
        assertEquals(Presentation.Command("ls", null), (state.rows[2] as ConversationRow.Tool).tool.presentation)
    }

    @Test fun `a person's message opens whole and is cut back by its key, pending or in a run`() = runTest {
        val agent = FakeAgent()
        agent.page = """{"runs":[{"id":"r1","status":"completed","messages":[
            {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Hi"}],"metadata":{}}
        ]}],"hasMore":false}"""
        agent.bootstrap = agent.bootstrap.replace("\"pending\":[]", """"pending":[{"id":"m3","role":"user","status":"pending","createdAt":3,"content":[{"type":"text","text":"Next"}],"metadata":{}}]""")
        val chat = conversation(agent)
        advanceUntilIdle()
        fun opened() = chat.state.value.rows.filterIsInstance<ConversationRow.User>().filter { it.opened }.map { it.key }
        assertEquals(emptyList<String>(), opened())
        chat.toggleMessage("m1:user")
        chat.toggleMessage("m3:user")
        advanceUntilIdle()
        assertEquals(listOf("m3:user", "m1:user"), opened())
        chat.toggleMessage("m1:user")
        advanceUntilIdle()
        assertEquals(listOf("m3:user"), opened())
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
        // Only the picker's models and the computer's skills are read.
        assertEquals(setOf("/v0/config", "/v0/skills"), agent.paths("GET").toSet())
        assertTrue(agent.paths("POST").isEmpty())
        chat.setDraft("typed")
        advanceUntilIdle()
        // Nothing is saved for an agent that doesn't exist yet.
        assertEquals(setOf("/v0/config", "/v0/skills"), agent.requests.map { it.second.substringBefore('?') }.toSet())
        // Both are drawn at once and go once the task is made (iOS c344a0cb3).
        assertTrue(chat.send("First"))
        assertTrue(chat.send("Second"))
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

    @Test fun `a new chat opens on the person's last start and records its own once its first message is in`() = runTest {
        val agent = FakeAgent()
        // The made chat's bootstrap names no mode: what is shown after is this phone's own.
        agent.bootstrap = """{"agent":{"id":"a9","workspaceId":"w1","status":"idle"},"draft":{"value":null,"updatedAt":null},"pending":[]}"""
        val preferences = kotlinx.coroutines.flow.MutableStateFlow(
            ModelPreferences(defaultModelId = "openai/gpt-5.6-sol", defaultEffort = "xhigh", providerId = "codex", memory = listOf(ModelMemory("codex", "openai/gpt-5.6-sol", "low", "priority"))),
        )
        val starts = ArrayList<Mode>()
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"), preferences = preferences, started = { starts += it })
        advanceUntilIdle()
        // Shown before anything is sent: the model, account, effort and speed the preferences say.
        assertEquals(Mode("codex", "openai/gpt-5.6-sol", "xhigh", "priority", "auto"), chat.state.value.mode)
        // Changed on another device while the chat is still unpicked: it follows.
        preferences.value = preferences.value.copy(defaultModelId = "anthropic/opus-5", defaultEffort = "max")
        advanceUntilIdle()
        assertEquals(Mode("claude", "anthropic/opus-5", "max", null, "auto"), chat.state.value.mode)
        chat.send("First")
        chat.send("Second")
        advanceUntilIdle()
        val sent = agent.requests.first { it.second.endsWith("/send") }.third!!["mode"]!!.jsonObject
        assertEquals("\"anthropic/opus-5\"", sent["modelId"].toString())
        assertEquals("\"max\"", sent["effort"].toString())
        // Recorded once, for the first message alone.
        assertEquals(listOf(Mode("claude", "anthropic/opus-5", "max", null, "auto")), starts)
        // Started: a later change of preferences leaves this chat's mode alone.
        preferences.value = preferences.value.copy(defaultModelId = "openai/gpt-5.6-luna")
        advanceUntilIdle()
        assertEquals("anthropic/opus-5", chat.state.value.mode?.modelId)
    }

    @Test fun `a pick on a new chat wins over the preferences, and is what gets recorded`() = runTest {
        val agent = FakeAgent()
        val preferences = kotlinx.coroutines.flow.MutableStateFlow(ModelPreferences(defaultModelId = "openai/gpt-5.6-sol"))
        val starts = ArrayList<Mode>()
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"), preferences = preferences, started = { starts += it })
        advanceUntilIdle()
        val picked = Mode("codex", "openai/gpt-5.6-luna", "low", null, "read_only")
        chat.setMode(picked)
        advanceUntilIdle()
        preferences.value = ModelPreferences(defaultModelId = "anthropic/opus-5")
        advanceUntilIdle()
        assertEquals(picked, chat.state.value.mode)
        chat.send("Go")
        advanceUntilIdle()
        assertEquals(listOf(picked), starts)
    }

    @Test fun `an existing chat records no start and keeps the catalog default when nothing was picked`() = runTest {
        val agent = FakeAgent()
        agent.bootstrap = """{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Fix it"},"draft":{"value":null,"updatedAt":null},"pending":[]}"""
        val starts = ArrayList<Mode>()
        val chat = conversation(agent, preferences = kotlinx.coroutines.flow.MutableStateFlow(ModelPreferences(defaultModelId = "openai/gpt-5.6-sol")), started = { starts += it })
        advanceUntilIdle()
        chat.send("More")
        advanceUntilIdle()
        assertEquals("\"anthropic/opus-5\"", agent.requests.first { it.second.endsWith("/send") }.third!!["mode"]!!.jsonObject["modelId"].toString())
        assertTrue(starts.isEmpty())
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

    @Test fun `a refused new work leaves its first message failed and Retry asks again under the same ids`() = runTest {
        val agent = FakeAgent()
        agent.refuseCreate = 409
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"), WorkChoice(WorkKind.Bot, "Taken"))
        advanceUntilIdle()
        chat.setDraft("Hello")
        assertTrue(chat.send("Hello"))
        advanceUntilIdle()
        // Drawn and the composer cleared; nothing goes back into it, and the choice stays fixed.
        assertFalse(chat.state.value.created)
        assertEquals("", chat.state.value.draft)
        val row = chat.state.value.rows.single() as ConversationRow.User
        assertEquals("Hello", row.text)
        assertEquals(Delivery.Failed(Problem.Said("Name already taken.")), row.delivery)
        assertEquals(NewWork(WorkChoice(WorkKind.Bot, "Taken"), locked = true), chat.state.value.newWork)
        chat.setChoice(WorkChoice(WorkKind.Bot, "Free"))
        advanceUntilIdle()
        assertEquals(WorkChoice(WorkKind.Bot, "Taken"), chat.state.value.newWork?.choice)
        assertTrue(agent.paths("POST").none { it.endsWith("/send") })
        agent.refuseCreate = null
        chat.retrySend(row.messageId)
        advanceUntilIdle()
        val bodies = agent.requests.filter { it.second == "/v0/bots" }.map { it.third!! }
        assertEquals(2, bodies.size)
        assertEquals(bodies[0]["mutationId"], bodies[1]["mutationId"])
        assertEquals(bodies[0]["id"], bodies[1]["id"])
        assertTrue(chat.state.value.created)
        assertEquals(listOf("/v0/agents/a9/send"), agent.paths("POST").filter { it.endsWith("/send") })
        assertEquals(listOf("Hello"), chat.state.value.rows.map { (it as ConversationRow.User).text })
    }

    @Test fun `a message is counted once as it is sent, with its mode then, whether or not the computer takes it`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        val gate = CompletableDeferred<Unit>()
        agent.gate = gate
        agent.failSends = 3
        assertTrue(chat.send("Hello"))
        advanceUntilIdle()
        chat.setMode(Mode("claude", "anthropic/opus-5", "high", null, "auto"))
        advanceUntilIdle()
        val sent = recorded.filterIsInstance<AnalyticsEvent.MessageSent>().single()
        assertEquals("before it reaches the computer, with the mode it was sent with", "openai/gpt-5.6-sol", sent.model)
        assertEquals(Effort.Medium, sent.effort)
        assertEquals(MessageSource.Chat, sent.source)
        assertFalse(sent.isSteering)

        gate.complete(Unit)
        advanceUntilIdle()
        val row = chat.state.value.rows.single() as ConversationRow.User
        assertTrue(row.delivery is Delivery.Failed)
        assertEquals(listOf(AnalyticsEvent.ErrorShown(ErrorArea.MessageSend, ErrorCode.ServerError)), recorded.filterIsInstance<AnalyticsEvent.ErrorShown>())
        chat.retrySend(row.messageId)
        advanceUntilIdle()
        assertEquals(4, agent.paths("POST").count { it.endsWith("/send") })
        assertEquals("not again on a retry", 1, recorded.count { it is AnalyticsEvent.MessageSent })
    }

    @Test fun `a refused new work is counted as the create that failed, not as the send's error too`() = runTest {
        val agent = FakeAgent()
        agent.refuseCreate = 409
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"), WorkChoice(WorkKind.Bot, "Taken"))
        advanceUntilIdle()
        assertTrue(chat.send("Hello"))
        advanceUntilIdle()
        assertEquals(1, recorded.count { it is AnalyticsEvent.BotCreated && it.errorCode != null })
        assertEquals(MessageSource.NewSession, recorded.filterIsInstance<AnalyticsEvent.MessageSent>().single().source)
        assertEquals(emptyList<AnalyticsEvent>(), recorded.filter { it is AnalyticsEvent.ErrorShown || it is AnalyticsEvent.ConversationCreated })

        agent.refuseCreate = null
        chat.retrySend((chat.state.value.rows.single() as ConversationRow.User).messageId)
        advanceUntilIdle()
        assertTrue(chat.state.value.created)
        assertEquals(listOf(AnalyticsEvent.BotCreated(null)), recorded.filter { it is AnalyticsEvent.BotCreated && it.errorCode == null })
        assertEquals(1, recorded.count { it is AnalyticsEvent.ConversationCreated })
        assertEquals(1, recorded.count { it is AnalyticsEvent.MessageSent })
        assertTrue(recorded.none { it is AnalyticsEvent.ErrorShown })
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
        chat.setDraft("Go")
        chat.send("Go")
        advanceUntilIdle()
        // Drawn and the composer cleared while the task is still being made.
        assertFalse(chat.state.value.created)
        assertEquals("", chat.state.value.draft)
        assertEquals(listOf("Go"), chat.state.value.rows.map { (it as ConversationRow.User).text })
        assertEquals(true, chat.state.value.newWork?.locked)
        chat.setChoice(WorkChoice(WorkKind.Bot, "Late"))
        advanceUntilIdle()
        assertEquals(WorkChoice(), chat.state.value.newWork?.choice)
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue(chat.state.value.created)
        assertEquals(0, agent.requests.count { it.second == "/v0/bots" })
    }

    /** A voice call's send into new work is its first message, as the composer's is: it makes the bot chosen, and the draft stays. */
    @Test fun `a call's send makes new work and leaves the composer's draft`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent, newTask = NewTask("t1", "w1", "a9", "m1"), choice = WorkChoice(WorkKind.Bot, "Researcher"))
        advanceUntilIdle()
        chat.setDraft("half typed")
        assertTrue(chat.sendAs("voice-1", "Find papers on caching"))
        advanceUntilIdle()
        assertTrue(chat.state.value.created)
        assertEquals(1, agent.requests.count { it.second == "/v0/bots" })
        assertEquals(0, agent.requests.count { it.second == "/v0/tasks" })
        assertEquals(listOf("Find papers on caching"), chat.state.value.rows.filterIsInstance<ConversationRow.User>().map { it.text })
        assertEquals("half typed", chat.state.value.draft)
        assertFalse("the same id again is the same send", chat.sendAs("voice-1", "Find papers on caching"))
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

    @Test fun `the computer's config changed reads the models again`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        assertEquals(3, chat.state.value.catalog?.models?.size)
        agent.config = FakeAgent.CONFIG.replace(""""grok":{"type":"grok","enabled":false""", """"grok":{"type":"grok","enabled":true""")
        signals.emit(event("config.updated", "{}"))
        advanceUntilIdle()
        assertEquals("xai/grok-4.5", chat.state.value.catalog?.models?.last()?.modelId)
        assertEquals(4, chat.state.value.catalog?.models?.size)
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

    @Test fun `a send waits for photos still being read, drawn from their thumbnails, and goes with them in order`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        val reads = "ABCD".associateWith { CompletableDeferred<Unit>() }
        var reading = 0
        var most = 0
        fun pending(fill: Char) = com.slopus.happy.attachments.PendingPicture(byteArrayOf(fill.code.toByte())) {
            reading++
            most = maxOf(most, reading)
            reads.getValue(fill).await()
            reading--
            preview("$fill.jpg", "image/jpeg", 10)
        }
        val ready = listOf(preview("R.jpg", "image/jpeg", 10))
        assertTrue(chat.send("Look", ready, "ABCD".map(::pending)) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        chat.send("After")
        advanceUntilIdle()
        // Drawn at once: the picture already read, then each thumbnail, under its ring.
        val drawn = chat.state.value.rows.filterIsInstance<ConversationRow.User>().first { it.text == "Look" }
        assertEquals(listOf("R.jpg") + "ABCD".map { java.util.Base64.getEncoder().encodeToString(byteArrayOf(it.code.toByte())) }, drawn.pictures.map { it.data })
        assertEquals(Delivery.Sending, drawn.delivery)
        assertTrue("nothing goes before its photos are read, nor after it", agent.requests.none { it.second.endsWith("/send") })

        // The second taken out meanwhile is left out; the last read first changes no order.
        chat.removePicture(drawn.messageId, 2)
        advanceUntilIdle()
        assertEquals("at most three read at once", 3, reading)
        reads.getValue('C').complete(Unit)
        reads.getValue('B').complete(Unit)
        reads.getValue('D').complete(Unit)
        advanceUntilIdle()
        assertTrue(agent.requests.none { it.second.endsWith("/send") })
        reads.getValue('A').complete(Unit)
        advanceUntilIdle()
        val sends = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!! }
        assertEquals(listOf("Look", "After"), sends.map { it["text"]!!.toString().trim('"') })
        val images = sends[0]["content"]!!.jsonArray.map { it.jsonObject }.filter { it["type"]?.jsonPrimitive?.content == "image" }.map { it["data"]!!.jsonPrimitive.content }
        assertEquals(listOf("R.jpg", "A.jpg", "C.jpg", "D.jpg"), images)
        assertEquals(3, most)
        assertEquals(null, chat.state.value.alert)
    }

    @Test fun `a photo that can't be read is left out of its message and said`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        val gone = com.slopus.happy.attachments.PendingPicture(byteArrayOf(1)) { throw java.io.IOException("gone") }
        assertTrue(chat.send("Look", emptyList(), listOf(gone)) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        advanceUntilIdle()
        val sends = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!! }
        assertEquals(listOf("Look"), sends.map { it["text"]!!.toString().trim('"') })
        assertEquals(Problem.PicturesUnreadable, chat.state.value.alert)
        assertTrue(chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().pictures.isEmpty())

        // Pictures alone, none read: the message is taken back.
        assertTrue(chat.send("", emptyList(), listOf(gone)))
        advanceUntilIdle()
        assertEquals(1, chat.state.value.rows.filterIsInstance<ConversationRow.User>().size)
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

    @Test fun `on Happy Cloud files go as the agent's attachments beside the words`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent, cloudFiles = true)
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val doc = java.io.File(dir, "notes.pdf").apply { writeBytes(byteArrayOf(4, 5)) }
        assertTrue(chat.send("Look", listOf(preview(doc.toURI().toString(), "application/pdf", 2, name = "notes.pdf"))) { emptyList() })
        advanceUntilIdle()
        // No folder write: the bytes go to the agent, as their type.
        assertTrue(agent.written.isEmpty())
        val (name, type, bytes) = agent.attachments!!.single()
        assertEquals("notes.pdf" to "application/pdf", name to type)
        assertTrue(bytes.contentEquals(byteArrayOf(4, 5)))
        val send = agent.requests.single { it.second.endsWith("/send") }.third!!
        assertEquals("Look", send["text"]!!.toString().trim('"'))
        val file = (send["content"] as kotlinx.serialization.json.JsonArray).single() as JsonObject
        assertEquals(setOf("type", "attachment", "name"), file.keys)
        assertEquals("\"file\"", file["type"].toString())
        assertEquals("\"notes.pdf\"", file["name"].toString())
        // Its bubble lists it by name until the agent's copy comes.
        assertEquals("Look\n\nAttached file:\n- notes.pdf", chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().text)
    }

    @Test fun `on Happy Cloud a file past 25 MB or a server without attachments says so and nothing goes`() = runTest {
        val agent = FakeAgent().apply { attachments = null }
        val chat = conversation(agent, cloudFiles = true)
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val doc = java.io.File(dir, "notes.pdf").apply { writeBytes(byteArrayOf(4, 5)) }
        assertTrue(chat.send("Look", listOf(preview(doc.toURI().toString(), "application/pdf", 2, name = "notes.pdf"))) { emptyList() })
        advanceUntilIdle()
        assertTrue(agent.requests.none { it.second.endsWith("/send") })
        assertEquals(Delivery.Failed(Problem.FilesUnavailable), chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().delivery)
        assertEquals(Problem.FilesUnavailable, chat.state.value.alert)
        agent.attachments = ArrayList()
        val big = java.io.File(dir, "film.mov").apply { writeBytes(byteArrayOf(1)) }
        assertTrue(chat.send("", listOf(preview(big.toURI().toString(), "video/quicktime", 26L * 1024 * 1024, name = "film.mov"))) { emptyList() })
        advanceUntilIdle()
        assertTrue(agent.attachments!!.isEmpty())
        assertEquals(Delivery.Failed(Problem.FileTooLarge("film.mov")), chat.state.value.rows.filterIsInstance<ConversationRow.User>().single { it.text.contains("film.mov") }.delivery)
        assertEquals(Problem.FileTooLarge("film.mov"), chat.state.value.alert)
        // Pictures alone still go inline.
        assertTrue(chat.send("Just a picture", listOf(preview("a.jpg", "image/jpeg", 10))) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        advanceUntilIdle()
        assertEquals(1, agent.requests.count { it.second.endsWith("/send") })
    }

    @Test fun `a sent message's attachments read as media under its words`() {
        val message = Message.parse(Json.parseToJsonElement("""{"id":"m1","role":"user","status":"completed","createdAt":1,"content":[{"type":"text","text":"Look"},{"type":"file","attachment":"abc","name":"notes.pdf","mimeType":"application/pdf","size":2},{"type":"file","attachment":"def","name":"IMG.jpg","mimeType":"image/jpeg","size":2000000,"kind":"image","width":4032,"height":3024,"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"},{"type":"file","attachment":"fed","name":"a.bin","mimeType":"application/octet-stream","size":1,"kind":"hologram"}]}"""))!!
        assertEquals(Block.File("abc", "notes.pdf", "application/pdf", 2), message.content[1])
        assertEquals(Block.File("def", "IMG.jpg", "image/jpeg", 2000000, "image", 4032.0, 3024.0, "1QcSHQRnh493V4dIh4eXh1h4kJUI"), message.content[2])
        val row = ConversationRowBuilder().rows(message, "a1", null, false).single() as ConversationRow.User
        assertEquals("Look", row.text)
        assertEquals(listOf("abc", "def", "fed"), row.files.map { it.attachment })
        assertEquals(listOf("m1/1", "m1/2", "m1/3"), row.files.map { it.key })
        // Happy Cloud's older files have no kind: a file. An unknown kind is a file too.
        assertEquals(listOf("file", "image", "file"), row.files.map { it.item.kind })
        assertEquals(MediaItem("image", "IMG.jpg", "image/jpeg", 4032.0, 3024.0, null, "1QcSHQRnh493V4dIh4eXh1h4kJUI", 2000000.0), row.files[1].item)
        assertEquals("/v0/agents/a1/attachments/def", ConversationApi.mediaPath("a1", row.files[1]))
        // The viewer pages through its picture, not its files.
        assertEquals(listOf(row.files[1]), ConversationViewing.entries(listOf(row), "Picture", "Video").map { it.presented })
        assertEquals(message, Message.parse(KeptConversation.messageJson(message)))
    }

    @Test fun `to a computer that takes attachments pictures and files go as file blocks, the pictures kept here`() = runTest {
        val agent = FakeAgent().apply { daemon = FakeAttachments() }
        val kept = HashMap<String, java.io.File>()
        val route = AttachmentRoute()
        val chat = conversation(agent, route = route, kept = kept)
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val photo = java.io.File(dir, "IMG_0042.jpg").apply { writeBytes(ByteArray(3000) { it.toByte() }) }
        val doc = java.io.File(dir, "notes.pdf").apply { writeBytes(byteArrayOf(4, 5)) }
        val attachments = listOf(
            preview(photo.toURI().toString(), "image/jpeg", 3000, name = "IMG_0042.jpg"),
            preview(doc.toURI().toString(), "application/pdf", 2, name = "notes.pdf"),
        )
        assertTrue(chat.send("", attachments) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        advanceUntilIdle()
        val photoId = FakeAttachments.hex(photo.readBytes())
        val docId = FakeAttachments.hex(doc.readBytes())
        assertEquals(setOf(photoId, docId), agent.daemon!!.stored.keys)
        assertTrue("no workspace writes", agent.written.isEmpty())
        val send = agent.requests.single { it.second.endsWith("/send") }.third!!
        assertEquals(
            """[{"type":"file","attachment":"$photoId","name":"IMG_0042.jpg"},{"type":"file","attachment":"$docId","name":"notes.pdf"}]""",
            send["content"].toString(),
        )
        assertEquals("\"Attached files.\"", send["text"].toString())
        // The sender's own bytes are where its tiles read them.
        assertEquals(mapOf(photoId to photo, docId to doc), kept)
        val id = send["id"]!!.jsonPrimitive.content
        assertEquals(UploadPhase.Done, chat.uploads.phase(UploadBoard.pictureKey(id, 0)))
        assertFalse(route.missing)
    }

    @Test fun `pictures alone go as attachments captioned as images`() = runTest {
        val agent = FakeAgent().apply { daemon = FakeAttachments() }
        val chat = conversation(agent, route = AttachmentRoute())
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val photo = java.io.File(dir, "a.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        assertTrue(chat.send("", listOf(preview(photo.toURI().toString(), "image/jpeg", 3))) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        advanceUntilIdle()
        val send = agent.requests.single { it.second.endsWith("/send") }.third!!
        assertEquals("\"Attached image.\"", send["text"].toString())
        assertTrue(sentImages(agent).single().isEmpty())
    }

    @Test fun `a computer without attachments is found out once and gets pictures inline and files in the workspace`() = runTest {
        val agent = FakeAgent().apply { daemon = FakeAttachments().apply { missing = true } }
        val route = AttachmentRoute()
        val chat = conversation(agent, route = route)
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val photo = java.io.File(dir, "a.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val doc = java.io.File(dir, "notes.pdf").apply { writeBytes(byteArrayOf(4, 5)) }
        val attachments = listOf(preview(photo.toURI().toString(), "image/jpeg", 3), preview(doc.toURI().toString(), "application/pdf", 2, name = "notes.pdf"))
        assertTrue(chat.send("Look", attachments) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        advanceUntilIdle()
        assertTrue(route.missing)
        assertEquals(1, agent.daemon!!.requests.size)
        val send = agent.requests.single { it.second.endsWith("/send") }.third!!
        val id = send["id"]!!.jsonPrimitive.content
        assertEquals("""[{"type":"image","mimeType":"image/jpeg","data":"a.jpg"}]""", send["content"].toString())
        assertEquals("Look\n\nAttached file:\n- ./.happy-uploads/$id/1-notes.pdf", send["text"]!!.jsonPrimitive.content)
        assertEquals(listOf("w1:.happy-uploads/$id/1-notes.pdf"), agent.written.keys.toList())
        // Remembered: the next send doesn't ask again.
        assertTrue(chat.send("Again", listOf(preview(photo.toURI().toString(), "image/jpeg", 3))) { list -> list.map { Block.Image("image/jpeg", it.name) } })
        advanceUntilIdle()
        assertEquals(1, agent.daemon!!.requests.size)
        assertEquals(2, sentImages(agent).count { it.isNotEmpty() })
    }

    @Test fun `bytes that don't match their name fail the send, and Retry sends it again`() = runTest {
        val daemon = FakeAttachments().apply { corrupt = true }
        val agent = FakeAgent().apply { this.daemon = daemon }
        val chat = conversation(agent, route = AttachmentRoute())
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val doc = java.io.File(dir, "notes.pdf").apply { writeBytes(byteArrayOf(4, 5)) }
        val other = java.io.File(dir, "plan.pdf").apply { writeBytes(byteArrayOf(6)) }
        val attachments = listOf(preview(other.toURI().toString(), "application/pdf", 1, name = "plan.pdf"), preview(doc.toURI().toString(), "application/pdf", 2, name = "notes.pdf"))
        assertTrue(chat.send("Look", attachments) { emptyList() })
        advanceUntilIdle()
        val row = chat.state.value.rows.filterIsInstance<ConversationRow.User>().single()
        assertTrue(row.delivery is Delivery.Failed)
        assertTrue(agent.requests.none { it.second.endsWith("/send") })
        daemon.corrupt = false
        chat.retrySend(row.messageId)
        advanceUntilIdle()
        assertEquals(1, agent.requests.count { it.second.endsWith("/send") })
        assertEquals(Delivery.Pending, chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().delivery)
    }

    @Test fun `retrying a Happy Cloud send keeps the uploaded attachment and message id`() = runTest {
        val agent = FakeAgent().apply { sendStatus = 400 }
        val chat = conversation(agent, cloudFiles = true)
        advanceUntilIdle()
        val dir = kotlin.io.path.createTempDirectory("uploads").toFile()
        val doc = java.io.File(dir, "notes.pdf").apply { writeBytes(byteArrayOf(4, 5)) }
        assertTrue(chat.send("", listOf(preview(doc.toURI().toString(), "application/pdf", 2, name = "notes & plans.pdf"))) { emptyList() })
        advanceUntilIdle()
        val row = chat.state.value.rows.filterIsInstance<ConversationRow.User>().single()
        assertTrue(row.delivery is Delivery.Failed)
        assertEquals("notes & plans.pdf", agent.attachments!!.single().first)
        agent.sendStatus = 202
        chat.retrySend(row.messageId)
        advanceUntilIdle()
        assertEquals(1, agent.attachments!!.size)
        val sends = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!! }
        assertEquals(2, sends.size)
        assertEquals(sends.first(), sends.last())
        assertEquals("\"Attached file.\"", sends.last()["text"].toString())
        assertEquals(Delivery.Pending, chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().delivery)
    }

    private fun TestScope.held() = HeldConversations(CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob().also { jobs += it }))

    /** desktop 01659140: a send in hand when the screen goes stays with its conversation, which the next screen takes back. */
    @Test fun `a conversation left mid-send is kept for its next screen and closed once its sends are taken`() = runTest {
        val agent = FakeAgent()
        val held = held()
        val screen = held.hold("a1") { conversation(agent) }
        val chat = screen.conversation
        advanceUntilIdle()
        val gate = CompletableDeferred<Unit>()
        agent.gate = gate
        chat.send("Ship it")
        runCurrent()
        assertTrue(chat.state.value.unsettledSends)
        screen.release()
        assertNull("nobody holds it", held.peek("a1"))
        val next = held.hold("a1") { error("the next screen for the agent takes the same conversation") }
        assertTrue(next.conversation === chat)
        next.release()
        agent.gate = null
        gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(chat.state.value.unsettledSends)
        assertEquals("settled, it is closed", 0, signals.subscriptionCount.value)
        var made = 0
        held.hold("a1") { made++; conversation(agent) }.release()
        assertEquals("and no longer kept", 1, made)
        assertEquals("sent once", 1, agent.requests.count { it.second.endsWith("/send") })
    }

    /** A failed send is in hand too: the reopened chat still shows it failed, and its Retry goes under the same id. */
    @Test fun `a conversation left with a failed send comes back with it failed and retries it once`() = runTest {
        val agent = FakeAgent()
        agent.sendStatus = 400
        val held = held()
        val first = held.hold("a1") { conversation(agent) }
        val chat = first.conversation
        advanceUntilIdle()
        chat.send("Hello")
        advanceUntilIdle()
        assertTrue(chat.state.value.holdsSends)
        first.release()
        advanceUntilIdle()
        val again = held.hold("a1") { error("kept while failed") }
        val back = again.conversation
        assertTrue(back === chat)
        val row = back.state.value.rows.single() as ConversationRow.User
        assertEquals(Delivery.Failed(Problem.Said("Unknown model.")), row.delivery)
        again.release()
        agent.sendStatus = 202
        back.retrySend(row.messageId)
        advanceUntilIdle()
        assertFalse(back.state.value.holdsSends)
        assertNull(held.peek("a1"))
        val ids = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!!["id"] }
        assertEquals(2, ids.size)
        assertEquals("the retry is the same send", ids[0], ids[1])
    }

    @Test fun `a conversation left with nothing in hand is closed at once`() = runTest {
        val held = held()
        val hold = held.hold("a1") { conversation(FakeAgent()) }
        advanceUntilIdle()
        hold.release()
        advanceUntilIdle()
        assertEquals(0, signals.subscriptionCount.value)
        assertNull(held.peek("a1"))
    }

    /** The screen and a call hold the agent's one conversation: made once, by whichever came first, with what it was made with. */
    @Test fun `two holders share one conversation made once, laid out as the screen's`() = runTest {
        val agent = FakeAgent().apply { page = """{"runs":[{"id":"r1","status":"completed","messages":[
            {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Hi"}],"metadata":{}},
            {"id":"m2","role":"agent","createdAt":2,"content":[{"type":"text","text":"Done"}],"metadata":{}}
        ]}],"hasMore":false}""" }
        val typeset = ArrayList<List<ConversationRow>>()
        val typesetter = object : RowTypesetter {
            override fun prepare(rows: List<ConversationRow>) { typeset += rows }
            override fun live(key: String, content: LiveText.Content, markdown: Boolean) {}
        }
        val held = held()
        var made = 0
        // The call first, then the screen.
        val call = held.hold("a1") { made++; conversation(agent, typesetter = typesetter) }
        val screen = held.hold("a1") { made++; conversation(agent) }
        advanceUntilIdle()
        assertEquals(1, made)
        assertTrue(call.conversation === screen.conversation)
        assertTrue(held.peek("a1") === screen.conversation)
        assertEquals(1, signals.subscriptionCount.value)
        assertEquals(1, agent.paths("GET").count { it.endsWith("/bootstrap") })
        // The rows the screen draws were laid out ahead.
        assertTrue(screen.conversation.state.value.rows.isNotEmpty())
        assertTrue(typeset.flatten().any { it.key == screen.conversation.state.value.rows.first().key })
        call.release()
        screen.release()
    }

    /** It reads while any holder wants it: a covered screen with a call still hears; the call gone, it stops until revealed. */
    @Test fun `a covered screen leaves the call reading and the call gone leaves it covered`() = runTest {
        val agent = FakeAgent()
        val held = held()
        val screen = held.hold("a1") { conversation(agent) }
        advanceUntilIdle()
        val call = held.hold("a1") { error("shared") }
        screen.observe(false)
        advanceUntilIdle()
        assertEquals("the call still hears", 1, signals.subscriptionCount.value)
        call.release()
        advanceUntilIdle()
        assertEquals("covered, and nobody else wants it", 0, signals.subscriptionCount.value)
        screen.observe(true)
        advanceUntilIdle()
        assertEquals(1, signals.subscriptionCount.value)
        // A release twice, or an observe after it, changes nothing.
        call.release()
        call.observe(true)
        screen.observe(false)
        advanceUntilIdle()
        assertEquals(0, signals.subscriptionCount.value)
        screen.release()
    }

    /** A call's watch reads, never marks read: only a screen that shows it does. */
    @Test fun `a call watching a chat nobody shows never marks it read`() = runTest {
        val agent = FakeAgent()
        val held = held()
        val call = held.hold("a1") { conversation(agent) }
        advanceUntilIdle()
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"text","text":"Done"}],"metadata":{}}}"""))
        signals.emit(event("run.finished", """{"agentId":"a1","run":{"id":"r1","status":"completed","startedAt":1,"finishedAt":2}}"""))
        advanceUntilIdle()
        assertTrue(call.conversation.state.value.rows.isNotEmpty())
        assertTrue(agent.requests.none { it.second.endsWith("/read") })
        // The screen opened over it, covered, then shown: read once shown.
        val screen = held.hold("a1") { error("shared") }
        screen.observe(false)
        advanceUntilIdle()
        assertTrue(agent.requests.none { it.second.endsWith("/read") })
        screen.observe(true)
        screen.show(true)
        advanceUntilIdle()
        assertEquals(1, agent.requests.count { it.second.endsWith("/read") })
        screen.show(false)
        screen.release()
        signals.emit(event("run.finished", """{"agentId":"a1","run":{"id":"r2","status":"completed","startedAt":3,"finishedAt":4}}"""))
        advanceUntilIdle()
        assertEquals("the screen gone, the call's watch marks nothing", 1, agent.requests.count { it.second.endsWith("/read") })
        call.release()
    }

    /** Two screens of one agent: each says for itself whether it shows it, so one going leaves the other's say standing. */
    @Test fun `a screen going leaves another screen of the same agent showing it`() = runTest {
        val agent = FakeAgent()
        val held = held()
        val call = held.hold("a1") { conversation(agent) }
        val first = held.hold("a1") { error("shared") }
        val second = held.hold("a1") { error("shared") }
        advanceUntilIdle()
        fun reads() = agent.requests.count { it.second.endsWith("/read") }
        var n = 0
        suspend fun arrive() {
            signals.emit(event("run.finished", """{"agentId":"a1","run":{"id":"r${n++}","status":"completed","startedAt":1,"finishedAt":2}}"""))
            advanceUntilIdle()
        }
        first.show(true)
        second.show(true)
        advanceUntilIdle()
        // The first covered, then gone: the second still shows it, so what arrives is read.
        first.show(false)
        advanceUntilIdle()
        var before = reads()
        arrive()
        assertTrue("still shown by the second", reads() > before)
        first.release()
        before = reads()
        arrive()
        assertTrue("its going takes only its own say", reads() > before)
        // Both gone, the call still holding it: shown by nobody, read by nobody.
        second.release()
        advanceUntilIdle()
        before = reads()
        arrive()
        assertEquals(before, reads())
        // A shown hold's release takes its say with it.
        val third = held.hold("a1") { error("shared") }
        third.show(true)
        third.release()
        advanceUntilIdle()
        before = reads()
        arrive()
        assertEquals(before, reads())
        call.release()
    }

    /** Home's preview takes its hold as it composes: forgotten or abandoned, the hold goes, once. */
    @Test fun `a preview's hold goes however its composition ends`() = runTest {
        val held = held()
        for (end in listOf<(com.slopus.happy.ui.connection.PreviewHold) -> Unit>({ it.onForgotten() }, { it.onAbandoned() })) {
            var made = 0
            val preview = com.slopus.happy.ui.connection.PreviewHold(held.hold("a1") { made++; conversation(FakeAgent()) })
            advanceUntilIdle()
            assertEquals(1, signals.subscriptionCount.value)
            end(preview)
            preview.onForgotten()
            advanceUntilIdle()
            assertEquals(1, made)
            assertNull(held.peek("a1"))
            assertEquals(0, signals.subscriptionCount.value)
        }
    }

    /** A call's send goes through the screen's conversation: shown there at once, sent once, failed once; the call letting go leaves the screen as it was. */
    @Test fun `a call's send shows on the open screen once and its release leaves the screen open`() = runTest {
        val agent = FakeAgent()
        val held = held()
        val screen = held.hold("a1") { conversation(agent) }
        advanceUntilIdle()
        val call = held.hold("a1") { error("shared") }
        assertTrue(call.conversation.sendAs("voice-1", "run the checks"))
        assertFalse("the same id again is the same send", call.conversation.sendAs("voice-1", "run the checks"))
        advanceUntilIdle()
        val row = screen.conversation.state.value.rows.filterIsInstance<ConversationRow.User>().single()
        assertEquals("run the checks", row.text)
        assertEquals(1, agent.requests.count { it.second.endsWith("/send") })
        // Refused: the one row shows it failed, on the screen as on the call's side.
        agent.sendStatus = 400
        assertTrue(call.conversation.sendAs("voice-2", "and deploy"))
        advanceUntilIdle()
        val failed = screen.conversation.state.value.rows.filterIsInstance<ConversationRow.User>().filter { it.delivery is Delivery.Failed }
        assertEquals(listOf("and deploy"), failed.map { it.text })
        assertTrue(call.conversation.has("voice-2"))
        call.release()
        advanceUntilIdle()
        assertEquals("the screen still reads", 1, signals.subscriptionCount.value)
        assertTrue(held.peek("a1") === screen.conversation)
        screen.release()
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

    /** desktop 3885593e: a 50 MB file's JSON made once from the disk; a whole string of it ran a phone's heap out. */
    @Test fun `a file's upload body is its base64 made from the disk a piece at a time`() {
        val dir = kotlin.io.path.createTempDirectory("body").toFile()
        val random = java.util.Random(7)
        // Empty, short, a chunk exactly, and past several chunks with a remainder.
        for (size in listOf(0, 2, 3 * 64 * 1024, 3 * 64 * 1024 * 3 + 5)) {
            val bytes = ByteArray(size).also(random::nextBytes)
            val file = java.io.File(dir, "f$size").apply { writeBytes(bytes) }
            val (body, hash) = WorkspaceUploads.body(".happy-uploads/m/0-a \"b\".bin", file)
            val o = Json.parseToJsonElement(body.decodeToString()).jsonObject
            assertEquals(".happy-uploads/m/0-a \"b\".bin", o["path"]!!.jsonPrimitive.content)
            assertEquals(kotlinx.serialization.json.JsonNull, o["expectedHash"])
            assertTrue(java.util.Base64.getDecoder().decode(o["content"]!!.jsonPrimitive.content).contentEquals(bytes))
            assertEquals(WorkspaceUploads.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)), hash)
        }
    }

    @Test fun `a file uploads from disk as bytes, and a refused write that holds them already counts as written`() = runTest {
        val agent = FakeAgent()
        // The connection's client: a refusal is thrown with its answer, as AgentClient.check does.
        val bytesRequest: AgentBytesRequest = { method, path, body, category ->
            val response = agent.request(method, path, Json.parseToJsonElement(body.decodeToString()), category)
            if (response.status !in 200..299) {
                val answer = Json.parseToJsonElement(response.text).jsonObject
                throw ConversationApiException(response.status, answer["code"]?.jsonPrimitive?.content, null, answer)
            }
            response
        }
        val api = ConversationApi(bytesRequest, agent.request)
        val dir = kotlin.io.path.createTempDirectory("upload").toFile()
        val file = java.io.File(dir, "big.bin").apply { writeBytes(ByteArray(700_000) { (it % 251).toByte() }) }
        api.uploadFile("w1", "big.bin", file, kotlin.coroutines.EmptyCoroutineContext)
        api.uploadFile("w1", "big.bin", file, kotlin.coroutines.EmptyCoroutineContext)
        assertTrue(agent.written.getValue("w1:big.bin").contentEquals(file.readBytes()))
        file.writeBytes(byteArrayOf(1))
        val refused = runCatching { api.uploadFile("w1", "big.bin", file, kotlin.coroutines.EmptyCoroutineContext) }.exceptionOrNull()
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

    private val catalog = """[{"name":"compact","hasArguments":false,"description":"Summarize older messages to free context space.","kind":"compaction"},""" +
        """{"name":"code-review","hasArguments":true,"description":"Review the current changes.","kind":"skill","image":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}}]"""

    private fun FakeAgent.withCommands() = apply {
        bootstrap = """{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Fix it"},"mode":${FakeAgent.MODE},"draft":{"value":null,"updatedAt":null},"pending":[],"slashCommands":$catalog}"""
    }

    @Test fun `the agent's slash commands come with its bootstrap and an update replaces them whole`() = runTest {
        val chat = conversation(FakeAgent().withCommands())
        advanceUntilIdle()
        assertEquals(
            listOf(
                SlashCommand("compact", false, "Summarize older messages to free context space.", "compaction"),
                SlashCommand("code-review", true, "Review the current changes.", "skill", image = true, thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"),
            ),
            chat.state.value.commands,
        )
        signals.emit(event("agent.slash_commands.updated", """{"agentId":"a1","slashCommands":[{"name":"deploy","hasArguments":true,"description":"Ship it."}]}"""))
        advanceUntilIdle()
        assertEquals(listOf(SlashCommand("deploy", true, "Ship it.")), chat.state.value.commands)
        // An update that carries no list leaves what is known.
        signals.emit(event("agent.slash_commands.updated", """{"agentId":"a1"}"""))
        advanceUntilIdle()
        assertEquals(listOf("deploy"), chat.state.value.commands.map { it.name })
    }

    @Test fun `the context measurement comes with the bootstrap and each update replaces it, null clearing it`() = runTest {
        val agent = FakeAgent().apply {
            bootstrap = bootstrap.replace("\"pending\":[]", """"pending":[],"context":{"approximate":false,"contextTokens":84000,"contextWindow":200000,"modelId":"m","providerId":"codex"}""")
        }
        val chat = conversation(agent)
        advanceUntilIdle()
        assertEquals(ContextMeasurement(false, 84000.0, 200000.0, "m", "codex"), chat.state.value.context)
        val rows = chat.state.value.rows
        signals.emit(event("agent.context.updated", """{"agentId":"a1","context":{"approximate":true,"contextTokens":120000,"contextWindow":200000,"modelId":"m","providerId":"codex"}}"""))
        advanceUntilIdle()
        assertEquals(ContextMeasurement(true, 120000.0, 200000.0, "m", "codex"), chat.state.value.context)
        // Only the meter moves: the rows are the same list.
        assertTrue(rows === chat.state.value.rows)
        signals.emit(event("agent.context.updated", """{"agentId":"a1","context":null}"""))
        advanceUntilIdle()
        assertNull(chat.state.value.context)
    }

    @Test fun `a command runs on its module under the composer's mode and is never a message`() = runTest {
        val agent = FakeAgent().withCommands()
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.setDraft("/compact")
        assertTrue(chat.runCommand("compact", "ignored, it takes none"))
        advanceUntilIdle()
        val (method, path, body) = agent.requests.single { "/slash-commands/" in it.second }
        assertEquals("POST", method)
        assertEquals("/v0/agents/a1/slash-commands/compact", path)
        assertEquals(setOf("mode", "mutationId"), body!!.keys)
        assertEquals(Mode.parse(Json.parseToJsonElement(FakeAgent.MODE)), Mode.parse(body["mode"]))
        assertTrue(agent.paths("POST").none { it.endsWith("/send") })
        assertEquals("", chat.state.value.draft)
        // The answer's catalog replaces the one known.
        assertEquals(listOf("compact"), chat.state.value.commands.map { it.name })
        assertNull(chat.state.value.alert)
    }

    @Test fun `a command's arguments go as one string when it takes them`() = runTest {
        val agent = FakeAgent().apply {
            bootstrap = """{"agent":{"id":"a1","workspaceId":"w1","status":"idle"},"mode":${FakeAgent.MODE},"pending":[],"slashCommands":[{"name":"deploy now","hasArguments":true,"description":"Ship."}]}"""
        }
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.runCommand("deploy now", "  to staging, quietly ")
        advanceUntilIdle()
        val (_, path, body) = agent.requests.single { "/slash-commands/" in it.second }
        assertEquals("/v0/agents/a1/slash-commands/deploy%20now", path)
        assertEquals("to staging, quietly", body!!["arguments"]!!.toString().trim('"'))
    }

    @Test fun `a command gone or busy says so in the phone's words`() = runTest {
        val agent = FakeAgent().withCommands()
        val chat = conversation(agent)
        advanceUntilIdle()
        agent.commandStatus = 404
        chat.runCommand("compact", null)
        advanceUntilIdle()
        assertEquals(Problem.CommandGone("compact"), chat.state.value.alert)
        chat.dismissAlert()
        agent.commandStatus = 409
        chat.runCommand("compact", null)
        advanceUntilIdle()
        assertEquals(Problem.CommandBusy("compact"), chat.state.value.alert)
        chat.dismissAlert()
        agent.commandStatus = 400
        chat.runCommand("compact", null)
        advanceUntilIdle()
        assertEquals(Problem.Said("The daemon's own words."), chat.state.value.alert)
        chat.dismissAlert()
        // One the phone doesn't know isn't asked for at all.
        val asked = agent.requests.size
        chat.runCommand("nonsense", null)
        advanceUntilIdle()
        assertEquals(Problem.CommandGone("nonsense"), chat.state.value.alert)
        assertEquals(asked, agent.requests.size)
    }

    @Test fun `a skill goes as the person's message asking for read_skill first`() = runTest {
        val agent = FakeAgent().withCommands()
        val chat = conversation(agent)
        advanceUntilIdle()
        chat.runCommand("code-review", "focus on auth")
        advanceUntilIdle()
        assertTrue(agent.requests.none { "/slash-commands/" in it.second })
        val body = agent.requests.single { it.second.endsWith("/send") }.third!!
        assertEquals("/code-review focus on auth", body["text"]!!.toString().trim('"'))
        assertEquals(
            Json.parseToJsonElement("""[{"type":"tool_call_request","name":"read_skill","arguments":{"name":"code-review"}}]"""),
            body["content"],
        )
        chat.runCommand("code-review", "  ")
        advanceUntilIdle()
        assertEquals("/code-review", agent.requests.last { it.second.endsWith("/send") }.third!!["text"]!!.toString().trim('"'))
    }

    @Test fun `the commands are kept with the history and shown offline`() = runTest {
        val store = object : ConversationKeeper {
            var kept: JsonObject? = null
            override fun read() = kept
            override fun write(value: JsonObject) { kept = value }
        }
        val history = FakeAgent().withCommands().apply {
            page = """{"runs":[{"id":"r1","status":"completed","messages":[{"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"hi"}]}]}],"hasMore":false}"""
        }
        val first = conversation(history, keeper = store)
        advanceUntilIdle()
        first.close()
        advanceUntilIdle()
        assertEquals(2, KeptConversation.parse(store.kept)!!.slashCommands!!.size)
        val offline = FakeAgent().apply { beforeBootstrap = { throw AgentConnectionException(AgentConnectionException.Reason.Unavailable) } }
        val second = conversation(offline, keeper = store)
        advanceUntilIdle()
        assertEquals(listOf("compact", "code-review"), second.state.value.commands.map { it.name })
    }

    private fun skillPage(skills: String, next: String? = null) =
        """{"skills":[$skills],"nextPageCursor":${next?.let { "\"$it\"" } ?: "null"},"cursor":"c0"}"""

    private fun skill(name: String, enabled: Boolean = true, status: String = "ready") =
        """{"id":"s-$name","path":"$name","name":"$name","description":"$name it.","enabled":$enabled,"status":"$status","error":null}"""

    /** A computer offering /code-review, a made agent offering it too, and its bootstrap. */
    private fun FakeAgent.withSkill(offered: Boolean = true) = apply {
        skillPages = mapOf(null to skillPage(skill("code-review")))
        val commands = if (offered) ""","slashCommands":[{"name":"code-review","hasArguments":true,"description":"Review.","kind":"skill"}]""" else ""
        bootstrap = """{"agent":{"id":"a9","workspaceId":"w1","status":"idle"},"draft":{"value":null,"updatedAt":null},"pending":[]$commands}"""
    }

    @Test fun `a new chat offers the computer's enabled ready skills, read again when they change`() = runTest {
        val agent = FakeAgent().apply {
            skillPages = mapOf(
                null to skillPage(skill("code-review") + "," + skill("off", enabled = false) + "," + skill("broken", status = "invalid"), next = "p2"),
                // Two folders of one name: the agent offers it once, and so does the list.
                "p2" to skillPage(skill("deploy") + "," + skill("code-review")),
            )
            // The catalog changed under its pages: read again from the start.
            skillConflicts = 1
        }
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"))
        advanceUntilIdle()
        assertEquals(
            listOf(SlashCommand("code-review", true, "code-review it.", "skill"), SlashCommand("deploy", true, "deploy it.", "skill")),
            chat.state.value.commands,
        )
        assertEquals(
            listOf("/v0/skills?limit=100", "/v0/skills?limit=100&pageCursor=p2", "/v0/skills?limit=100", "/v0/skills?limit=100&pageCursor=p2"),
            agent.requests.map { it.second }.filter { it.startsWith("/v0/skills") },
        )
        agent.skillPages = mapOf(null to skillPage(skill("deploy", enabled = false)))
        signals.emit(event("skills.updated", """{"skillIds":null,"paths":[]}"""))
        advanceUntilIdle()
        assertTrue(chat.state.value.commands.isEmpty())
        // An agent's chat offers its own catalog, not these.
        val existing = FakeAgent().apply { skillPages = agent.skillPages }
        conversation(existing)
        advanceUntilIdle()
        assertTrue(existing.requests.none { it.second.startsWith("/v0/skills") })
    }

    @Test fun `a computer without skills offers a new chat none and says nothing`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"))
        advanceUntilIdle()
        assertEquals(1, agent.requests.count { it.second.startsWith("/v0/skills") })
        assertTrue(chat.state.value.commands.isEmpty())
        assertNull(chat.state.value.alert)
        assertNull(chat.state.value.error)
    }

    @Test fun `a new chat's first skill makes the task, then goes into it as a skill's message under the composer's mode`() = runTest {
        val agent = FakeAgent().withSkill()
        agent.sendStatus = 202
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"))
        advanceUntilIdle()
        val picked = Mode("codex", "openai/gpt-5.6-luna", "low", null, "read_only")
        chat.setMode(picked)
        assertTrue(chat.send("/code-review  focus on auth"))
        advanceUntilIdle()
        assertTrue(chat.state.value.created)
        assertEquals(listOf("/v0/tasks", "/v0/agents/a9/send"), agent.paths("POST"))
        val body = agent.requests.single { it.second.endsWith("/send") }.third!!
        // As a chat sends a skill: the person's words, asking for read_skill first.
        assertEquals("/code-review focus on auth", body["text"]!!.jsonPrimitive.content)
        assertEquals(
            Json.parseToJsonElement("""[{"type":"tool_call_request","name":"read_skill","arguments":{"name":"code-review"}}]"""),
            body["content"],
        )
        assertEquals(picked, Mode.parse(body["mode"]))
        val row = chat.state.value.rows.single() as ConversationRow.User
        assertEquals("/code-review focus on auth", row.text)
        assertEquals(row.messageId, body["id"]!!.jsonPrimitive.content)
    }

    @Test fun `a first skill the new agent doesn't offer goes as the words`() = runTest {
        val agent = FakeAgent().withSkill(offered = false)
        agent.sendStatus = 202
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"))
        advanceUntilIdle()
        chat.send("/code-review focus on auth")
        advanceUntilIdle()
        val body = agent.requests.single { it.second.endsWith("/send") }.third!!
        assertEquals("/code-review focus on auth", body["text"]!!.jsonPrimitive.content)
        assertFalse("content" in body)
    }

    @Test fun `a first skill with a picture goes as a message`() = runTest {
        val agent = FakeAgent().withSkill()
        agent.sendStatus = 202
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"))
        advanceUntilIdle()
        chat.send("/code-review this", listOf(Block.Image("image/jpeg", "AAAA")))
        advanceUntilIdle()
        val body = agent.requests.single { it.second.endsWith("/send") }.third!!
        assertEquals("/code-review this", body["text"]!!.jsonPrimitive.content)
        assertTrue(body["content"]!!.jsonArray.none { it.jsonObject["type"]!!.jsonPrimitive.content == "tool_call_request" })
    }

    @Test fun `a first skill refused stays failed and Retry sends the same message again`() = runTest {
        val agent = FakeAgent().withSkill()
        agent.sendStatus = 400
        val chat = conversation(agent, NewTask("t1", "w1", "a9", "m1"))
        advanceUntilIdle()
        chat.send("/code-review")
        advanceUntilIdle()
        val row = chat.state.value.rows.single() as ConversationRow.User
        assertEquals("/code-review", row.text)
        assertEquals(Delivery.Failed(Problem.Said("Unknown model.")), row.delivery)
        agent.sendStatus = 202
        chat.retrySend(row.messageId)
        advanceUntilIdle()
        val sends = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!! }
        assertEquals(2, sends.size)
        assertEquals(sends[0], sends[1])
        assertEquals("read_skill", sends[1]["content"]!!.jsonArray.single().jsonObject["name"]!!.jsonPrimitive.content)
        assertEquals(Delivery.Pending, (chat.state.value.rows.single() as ConversationRow.User).delivery)
    }


    private val endedTurn = """{"runs":[{"id":"r1","status":"completed","startedAt":1000,"endedAt":13000,"reason":"completed","messages":[
        {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Fix it"}],"metadata":{}},
        {"id":"m2","role":"agent","createdAt":2,"content":[
            {"type":"reasoning","text":"Look first."},
            {"type":"tool_call","id":"c1","name":"exec_command","status":"completed","presentation":{"type":"exec_command","command":"ls"}},
            {"type":"tool_call","id":"c2","name":"apply_patch","status":"completed","presentation":{"type":"file_diff","files":[{"path":"src/a.ts","kind":"update","added":3,"deleted":1}]}},
            {"type":"text","text":"Done"}
        ],"metadata":{}}
    ]}],"hasMore":false}"""

    @Test fun `a finished turn folds its work behind its trace and says how it ended`() = runTest {
        val agent = FakeAgent().apply { page = endedTurn }
        val keeper = MemoryKeeper()
        val chat = conversation(agent, keeper = keeper)
        advanceUntilIdle()
        // Folded: the person's words, the file it edited, the control, the answer and how it ended.
        assertEquals(listOf("r1:status", "m2:3", "r1:trace", "m2:2", "m1:user"), chat.state.value.rows.map { it.key })
        val ended = chat.state.value.rows[0] as ConversationRow.TurnEnd
        assertEquals(ConversationRow.TurnEnd("r1:status", "r1", "completed", 12_000, 2, "Done", endedAt = 13_000), ended)
        assertTrue(ended.complete)
        // Its copy is the turn's: the answer has none of its own.
        assertFalse((chat.state.value.rows[1] as ConversationRow.Text).copies)
        assertEquals(ConversationRow.Trace("r1:trace", "r1", false, 2), chat.state.value.rows[2])
        val edit = (chat.state.value.rows[3] as ConversationRow.Tool).tool
        assertEquals("apply_patch", edit.name)
        assertTrue(edit.isResult)

        // Open: every step, the control riding the first.
        chat.toggleTurn("r1")
        advanceUntilIdle()
        assertEquals(listOf("r1:status", "m2:3", "m2:2", "m2:1", "m2:0", "r1:trace", "m1:user"), chat.state.value.rows.map { it.key })
        assertTrue((chat.state.value.rows[5] as ConversationRow.Trace).open)
        // A step right above how it ended keeps it 4 further off; here the answer is.
        assertFalse((chat.state.value.rows[0] as ConversationRow.TurnEnd).afterStep)

        chat.toggleTurn("r1")
        advanceUntilIdle()
        assertEquals("r1:trace", chat.state.value.rows[2].key)

        // When and why it ended are kept with it.
        val kept = KeptConversation.parse(keeper.value)!!.runs.single()
        assertEquals(13_000L, kept.endedAt)
        assertEquals("completed", kept.reason)
    }

    @Test fun `a turn still running is shown whole and ends when its run finishes`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        signals.emit(event("run.started", """{"agentId":"a1","run":{"id":"r1","status":"running","startedAt":1000},"acceptedMessageIds":[]}"""))
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"tool_call","id":"c1","name":"exec_command","status":"completed","presentation":{"type":"exec_command","command":"ls"}},{"type":"text","text":"Hi"}],"metadata":{}}}"""))
        advanceUntilIdle()
        assertEquals(listOf("m:1", "m:0"), chat.state.value.rows.map { it.key })

        // Steered: the run ends by the boundary, which says why, and offers no copy.
        signals.emit(event("run.boundary", """{"agentId":"a1","finishedRun":{"id":"r1","status":"completed","startedAt":1000,"endedAt":4000,"reason":"steering"},"startedRun":{"id":"r2","status":"running","startedAt":4000},"acceptedMessageIds":[]}"""))
        advanceUntilIdle()
        val steered = chat.state.value.rows.first { it is ConversationRow.TurnEnd } as ConversationRow.TurnEnd
        assertEquals("steering", steered.reason)
        assertEquals(3_000L, steered.durationMs)
        assertFalse(steered.complete)

        signals.emit(event("message.created", """{"agentId":"a1","runId":"r2","message":{"id":"n","role":"agent","createdAt":6,"content":[{"type":"text","text":"Again"}],"metadata":{}}}"""))
        signals.emit(event("run.finished", """{"agentId":"a1","run":{"id":"r2","status":"completed","startedAt":4000,"endedAt":9000,"reason":"error"}}"""))
        advanceUntilIdle()
        val failed = chat.state.value.rows[0] as ConversationRow.TurnEnd
        assertEquals(ConversationRow.TurnEnd("r2:status", "r2", "error", 5_000, 0, "Again", endedAt = 9_000), failed)
    }

    @Test fun `another agent's steering joins the run going and its turn stays one`() = runTest {
        // happy-agent 10b6171c4: only a person's steering is a boundary; another agent's comes as
        // `message.created` in the run already going, and no lifecycle event.
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        signals.emit(event("run.started", """{"agentId":"a1","run":{"id":"r1","status":"running","startedAt":1000},"acceptedMessageIds":[]}"""))
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"m","role":"agent","createdAt":5,"content":[{"type":"tool_call","id":"c1","name":"exec_command","status":"completed","presentation":{"type":"exec_command","command":"ls"}}],"metadata":{}}}"""))
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"s","role":"agent","createdAt":6,"content":[{"type":"text","text":"Message from agent x9: also check the tests"}],"metadata":{"senderAgentId":"x9"}}}"""))
        signals.emit(event("message.created", """{"agentId":"a1","runId":"r1","message":{"id":"n","role":"agent","createdAt":7,"content":[{"type":"text","text":"Done, tests too"}],"metadata":{}}}"""))
        signals.emit(event("run.finished", """{"agentId":"a1","run":{"id":"r1","status":"completed","startedAt":1000,"endedAt":9000}}"""))
        advanceUntilIdle()
        val rows = chat.state.value.rows
        val ends = rows.filterIsInstance<ConversationRow.TurnEnd>()
        assertEquals("one turn", 1, ends.size)
        assertEquals("completed", ends.single().reason)
        // Folded, the turn still shows what the other agent said, under its one answer.
        assertEquals(listOf("r1:status", "n:0", "r1:trace", "s:from"), rows.map { it.key })
    }


    private fun picture(fill: Char) = Block.Image("image/png", fill.toString().repeat(4000))

    private fun sentImages(agent: FakeAgent) = agent.requests.filter { it.second.endsWith("/send") }.map { request ->
        request.third!!["content"]?.jsonArray.orEmpty().map { it.jsonObject }.filter { it["type"]?.jsonPrimitive?.content == "image" }.map { it["data"]!!.jsonPrimitive.content.first() }
    }

    @Test fun `a sending picture says how much of it is written and is forgotten once taken`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        val gate = CompletableDeferred<Unit>().also { agent.halfway = it }
        assertTrue(chat.send("Look", listOf(picture('A'), picture('B'))))
        advanceUntilIdle()
        val id = chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().messageId
        // Half the body: the first picture mostly written, the second not begun.
        val first = chat.uploads.phase(UploadBoard.pictureKey(id, 0))
        val second = chat.uploads.phase(UploadBoard.pictureKey(id, 1))
        assertTrue("first: $first", first is UploadPhase.Uploading && first.share > 0.5f || first == UploadPhase.Done)
        assertTrue("second: $second", second == UploadPhase.Uploading(0f) || second is UploadPhase.Uploading && second.share < 0.5f)
        gate.complete(Unit)
        advanceUntilIdle()
        // Taken: all there until the agent's own copy comes back.
        assertEquals(UploadPhase.Done, chat.uploads.phase(UploadBoard.pictureKey(id, 1)))
        assertEquals(Delivery.Pending, chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().delivery)
        signals.emit(event("message.created", """{"agentId":"a1","runId":null,"message":{"id":"$id","role":"user","status":"pending","createdAt":5,"content":[{"type":"text","text":"Look"}],"metadata":{}}}"""))
        advanceUntilIdle()
        assertEquals(null, chat.uploads.phase(UploadBoard.pictureKey(id, 0)))
    }

    @Test fun `taking a picture out on its way sends the rest under the same id, and the last one takes the message back`() = runTest {
        val agent = FakeAgent()
        val chat = conversation(agent)
        advanceUntilIdle()
        agent.halfway = CompletableDeferred()
        assertTrue(chat.send("", listOf(picture('A'), picture('B'))))
        advanceUntilIdle()
        val id = chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().messageId
        chat.removePicture(id, 1)
        advanceUntilIdle()
        assertEquals("written again without it", listOf(listOf('A', 'B'), listOf('A')), sentImages(agent))
        assertEquals(1, chat.state.value.rows.filterIsInstance<ConversationRow.User>().single().pictures.size)
        val ids = agent.requests.filter { it.second.endsWith("/send") }.map { it.third!!["id"]!!.jsonPrimitive.content }.distinct()
        assertEquals("one message", 1, ids.size)

        chat.removePicture(id, 0)
        advanceUntilIdle()
        assertTrue("nothing left: taken back", chat.state.value.rows.filterIsInstance<ConversationRow.User>().isEmpty())
        assertEquals(2, sentImages(agent).size)
    }
}

private fun preview(uri: String, mimeType: String, size: Long, name: String = uri.substringAfterLast('/')) =
    com.slopus.happy.attachments.AttachmentPreview(id = uri, uri = uri, width = 0, height = 0, mimeType = mimeType, size = size, name = name)
