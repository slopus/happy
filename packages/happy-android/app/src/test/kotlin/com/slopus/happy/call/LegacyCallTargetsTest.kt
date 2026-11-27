package com.slopus.happy.call

import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.chat.MessageDelivery
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.UserDisplay
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.Machine
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.rigSessionCreation
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.sync.HappyAgentSpawnTarget
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.add
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.Executors

/** A call over a Happy CLI account: what it lists, reads and sends, and the new work it starts there (iOS `LegacyCallTargetsTests`). */
@OptIn(ExperimentalCoroutinesApi::class)
class LegacyCallTargetsTest {
    private val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()

    @Before fun setUp() = Dispatchers.setMain(main)

    @After fun tearDown() {
        Dispatchers.resetMain()
        main.close()
    }

    // Fixtures

    private fun JsonObjectBuilder.bot(name: String) = putJsonObject("bot") {
        put("id", "bot-$name")
        put("name", name)
        put("username", name.lowercase())
        put("workspaceId", "w")
        put("orderKey", "a")
    }

    private fun JsonObjectBuilder.task(name: String?) = putJsonObject("task") { name?.let { put("name", it) } }

    private fun JsonObjectBuilder.summary(text: String) = putJsonObject("summary") {
        put("text", text)
        put("updatedAt", 1)
    }

    private fun named(text: String, path: String = "/repo") = metadata(path) { summary(text) }

    private fun user(id: String, text: String, at: Long = 0, delivery: MessageDelivery? = null) =
        ChatRow.User(ChatMessage.UserText(id, null, at, text), UserDisplay.Text(text, emptyList()), delivery = delivery)

    private fun agent(id: String, text: String, turn: String? = null) = ChatRow.AgentText(ChatMessage.AgentText(id, 0, text, turn = turn), emptyList())

    private fun tool(id: String, turn: String? = null) =
        ChatRow.Tool(ChatMessage.ToolCallMessage(id, 0, ToolCall(name = "Bash", state = ToolState.Completed, input = null, createdAt = 0), turn = turn))

    /** [rows] oldest first, as the chat shows them; the snapshot holds them newest first. */
    private fun chat(
        rows: List<ChatRow>,
        metadata: SessionMetadata? = metadata(),
        online: Boolean = true,
        thinking: Boolean = false,
        failed: Set<String> = emptySet(),
        id: String = "s",
    ) = ChatState(
        ChatSnapshot(rows.reversed(), loaded = true, failedTurns = failed),
        ChatSessionInfo(session(id, metadata, active = online), null),
        sessionLoaded = true,
        online = online,
        thinking = thinking,
    )

    private val target = CallTarget("s", "Fix the build", CallTarget.Kind.Conversation, CallTarget.Status.Idle)

    private fun rigMachine(id: String, host: String, active: Boolean = true, tasks: Boolean = true, bots: Boolean = true): Machine =
        machine(id, machineMetadata(host) {
            put("machineKind", "rig")
            put("rigOnly", true)
            putJsonObject("capabilities") {
                put("newSession", true)
                put("tasks", tasks)
                put("bots", bots)
            }
            putJsonObject("defaults") {
                put("providerId", "claude")
                put("modelId", "opus")
                put("permissionMode", "auto")
            }
            putJsonArray("models") {
                for ((model, name) in listOf("opus" to "Claude Opus", "sonnet" to "Claude Sonnet")) addJsonObject {
                    put("code", model)
                    put("value", name)
                    put("providerId", "claude")
                    put("id", model)
                    put("name", name)
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                    put("defaultThinkingLevel", "high")
                }
            }
            putJsonArray("operatingModes") { addJsonObject { put("code", "auto"); put("value", "Auto"); put("kind", "safe-yolo") } }
        }, active = active)

    // The directory

    @Test
    fun theDirectoryIsBotsThenTasksThenProjectsInTheOrderTheyWereMade() {
        val list = LegacyCallTargets.directory(
            listOf(
                session("old-bot", rigMetadata { bot("Release") }, createdAt = 1),
                session("new-bot", rigMetadata { bot("Docs") }, createdAt = 5),
                session("task", rigMetadata { task("Fix cache race") }, createdAt = 2),
                session("unnamed-task", rigMetadata { task(null) }, createdAt = 3),
                session("a1", named("First in app", "/app"), createdAt = 10),
                session("a2", named("Second in app", "/app"), createdAt = 20),
                session("lib", named("Library", "/lib"), createdAt = 15),
                session("untitled", metadata("/lib"), createdAt = 12),
                // Left out: a side chat, a Happy CLI session that stopped, one archived, one being archived here.
                session("side", metadata("/app") { put("isSideChat", true) }, createdAt = 30),
                session("stopped", named("Stopped", "/app"), active = false, createdAt = 31),
                session("archived", rigMetadata { put("lifecycleState", "archived") }, active = false, createdAt = 32),
                session("archiving", named("Going", "/app"), createdAt = 33),
                // Listed: Happy Agent's session whose computer is offline.
                session("offline-rig", rigMetadata(path = "/rig") { summary("Offline") }, active = false, createdAt = 4),
            ),
            archiving = setOf("archiving"),
        )
        assertEquals(listOf("new-bot", "old-bot", "unnamed-task", "task"), list.take(4).map { it.agentId })
        assertEquals(listOf(CallTarget.Kind.Bot, CallTarget.Kind.Bot, CallTarget.Kind.Task, CallTarget.Kind.Task), list.take(4).map { it.kind })
        assertEquals(listOf("Docs", "Release", "New chat", "Fix cache race"), list.take(4).map { it.title })
        // Projects by their newest session; within one, newest made first. A reply moves nothing: activity isn't read.
        assertEquals(listOf("a2", "a1", "lib", "untitled", "offline-rig"), list.drop(4).map { it.agentId })
        // Unnamed, as its home row reads.
        assertEquals("New chat", list.single { it.agentId == "untitled" }.title)
        assertEquals(listOf("project"), list.single { it.agentId == "a1" }.parents.map { it.kind })
        assertTrue(list.drop(4).all { it.kind == CallTarget.Kind.Conversation })
    }

    // Reading

    @Test
    fun aHappyCliSessionsRunsAreThePersonsExchangesAndOneCutShortSteers() {
        val state = LegacyCallTargets.state(
            chat(
                listOf(
                    user("u1", "first ask", 1), tool("t1"), agent("a1", "first answer"),
                    user("u2", "second ask", 2),
                    user("u3", "and the tests", 3), agent("a2", "second answer"),
                ),
            ),
            target, fresh = true,
        )
        assertEquals(
            listOf(
                Triple("first ask", "first answer", "completed"),
                Triple("second ask", null, "steering"),
                Triple("and the tests", "second answer", "completed"),
            ),
            state.turns.map { Triple(it.user, it.reply, it.ended) },
        )
        assertNull(state.unanswered)
        // Words only: the tool is nowhere.
        assertEquals(listOf("u1", "a1", "u2", "u3", "a2"), state.messages.map { it.id })
        assertTrue(state.writable)
        assertTrue(state.fresh)
        assertEquals(CallTarget.Status.Idle, state.target.status)
    }

    @Test
    fun whileItThinksTheLastWordsMayStillGrowAndTheAskIsWaiting() {
        val state = LegacyCallTargets.state(chat(listOf(user("u1", "run the checks"), agent("a1", "Running them"))), target, fresh = false)
        assertTrue(state.messages.last().final)
        val thinking = LegacyCallTargets.state(chat(listOf(user("u1", "run the checks"), agent("a1", "Running them")), thinking = true), target, fresh = false)
        assertFalse(thinking.messages.last().final)
        assertTrue(thinking.working)
        assertEquals(CallTarget.Status.Running, thinking.target.status)
        assertEquals("run the checks", thinking.unanswered?.text)
        assertTrue(thinking.turns.isEmpty())
    }

    @Test
    fun happyAgentsTurnsAreItsOwnAndAFailedOneEndsInItsError() {
        val rig = rigMetadata()
        val state = LegacyCallTargets.state(
            chat(
                listOf(
                    user("u1", "ship it", 1), tool("x1", "t1"), agent("a1", "Shipped.", "t1"),
                    user("u2", "and the docs", 2), tool("x2", "t2"), agent("a2", "The run failed: the provider's quota ran out", "t2"),
                ),
                metadata = rig, failed = setOf("t2"),
            ),
            target, fresh = true,
        )
        assertEquals(listOf("t1", "t2"), state.turns.map { it.id })
        assertEquals("Shipped.", state.turns[0].reply)
        assertEquals("completed", state.turns[0].ended)
        assertEquals("error", state.turns[1].ended)
        assertEquals("the provider's quota ran out", state.turns[1].error)
        assertNull(state.turns[1].reply)
        // The failure's words are its reason, not an answer.
        assertFalse(state.messages.any { it.text.startsWith(LegacyCallTargets.RUN_FAILED) })
        assertEquals("t1", state.messages.single { it.id == "a1" }.turn)
    }

    @Test
    fun onlyAnOnlineSessionTakesMessages() {
        assertTrue(LegacyCallTargets.state(chat(listOf(user("u", "hi")), metadata = rigMetadata()), target, true).writable)
        assertFalse(LegacyCallTargets.state(chat(listOf(user("u", "hi")), metadata = rigMetadata(), online = false), target, true).writable)
        val archived = rigMetadata { put("lifecycleState", "archived") }
        assertFalse(LegacyCallTargets.state(chat(listOf(user("u", "hi")), metadata = archived, online = false), target, true).writable)
        assertFalse(LegacyCallTargets.state(chat(listOf(user("u", "hi")), online = false), target, true).writable)
    }

    @Test
    fun theComposersChipsAreTheModelsWithTheirEffortsAndWhatIsLocked() {
        val composer = ComposerModes(
            availableModels = listOf(ModeOption("opus", "Opus", defaultThinkingLevel = "high"), ModeOption("old", "Old", disabled = true)),
            modelMode = ModeOption("opus", "Opus"),
            effortLevel = ModeOption("high", "High"),
            canChangeModel = false,
            canChangeEffort = true,
        )
        val modes = LegacyCallTargets.modes(composer) { listOf(ModeOption("low", "Low"), ModeOption("high", "High"), ModeOption("max", "Max", disabled = true)) }
        assertEquals(listOf(CallModel("opus", "Opus", listOf("low", "high"), "high")), modes.models)
        assertEquals(CallMode("opus", "Opus", "high"), modes.mode)
        assertTrue(modes.modelLocked)
        assertFalse(modes.effortLocked)
    }

    // Where new work starts

    @Test
    fun newWorkStartsOnComposesComputerElseTheOnlyOneThatCan() {
        val home = rigMachine("home", "home.local")
        val work = rigMachine("work", "work.local")
        val noBots = rigMachine("lab", "lab.local", bots = false)
        val offline = rigMachine("away", "away.local", active = false)
        assertEquals("work", (LegacyCallTargets.newWorkPlace(listOf(home, work), "work", bot = false) as LegacyNewWork.Ready).machineId)
        assertEquals("home", (LegacyCallTargets.newWorkPlace(listOf(home, offline), null, bot = false) as LegacyNewWork.Ready).machineId)
        assertEquals("home", (LegacyCallTargets.newWorkPlace(listOf(home, noBots), "lab", bot = true) as LegacyNewWork.Ready).machineId)
        assertEquals(LegacyNewWork.Refused(CallContext.CLI_NEW_WORK_SEVERAL), LegacyCallTargets.newWorkPlace(listOf(home, work), null, bot = false))
        assertEquals(LegacyNewWork.Refused(CallContext.CLI_NEW_WORK_REFUSED), LegacyCallTargets.newWorkPlace(listOf(offline), null, bot = false))
        assertEquals(LegacyNewWork.Refused(CallContext.CLI_NEW_WORK_REFUSED), LegacyCallTargets.newWorkPlace(listOf(noBots), null, bot = true))
    }

    // Sending and starting

    private inner class FakeAccount(sessions: List<CallTarget>) : LegacyCallAccount {
        val listed = MutableStateFlow(sessions)
        val chats = HashMap<String, MutableStateFlow<ChatState?>>()
        val sends = ArrayList<Pair<String, String>>()
        val modeSets = ArrayList<Triple<String, String?, String?>>()
        val spawns = ArrayList<SpawnSessionOptions>()
        var spawned: MutableList<SpawnSessionResult> = mutableListOf()
        var place: LegacyNewWork = LegacyNewWork.Ready("home", requireNotNull(rigMachine("home", "home.local").metadata.rigSessionCreation()))
        var modes = LegacyCallModes()

        fun chatOf(id: String) = chats.getOrPut(id) { MutableStateFlow(null) }

        override fun directory() = listed.value
        override val directoryChanges: Flow<List<CallTarget>> get() = listed
        override fun unlisted(sessionId: String): CallTarget? = null
        override fun chat(sessionId: String): Flow<ChatState> = chats[sessionId]?.filterNotNull() ?: emptyFlow()
        override suspend fun catchUp(sessionId: String) {}
        override suspend fun isCurrent(sessionId: String) = true
        override fun modes(chat: ChatState) = modes
        override suspend fun setModes(sessionId: String, model: String?, effort: String?) { modeSets += Triple(sessionId, model, effort) }
        var sendDelay = 0L
        val waits = ArrayList<Long>()
        /** The directory as home had it when awaitSession was asked, by the call's IDs. */
        var seenWhileWaiting: List<String>? = null
        var targets: LegacyCallTargets? = null
        override suspend fun send(sessionId: String, text: String, waitOnlineMillis: Long, onAccepted: () -> Unit): Boolean {
            if (sendDelay > 0) kotlinx.coroutines.delay(sendDelay)
            waits += waitOnlineMillis
            sends += sessionId to text
            onAccepted()
            return true
        }
        override fun newWorkPlace(bot: Boolean) = place
        /** What happens while spawn is asked, before its answer: the server telling of the new session, say. */
        var onSpawn: (suspend () -> Unit)? = null
        override suspend fun spawn(options: SpawnSessionOptions): SpawnSessionResult {
            spawns += options
            onSpawn?.invoke()
            return spawned.removeAt(0)
        }
        fun lists(sessionId: String) {
            if (listed.value.none { it.agentId == sessionId }) listed.value = listed.value + CallTarget(sessionId, "New", CallTarget.Kind.Task, CallTarget.Status.Idle)
        }
        override suspend fun awaitSession(sessionId: String): Boolean {
            // Home lists it before the store has it here: already under the draft's ref.
            lists(sessionId)
            seenWhileWaiting = targets?.directory()?.map { it.agentId }
            chatOf(sessionId).value = chat(emptyList(), rigMetadata(), id = sessionId)
            return true
        }
    }

    @Test
    fun aSendGoesOnceUnderItsIdWithTheModelAskedForAtItsDefaultEffort() = runBlocking {
        val cli = FakeAccount(listOf(target))
        cli.chatOf("s").value = chat(listOf(user("u1", "hi")))
        cli.modes = LegacyCallModes(listOf(CallModel("opus", "Opus", listOf("low", "high"), "high"), CallModel("sonnet", "Sonnet", listOf("low", "medium"), "medium")),
            CallMode("opus", "Opus", "high"))
        val targets = LegacyCallTargets(cli) { null }
        assertEquals(CallSendOutcome.Queued, targets.send("s", "run it", "m1", CallModeChange("sonnet")))
        assertEquals(CallSendOutcome.Queued, targets.send("s", "run it", "m1", CallModeChange("sonnet")))
        assertEquals(listOf("s" to "run it"), cli.sends)
        assertEquals(listOf(Triple("s", "sonnet", "medium")), cli.modeSets)
        // The effort alone.
        targets.send("s", "harder", "m2", CallModeChange(effort = "high"))
        assertEquals(Triple("s", null, "high"), cli.modeSets.last())
        targets.close()
        assertEquals(CallSendOutcome.Refused("The call has ended."), targets.send("s", "late", "m3", null))
    }

    @Test
    fun aStoppedSessionIsReadButNeverSentTo() = runBlocking {
        val cli = FakeAccount(listOf(target))
        cli.chatOf("s").value = chat(listOf(user("u1", "hi")), online = false)
        val targets = LegacyCallTargets(cli) { null }
        assertFalse(targets.state("s")!!.writable)
        assertTrue(targets.send("s", "go", "m1", null) is CallSendOutcome.Refused)
        assertTrue(cli.sends.isEmpty())
        targets.close()
    }

    @Test
    fun newWorkIsHappyAgentsSpawnUnderTheMessagesIdThenItsFirstMessage() = runBlocking {
        val cli = FakeAccount(emptyList())
        cli.spawned = mutableListOf(SpawnSessionResult.Pending("m1", 250), SpawnSessionResult.Success("made"))
        val targets = LegacyCallTargets(cli) { null }
        cli.targets = targets
        assertNull(targets.newWorkRefusal(CallTarget.Kind.Task, ""))
        assertTrue(targets.startsWork())
        val draft = targets.draft(CallTarget.Kind.Task, "")!!
        assertTrue(draft.agentId.startsWith(LegacyCallTargets.NEW_WORK_PREFIX))
        assertEquals("New Task", draft.title)
        // Unmade, it offers the computer's models at its defaults.
        val unmade = targets.state(draft.agentId)!!
        assertEquals(listOf("claude:opus", "claude:sonnet"), unmade.models.map { it.id })
        assertEquals("claude:opus", unmade.mode?.modelId)
        assertEquals(CallSendOutcome.Queued, targets.send(draft.agentId, "Fix the build", "m1", CallModeChange("claude:sonnet", "low")))
        assertEquals(2, cli.spawns.size)
        val asked = cli.spawns.first()
        assertEquals(cli.spawns[0], cli.spawns[1])
        assertEquals("home", asked.machineId)
        assertEquals("rig", asked.agent)
        assertEquals("m1", asked.clientRequestId)
        assertEquals("sonnet", asked.modelId)
        assertEquals("low", asked.effort)
        assertEquals(HappyAgentSpawnTarget.Task(null), asked.happyAgentTarget)
        assertEquals(listOf("made" to "Fix the build"), cli.sends)
        // After, the draft's ref is the session it made.
        assertEquals(CallSendOutcome.Queued, targets.send(draft.agentId, "and the tests", "m2", null))
        assertEquals("made" to "and the tests", cli.sends.last())
        assertEquals(draft.agentId, targets.state(draft.agentId)!!.target.agentId)
        // The alias was in before home's row came: the call never saw "made" under its own ID.
        assertEquals(listOf(draft.agentId), cli.seenWhileWaiting)
        // Its first message waited for the new session to come online; the next one didn't.
        assertTrue(cli.waits[0] > 0)
        assertEquals(0L, cli.waits[1])
        // Listed, followed and told by the draft's ref, never the session's own ID.
        assertEquals(listOf(draft.agentId), targets.directory().map { it.agentId })
        val heard = kotlinx.coroutines.CompletableDeferred<CallTargetState>()
        kotlinx.coroutines.withContext(Dispatchers.Main) { targets.onChange = { heard.complete(it) } }
        targets.follow(draft.agentId, true)
        assertEquals(listOf(draft.agentId), targets.following)
        assertEquals(draft.agentId, kotlinx.coroutines.withTimeout(5_000) { heard.await() }.target.agentId)
        targets.close()
    }

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test
    fun aSessionHomeListedBeforeSpawnAnsweredKeepsTheRefTheCallGaveItAndTheDraftsNamesItToo() = runBlocking {
        val cli = FakeAccount(emptyList())
        cli.spawned = mutableListOf(SpawnSessionResult.Success("made"))
        val targets = LegacyCallTargets(cli) { null }
        val context = CallContext(targets)
        context.initial()
        // The server tells of the new session before spawn answers: home lists it, and the agent is given its ref.
        var given: String? = null
        cli.onSpawn = {
            cli.lists("made")
            cli.chatOf("made").value = chat(emptyList(), rigMetadata(), id = "made")
            val update = context.directoryUpdate().context.map(::obj)
            given = update.firstNotNullOf { it["added"] }.jsonArray.single().jsonObject["ref"]!!.jsonPrimitive.content
        }
        val started = obj(context.handle(CallToolCall("c1", "message", obj("""{"to":"new-task","text":"Fix the build"}"""))).text)
        assertEquals("queued", started["status"]!!.jsonPrimitive.content)
        val drafted = started["ref"]!!.jsonPrimitive.content
        val made = requireNotNull(given)
        assertTrue(made != drafted)
        assertEquals(listOf("made" to "Fix the build"), cli.sends)
        // Home keeps listing it under its own ID; nothing came or went.
        assertEquals(listOf("made"), targets.directory().map { it.agentId })
        assertTrue(context.directoryUpdate().isEmpty)
        // Both refs read and reach the one session.
        for ((ref, text) in listOf(made to "and the tests", drafted to "and the docs")) {
            assertFalse(context.handle(CallToolCall("r-$ref", "readConversation", obj("""{"ref":"$ref"}"""))).isError)
            val sent = context.handle(CallToolCall("m-$ref", "message", obj("""{"to":"$ref","text":"$text"}""")))
            assertFalse(sent.text, sent.isError)
            assertEquals("made" to text, cli.sends.last())
        }
        assertEquals(1, cli.spawns.size)
        context.close()
        targets.close()
    }

    @Test
    fun theSameIdAgainWaitsForTheSendUnderWayAndGoesOnce() = runBlocking {
        val cli = FakeAccount(listOf(target))
        cli.chatOf("s").value = chat(listOf(user("u1", "hi")))
        cli.sendDelay = 500
        val targets = LegacyCallTargets(cli) { null }
        // The first try's deadline passes mid-send; the retry under the same ID finds it, not a second send.
        val first = kotlinx.coroutines.withTimeoutOrNull(100) { targets.send("s", "run it", "m1", null) }
        assertNull(first)
        assertEquals(CallSendOutcome.Queued, targets.send("s", "run it", "m1", null))
        assertEquals(listOf("s" to "run it"), cli.sends)
        targets.close()
    }

    @Test
    fun aBotIsStartedOnlyNamedAndOnlyWhereAComputerCan() = runBlocking {
        val cli = FakeAccount(emptyList())
        cli.spawned = mutableListOf(SpawnSessionResult.Success("bot"))
        val targets = LegacyCallTargets(cli) { null }
        assertEquals(CallContext.CLI_BOT_NAME, targets.newWorkRefusal(CallTarget.Kind.Bot, " "))
        val draft = targets.draft(CallTarget.Kind.Bot, "Release helper")!!
        targets.send(draft.agentId, "Watch the release", "m1", null)
        assertEquals(HappyAgentSpawnTarget.Bot("Release helper"), cli.spawns.single().happyAgentTarget)
        cli.place = LegacyNewWork.Refused(CallContext.CLI_NEW_WORK_REFUSED)
        assertEquals(CallContext.CLI_NEW_WORK_REFUSED, targets.newWorkRefusal(CallTarget.Kind.Task, ""))
        assertFalse(targets.startsWork())
        assertNull(targets.draft(CallTarget.Kind.Task, ""))
        targets.close()
    }

    @Test
    fun aSpawnTheComputerRefusesSaysWhyAndSendsNothing() = runBlocking {
        val cli = FakeAccount(emptyList())
        cli.spawned = mutableListOf(SpawnSessionResult.Error("Happy Agent is out of date"))
        val targets = LegacyCallTargets(cli) { null }
        val draft = targets.draft(CallTarget.Kind.Task, "Docs")!!
        assertEquals(CallSendOutcome.Refused("Happy Agent is out of date"), targets.send(draft.agentId, "go", "m1", null))
        assertTrue(cli.sends.isEmpty())
        assertEquals(HappyAgentSpawnTarget.Task("Docs"), cli.spawns.single().happyAgentTarget)
        targets.close()
    }
}
