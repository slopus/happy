package com.slopus.happy.ui.pipelines

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.Message
import com.slopus.happy.pipelines.ClusterPipelines
import com.slopus.happy.pipelines.PipelineAcquire
import com.slopus.happy.pipelines.PipelineAuthor
import com.slopus.happy.pipelines.PipelineCompute
import com.slopus.happy.pipelines.PipelineComputeGrant
import com.slopus.happy.pipelines.PipelineConcurrency
import com.slopus.happy.pipelines.PipelineConcurrencyMode
import com.slopus.happy.pipelines.PipelineDefinition
import com.slopus.happy.pipelines.PipelineDetail
import com.slopus.happy.pipelines.PipelineEdge
import com.slopus.happy.pipelines.PipelineFailure
import com.slopus.happy.pipelines.PipelineGrant
import com.slopus.happy.pipelines.PipelineLease
import com.slopus.happy.pipelines.PipelineLogEntry
import com.slopus.happy.pipelines.PipelineLogPage
import com.slopus.happy.pipelines.PipelineModelUsage
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelineNodeRun
import com.slopus.happy.pipelines.PipelineNodeState
import com.slopus.happy.pipelines.PipelinePermissions
import com.slopus.happy.pipelines.PipelineRun
import com.slopus.happy.pipelines.PipelineRunEntry
import com.slopus.happy.pipelines.PipelineRunListEntry
import com.slopus.happy.pipelines.PipelineRunNotice
import com.slopus.happy.pipelines.PipelineRunPage
import com.slopus.happy.pipelines.PipelineRunState
import com.slopus.happy.pipelines.PipelineRunSummary
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineStatusLine
import com.slopus.happy.pipelines.PipelineSummary
import com.slopus.happy.pipelines.PipelineType
import com.slopus.happy.pipelines.PipelineVersion
import com.slopus.happy.pipelines.PipelineVersionDetail
import com.slopus.happy.pipelines.PipelinesBackend
import com.slopus.happy.pipelines.PipelinesSource
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.connection.AgentHomeItem
import com.slopus.happy.ui.connection.AgentHomeList
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.conversation.ConversationRowView
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Debug builds only: the real pipeline pages over an in-memory Happy Cloud
 * server ([FakePipelines]), reached from a home card with the Pipelines
 * row under Plugins. Every run opens: a running deploy waiting on its child
 * test run, whose unit tests print a line every 2.5 s and pass after a
 * minute; a failed deploy with a traceback and an agent node that triaged
 * it; an agent pipeline with its usage. Deploy production's definition grants
 * secrets, a repository, hosts and a pool of computers, and has a history of three. The queued run starts after 5 s.
 * Each change comes with the `pipeline.*` events a server journals, so the
 * pages follow them as they would a real one, and Abort aborts. Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.pipelines.PipelinesFixturesActivity`
 * (`--ez pipelines.open true` opens the list at once; `--es pipelines.run r-failed`
 * a run, and with `--es pipelines.node build` one of its nodes; `--es pipelines.pipeline
 * p-deploy` a pipeline, with `--ei pipelines.version 2` one of its versions, and
 * with `--es pipelines.node triage` too one of that version's nodes; `--ez pipelines.chat true`
 * a chat told how its runs ended, and with `--ez pipelines.chat.before true` as it drew before).
 */
class PipelinesFixturesActivity : ComponentActivity() {
    @Serializable private data object FixtureHomeRoute

    /** A chat where the agent was told how its runs ended; [before] draws its own messages as this app did before it told them apart. */
    @Serializable private data class FixtureChatRoute(val before: Boolean)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val open = intent.getBooleanExtra("pipelines.open", false)
        val run = intent.getStringExtra("pipelines.run")
        val node = intent.getStringExtra("pipelines.node")
        val pipeline = intent.getStringExtra("pipelines.pipeline")
        val version = intent.getIntExtra("pipelines.version", 0)
        val chat = intent.getBooleanExtra("pipelines.chat", false)
        val before = intent.getBooleanExtra("pipelines.chat.before", false)
        setContent {
            HappyTheme {
                val nav = rememberNavController()
                val events = remember { MutableSharedFlow<AgentEvent>(extraBufferCapacity = 64) }
                val backend = remember { FakePipelines(System.currentTimeMillis()) { type, data -> events.tryEmit(AgentEvent(null, type, data)) } }
                LaunchedEffect(Unit) { backend.play() }
                val agents = AgentNames { mapOf("a-chief" to "Happy", "a-release" to "Release bot")[it] }
                val people = PeopleNames { mapOf("u-steve" to "Steve", "u-kirill" to "Kirill")[it] }
                val start: Any = when {
                    chat -> FixtureChatRoute(before)
                    pipeline != null && version > 0 && node != null -> PipelineVersionNodeRoute("fixture", pipeline, version, node)
                    pipeline != null && version > 0 -> PipelineVersionRoute("fixture", pipeline, version, backend.nameOf(pipeline))
                    pipeline != null -> PipelineRoute("fixture", pipeline, backend.nameOf(pipeline))
                    run != null && node != null -> PipelineNodeRoute("fixture", run, node)
                    run != null -> PipelineRunRoute("fixture", run)
                    open -> PipelinesRoute("fixture")
                    else -> FixtureHomeRoute
                }
                ProvideWindowLayout {
                    RetainedNavHost(nav, start, rememberNavMotion(), modifier = Modifier.backdrop(nav)) {
                        page<FixtureHomeRoute> {
                            Screen(header = { StackHeader("Acme", onBack = ::finish) }) {
                                AgentHomeList(
                                    items = listOf(
                                        AgentHomeItem.Gap(AgentFeedSection.Places, first = true),
                                        AgentHomeItem.Row(AgentFeedRow.Artifacts, first = true, last = false),
                                        AgentHomeItem.Row(AgentFeedRow.Plugins, first = false, last = false),
                                        AgentHomeItem.Row(AgentFeedRow.Pipelines, first = false, last = false),
                                        AgentHomeItem.Row(AgentFeedRow.Todos, first = false, last = true),
                                    ),
                                    state = rememberLazyListState(),
                                    onOpen = {},
                                    contentPadding = PaddingValues(),
                                    onOpenPipelines = { nav.navigate(PipelinesRoute("fixture")) },
                                )
                            }
                        }
                        page<FixtureChatRoute> { entry ->
                            NoticeChat(entry.toRoute<FixtureChatRoute>().before, onBack = ::finish) { notice ->
                                nav.navigate(PipelineRunRoute("fixture", notice.runId, notice.pipelineName))
                            }
                        }
                        pipelineRoutes(nav) { PagePipelines(backend, events, agents, people) }
                    }
                }
            }
        }
    }
}

/**
 * An agent's chat after it ran pipelines, drawn by the chat's own rows from
 * messages as the cluster sends them: the person's request, the agent's
 * answer, then what the agent was told without a person writing it: a goal's
 * continuation, a run's result from a cluster that doesn't describe the run
 * yet (production today), and two that do, one succeeded and one failed with
 * its summary. A run's card opens the run ([onOpenRun]). [before] drops the
 * sender from the agent's own messages, which is how this app drew them
 * before: as the person's.
 */
@Composable
private fun NoticeChat(before: Boolean, onBack: () -> Unit, onOpenRun: (PipelineRunNotice) -> Unit) {
    val agent = "a-release"
    val rows = remember(before) {
        fun self(id: String, at: Long, text: String, explanation: String? = null, run: String? = null) = Message(
            id, "user", at, listOf(Block.Text(text)),
            status = "accepted",
            senderAgentId = agent.takeUnless { before },
            senderAgentExplanation = explanation.takeUnless { before },
            pipelineRun = run?.takeUnless { before }?.let { Json.parseToJsonElement(it).jsonObject },
        )
        listOf(
            Message("m1", "user", 1, listOf(Block.Text("Ship main once the tests pass, and answer Ana's invoice email.")), status = "accepted"),
            Message("m2", "agent", 2, listOf(Block.Text("Started **Deploy production** on main and **Incoming email** for Ana's message. I'll pick up when they finish."))),
            self("m3", 3, "Continue working toward your goal: ship main and answer Ana."),
            self(
                "m4", 4,
                "Pipeline Nightly backup (version 1) run r-nightly ended: failed. Read it with read_pipeline_run.",
                explanation = "Pipeline Nightly backup failed",
            ),
            self(
                "m5", 5,
                "Pipeline Incoming email (version 12) run r-email ended: succeeded.",
                explanation = "Pipeline Incoming email succeeded",
                run = """{"pipelineId":"p-email","pipelineName":"Incoming email","runId":"r-email","state":"succeeded","version":12}""",
            ),
            self(
                "m6", 6,
                "Pipeline Deploy production (version 3) run r-failed ended: failed (build: exception).",
                explanation = "Pipeline Deploy production failed",
                run = """{"pipelineId":"p-deploy","pipelineName":"Deploy production","runId":"r-failed","state":"failed","summary":"build: exception","version":3}""",
            ),
            Message("m7", "agent", 7, listOf(Block.Text("Ana has her reply. The deploy failed in **build**; I'm reading the run to see why."))),
        ).flatMap { ConversationRowBuilder.build(it, agent, null, false) }
    }
    val actions = remember { ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) }, onOpenPipelineRun = onOpenRun) }
    val bubble = userMessageBubblePalette(null, HappyTheme.colors.dark)
    Screen(header = { StackHeader(if (before) "Release bot (before)" else "Release bot", onBack) }) {
        LazyColumn(Modifier.fillMaxSize()) {
            items(rows, key = { it.key }) { row -> ConversationRowView(row, bubble, actions) }
        }
    }
}

/**
 * A team's pipelines and runs in memory, answering after a short wait as a
 * server would; 6 runs a page so Older runs shows. [emit] journals an event.
 */
private class FakePipelines(private val now: Long, private val emit: (String, JsonObject) -> Unit) : PipelinesBackend {
    private val minute = 60_000L

    private val deploy = "p-deploy" to "Deploy production"
    private val email = "p-email" to "Incoming email"
    private val tests = "p-tests" to "Run tests"
    private val digest = "p-digest" to "Weekly digest"
    private val names = mapOf(deploy, email, tests, "p-nightly" to "Nightly backup")

    /** What the list called a pipeline, archived ones too, as the page that opens one passes it on. */
    fun nameOf(pipelineId: String): String? = (names + digest)[pipelineId]

    private fun success(from: String, to: String) = PipelineEdge(from, to, onSuccess = true)
    private fun failure(from: String, to: String) = PipelineEdge(from, to, onSuccess = false)

    /** A type as a definition writes it, and as the app reads it. */
    private fun type(schema: String): PipelineType {
        val json = Json.parseToJsonElement(schema)
        return PipelineType(ClusterPipelines.schema(json)!!, json)
    }

    private val definitions = mapOf(
        deploy.first to PipelineDefinition(
            root = "build",
            nodes = listOf(
                PipelineNodeDefinition(
                    "build", PipelineNodeKind.Code,
                    input = type("""{"type":"object","properties":{"branch":{"type":"string"},"sha":{"type":"string"}},"required":["branch","sha"]}"""),
                    output = type("""{"type":"object","properties":{"apk":{"type":"string"},"sha":{"type":"string"}},"required":["apk","sha"]}"""),
                    permissions = PipelinePermissions(secrets = listOf("SIGNING_KEY"), repositories = listOf(PipelineGrant("happy/app", write = false))),
                    compute = PipelineCompute(acquire = listOf(PipelineAcquire("builder", "mac-builders", null)), pass = listOf("builder")),
                    timeoutSeconds = 1800,
                    source = "def main(input):\n    sh(\"git clone --depth 1 happy:app .\")\n    sh(f\"git checkout {input['sha']}\")\n    check(sh(\"./gradlew assembleRelease\"))\n    return {\"apk\": \"build/app-release.apk\", \"sha\": input[\"sha\"]}",
                ),
                PipelineNodeDefinition(
                    "test", PipelineNodeKind.Pipeline, pipelineId = tests.first,
                    input = type("""{"type":"object","properties":{"sha":{"type":"string"}},"required":["sha"]}"""),
                    output = type("""{"type":"object","properties":{"passed":{"type":"integer"},"failed":{"type":"integer"}},"required":["passed","failed"]}"""),
                ),
                PipelineNodeDefinition(
                    "deploy", PipelineNodeKind.Code,
                    permissions = PipelinePermissions(secrets = listOf("PLAY_STORE_KEY"), egressHosts = listOf("androidpublisher.googleapis.com")),
                    compute = PipelineCompute(use = listOf("builder")),
                    source = "def main(input):\n    upload(\"build/app-release.apk\", track=\"production\")\n    return {\"track\": \"production\"}",
                    output = type("""{"type":"object","properties":{"track":{"type":"string","enum":["internal","production"]}},"required":["track"]}"""),
                ),
                PipelineNodeDefinition(
                    "announce", PipelineNodeKind.Agent, model = "openai/gpt-6.1-terra",
                    output = type("""{"type":"object","properties":{"message":{"type":"string"},"channel":{"type":["string","null"]}},"required":["message"]}"""),
                    permissions = PipelinePermissions(tools = listOf("web_fetch"), egressHosts = listOf("hooks.slack.com")),
                    instructions = "Write a two-line release note for the **production** release and post it to #releases.",
                ),
                PipelineNodeDefinition(
                    "triage", PipelineNodeKind.Agent, model = "anthropic/claude-sonnet-5", effort = "high",
                    input = type("""{"type":"object","properties":{"build":{"type":["object","null"],"properties":{"node":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"}},"required":["node","code","message"]},"test":{"type":["object","null"],"properties":{}},"deploy":{"type":["object","null"],"properties":{}}}}"""),
                    output = type("""{"type":"object","properties":{"summary":{"type":"string"},"owner":{"type":"string"}},"required":["summary"]}"""),
                    joinAny = true,
                    timeoutSeconds = 600,
                    instructions = "A step of the deploy failed. Read its message, find the change that broke it, and name who should fix it.",
                ),
            ),
            edges = listOf(
                success("build", "test"), success("test", "deploy"), success("deploy", "announce"),
                failure("build", "triage"), failure("test", "triage"), failure("deploy", "triage"),
            ),
            input = type("""{"type":"object","properties":{"branch":{"type":"string"},"sha":{"type":"string"},"notes":{"type":"array","items":{"type":"string"}},"dryRun":{"type":"boolean"}},"required":["branch","sha"]}"""),
            concurrency = PipelineConcurrency(PipelineConcurrencyMode.Supersede, group = "{{ input.branch }}"),
            triggerAgents = listOf("a-release", "a-chief"),
            permissions = PipelinePermissions(
                tools = listOf("web_fetch"),
                vaults = listOf(PipelineGrant("release-notes", write = true)),
                secrets = listOf("SIGNING_KEY", "PLAY_STORE_KEY"),
                repositories = listOf(PipelineGrant("happy/app", write = false)),
                pipelines = listOf(tests.first),
                egressHosts = listOf("androidpublisher.googleapis.com", "hooks.slack.com"),
                compute = PipelineComputeGrant(pools = listOf("mac-builders"), maxLeases = 1),
            ),
        ),
        tests.first to PipelineDefinition(
            "setup",
            listOf(
                PipelineNodeDefinition("setup", PipelineNodeKind.Code, source = "def main(input):\n    return input"),
                PipelineNodeDefinition("unit", PipelineNodeKind.Code, compute = PipelineCompute(acquire = listOf(PipelineAcquire("runner", null, "linux-ci-4"))), source = "def main(input):\n    return run_tests()"),
                PipelineNodeDefinition("lint", PipelineNodeKind.Code, source = "def main(input):\n    return lint()"),
                PipelineNodeDefinition("report", PipelineNodeKind.Agent, model = "openai/gpt-6.1-sol"),
            ),
            listOf(success("setup", "unit"), success("setup", "lint"), success("unit", "report"), success("lint", "report")),
            input = type("""{"type":"object","properties":{"sha":{"type":"string"}},"required":["sha"]}"""),
            concurrency = PipelineConcurrency(PipelineConcurrencyMode.Queue, group = "{{ input.sha }}", batch = true),
        ),
        email.first to PipelineDefinition(
            "classify",
            listOf(
                PipelineNodeDefinition("classify", PipelineNodeKind.Agent, model = "openai/gpt-6.1-sol", output = type("""{"type":"object","properties":{"kind":{"type":"string","enum":["billing","support","spam"]}},"required":["kind"]}""")),
                PipelineNodeDefinition("reply", PipelineNodeKind.Agent, model = "anthropic/claude-sonnet-5", permissions = PipelinePermissions(agents = listOf("a-chief"))),
            ),
            listOf(success("classify", "reply")),
            input = type("""{"type":"object","properties":{"from":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},"required":["from","subject","body"]}"""),
            triggerAgents = listOf("a-chief"),
        ),
    )

    /** The history behind each pipeline's head, newest first. */
    private val versions = mapOf(
        deploy.first to listOf(
            PipelineVersion(3, "Supersede runs of the same branch instead of queueing them", PipelineAuthor("u-steve", "a-release"), now - 2 * 24 * 60 * minute),
            PipelineVersion(2, "Triage failures with an agent", PipelineAuthor("u-kirill", null), now - 9 * 24 * 60 * minute),
            PipelineVersion(1, "", PipelineAuthor("u-steve", null), now - 30 * 24 * 60 * minute),
        ),
        email.first to (12 downTo 1).map { PipelineVersion(it, if (it == 12) "Reply in the sender's language" else "Tune the classifier", PipelineAuthor("u-steve", "a-chief"), now - (13 - it) * 24 * 60 * minute) },
        tests.first to (7 downTo 1).map { PipelineVersion(it, "Split lint from unit tests".takeIf { _ -> it == 7 }.orEmpty(), PipelineAuthor("u-kirill", null), now - (8 - it) * 3 * 24 * 60 * minute) },
        "p-nightly" to listOf(PipelineVersion(1, "Back up the vaults every night", PipelineAuthor("u-steve", null), now - 60 * 24 * 60 * minute)),
    )

    private fun entry(id: String, state: PipelineRunState, ago: Long, took: Long?, trigger: PipelineRunTrigger?, parent: String? = null, version: Int = 3) =
        PipelineRunEntry(
            id, version, state, trigger, parent,
            createdAt = now - ago,
            startedAt = if (state == PipelineRunState.Queued) null else now - ago + 2_000,
            endedAt = took?.let { now - ago + 2_000 + it },
        )

    private fun nodeRun(
        id: String,
        kind: PipelineNodeKind,
        state: PipelineNodeState,
        started: Long? = null,
        took: Long? = null,
        status: String? = null,
        progress: Float? = null,
        failure: PipelineFailure? = null,
        child: String? = null,
        usage: List<PipelineModelUsage>? = null,
        input: JsonObject? = null,
        output: JsonObject? = null,
    ): PipelineNodeRun {
        val line = status?.let { PipelineStatusLine(it, progress, (started ?: now) + 1_000) }
        return PipelineNodeRun(
            id, kind, state, line, listOfNotNull(line), input, output, failure, null, child,
            startedAt = started, endedAt = took?.let { (started ?: now) + it }, usage = usage,
        )
    }

    private fun json(vararg pairs: Pair<String, String>) = buildJsonObject { pairs.forEach { (key, value) -> put(key, value) } }

    private val runs = mutableListOf<PipelineRunListEntry>()
    private val details = HashMap<String, PipelineRun>()
    private val logs = HashMap<Pair<String, String>, MutableList<PipelineLogEntry>>()

    private fun add(
        pipeline: Pair<String, String>,
        entry: PipelineRunEntry,
        nodes: List<PipelineNodeRun> = emptyList(),
        input: JsonObject? = null,
        outputs: JsonObject? = null,
        leases: List<PipelineLease> = emptyList(),
        children: List<String> = emptyList(),
        archived: Boolean = false,
    ) {
        runs += PipelineRunListEntry(entry, pipeline.first, pipeline.second, archived)
        details[entry.id] = PipelineRun(entry, pipeline.first, entry.parentRunId ?: entry.id, null, input ?: json("branch" to "main"), outputs, nodes, leases, children)
    }

    private fun log(run: String, node: String, vararg entries: PipelineLogEntry) {
        logs.getOrPut(run to node) { mutableListOf() } += entries
    }

    init {
        val running = now - 95_000
        add(deploy, entry("r-queued", PipelineRunState.Queued, 20_000, null, PipelineRunTrigger.Agent("a-release")), input = json("branch" to "main", "sha" to "9b04d1e"))
        add(
            deploy, entry("r-running", PipelineRunState.Running, 95_000, null, PipelineRunTrigger.Agent("a-release")),
            listOf(
                nodeRun("build", PipelineNodeKind.Code, PipelineNodeState.Succeeded, running + 2_000, 14_000, status = "Built app-release.apk", progress = 1f, output = json("apk" to "build/app-release.apk", "sha" to "4f2c9e1")),
                nodeRun("test", PipelineNodeKind.Pipeline, PipelineNodeState.Running, running + 16_500, status = "Waiting for Run tests", child = "r-child"),
                nodeRun("deploy", PipelineNodeKind.Code, PipelineNodeState.Pending),
                nodeRun("announce", PipelineNodeKind.Agent, PipelineNodeState.Pending),
                nodeRun("triage", PipelineNodeKind.Agent, PipelineNodeState.Pending),
            ),
            input = json("branch" to "main", "sha" to "4f2c9e1"),
            leases = listOf(PipelineLease("builder", "mac-mini-2", listOf("deploy"), null)),
            children = listOf("r-child"),
        )
        log(
            "r-running", "build",
            PipelineLogEntry.Status(1, running + 2_400, "Checking out 4f2c9e1", null),
            PipelineLogEntry.Command(2, running + 2_600, "sh-1", "git clone --depth 1 happy:app .", null, "builder", PipelineLogEntry.CommandState.Exited, 0, 1_840, "Cloning into '.'...\n", false),
            PipelineLogEntry.Command(
                3, running + 4_600, "sh-2", "./gradlew assembleRelease --console=plain", null, "builder", PipelineLogEntry.CommandState.Exited, 0, 11_200,
                "> Task :app:compileReleaseKotlin\n> Task :app:assembleRelease\n\nBUILD SUCCESSFUL in 11s\n42 actionable tasks: 42 executed\n", false,
            ),
            PipelineLogEntry.Output(4, running + 15_900, false, "apk: build/app-release.apk (18.4 MB)\n"),
            PipelineLogEntry.Status(5, running + 16_000, "Built app-release.apk", 1f),
        )
        val child = now - 78_000
        add(
            tests, entry("r-child", PipelineRunState.Running, 78_000, null, PipelineRunTrigger.Pipeline("r-running", "test"), parent = "r-running", version = 7),
            listOf(
                nodeRun("setup", PipelineNodeKind.Code, PipelineNodeState.Succeeded, child + 2_000, 3_000),
                nodeRun("unit", PipelineNodeKind.Code, PipelineNodeState.Running, child + 5_200, status = "tests/test_sync.py", progress = 0.2f),
                nodeRun("lint", PipelineNodeKind.Code, PipelineNodeState.Succeeded, child + 5_300, 21_000, output = json("warnings" to "0")),
                nodeRun("report", PipelineNodeKind.Agent, PipelineNodeState.Pending),
            ),
            input = json("sha" to "4f2c9e1"),
            leases = listOf(PipelineLease("runner", "linux-ci-4", listOf("unit"), null)),
        )
        log(
            "r-child", "unit",
            PipelineLogEntry.Output(1, child + 5_400, false, "Running 212 tests on linux-ci-4\n"),
            PipelineLogEntry.Command(2, child + 6_000, "sh-1", "pytest -q tests", "app", "runner", PipelineLogEntry.CommandState.Running, null, null, unitOutput(6), false),
        )
        val emailed = now - 14 * minute + 2_000
        add(
            email, entry("r-email", PipelineRunState.Succeeded, 14 * minute, 48_000, PipelineRunTrigger.Agent("a-chief"), version = 12),
            listOf(
                nodeRun(
                    "classify", PipelineNodeKind.Agent, PipelineNodeState.Succeeded, emailed, 9_000, status = "Classified as billing", progress = 1f,
                    usage = listOf(PipelineModelUsage("openai", "openai/gpt-6.1-sol", 4_120, 210, 0, 0, 96, 0.0062)),
                    output = json("kind" to "billing"),
                ),
                nodeRun(
                    "reply", PipelineNodeKind.Agent, PipelineNodeState.Succeeded, emailed + 9_500, 37_000,
                    usage = listOf(PipelineModelUsage("anthropic", "anthropic/claude-sonnet-5", 9_800, 1_420, 6_144, 0, 0, null)),
                    output = json("sent" to "true", "to" to "ana@acme.dev"),
                ),
            ),
            input = json("from" to "ana@acme.dev", "subject" to "Invoice #2291"),
            outputs = buildJsonObject { put("reply", json("sent" to "true", "to" to "ana@acme.dev")) },
        )
        log(
            "r-email", "classify",
            PipelineLogEntry.Message(1, emailed + 1_000, "The message asks about **invoice #2291**; it reads as a billing question, not a complaint."),
            PipelineLogEntry.Tool(2, emailed + 2_000, "call-1", "web_fetch", "https://billing.acme.dev/invoices/2291", PipelineLogEntry.ToolState.Ok, 640, null),
            PipelineLogEntry.Status(3, emailed + 3_000, "Classified as billing", 1f),
        )
        val failed = now - 3 * 60 * minute + 2_000
        val traceback = "Traceback (most recent call last):\n  File \"main.py\", line 14, in main\n    result = sh(\"./gradlew assembleRelease\")\n  File \"main.py\", line 31, in check\n    raise RuntimeError(f\"gradle exited {code}\")\nRuntimeError: gradle exited 1"
        add(
            deploy, entry("r-failed", PipelineRunState.Failed, 3 * 60 * minute, 4 * minute + 12_000, PipelineRunTrigger.Agent(null)),
            listOf(
                nodeRun("build", PipelineNodeKind.Code, PipelineNodeState.Failed, failed, 3 * minute + 40_000, failure = PipelineFailure("exception", traceback), input = json("branch" to "main", "sha" to "a77e310")),
                nodeRun("test", PipelineNodeKind.Pipeline, PipelineNodeState.Skipped),
                nodeRun("deploy", PipelineNodeKind.Code, PipelineNodeState.Skipped),
                nodeRun("announce", PipelineNodeKind.Agent, PipelineNodeState.Skipped),
                nodeRun(
                    "triage", PipelineNodeKind.Agent, PipelineNodeState.Succeeded, failed + 3 * minute + 41_000, 30_000,
                    usage = listOf(PipelineModelUsage("anthropic", "anthropic/claude-sonnet-5", 18_234, 912, 12_288, 0, 340, 0.0421)),
                    output = json("summary" to "Kotlin compile error in SyncEngine.kt:211", "owner" to "Release bot"),
                ),
            ),
            input = json("branch" to "main", "sha" to "a77e310"),
            leases = listOf(PipelineLease("builder", "mac-mini-2", emptyList(), failed + 3 * minute + 41_000)),
        )
        log(
            "r-failed", "build",
            PipelineLogEntry.Status(1, failed + 400, "Checking out a77e310", null),
            PipelineLogEntry.Command(2, failed + 600, "sh-1", "git clone --depth 1 happy:app .", null, "builder", PipelineLogEntry.CommandState.Exited, 0, 1_910, "Cloning into '.'...\n", false),
            PipelineLogEntry.Command(
                3, failed + 2_600, "sh-2", "./gradlew assembleRelease --console=plain", null, "builder", PipelineLogEntry.CommandState.Exited, 1, 216_400,
                "> Task :app:compileReleaseKotlin FAILED\ne: SyncEngine.kt:211:17 Unresolved reference: cursorAfter\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':app:compileReleaseKotlin'.\n\nBUILD FAILED in 3m 36s\n",
                true,
            ),
            PipelineLogEntry.Output(4, failed + 219_100, true, "$traceback\n"),
        )
        log(
            "r-failed", "triage",
            PipelineLogEntry.Tool(1, failed + 3 * minute + 42_000, "call-1", "sh", "grep -n cursorAfter -r app/src", PipelineLogEntry.ToolState.Ok, 820, null),
            PipelineLogEntry.Message(2, failed + 3 * minute + 50_000, "The build broke on `SyncEngine.kt:211`: `cursorAfter` was renamed in **a77e310**. Assigning it to Release bot."),
            PipelineLogEntry.Tool(3, failed + 3 * minute + 55_000, "call-2", "web_fetch", "https://status.acme.dev", PipelineLogEntry.ToolState.Error, 30_000, "Timed out after 30 s"),
        )
        add(email, entry("r-aborted", PipelineRunState.Aborted, 26 * 60 * minute, 9_000, PipelineRunTrigger.Agent("a-chief"), version = 11))
        add(tests, entry("r-old-child", PipelineRunState.Succeeded, 27 * 60 * minute, 2 * minute, PipelineRunTrigger.Pipeline("r-gone", "test"), parent = "r-gone", version = 6))
        add(digest, entry("r-archived", PipelineRunState.Succeeded, 3 * 24 * 60 * minute, 61 * minute, PipelineRunTrigger.Agent("a-chief"), version = 2), archived = true)
        add(deploy, entry("r-superseded", PipelineRunState.Superseded, 4 * 24 * 60 * minute, 30_000, PipelineRunTrigger.Agent("a-release"), version = 2))
    }

    private fun unitOutput(lines: Int) = (1..lines).joinToString("") {
        "tests/test_${listOf("auth", "sync", "feed", "chat", "push", "vault")[it % 6]}_$it.py ........  [${it * 100 / UNIT_LINES}%]\n"
    }

    /** What a server would do meanwhile: the queued run starts; the unit tests print, pass, and the report starts. */
    suspend fun play() {
        var lines = 6
        while (true) {
            delay(2_500)
            if (lines == 8) {
                change("r-queued") { it.copy(entry = it.entry.copy(state = PipelineRunState.Running, startedAt = System.currentTimeMillis())) }
                emit(PipelinesSource.RUN_UPDATED, event("r-queued"))
            }
            if (!details.getValue("r-child").state.active) return
            lines++
            val done = lines >= UNIT_LINES
            val entries = logs.getValue("r-child" to "unit")
            val command = entries[1] as PipelineLogEntry.Command
            entries[1] = command.copy(
                output = unitOutput(lines) + if (done) "\n212 passed in 61.4s\n" else "",
                state = if (done) PipelineLogEntry.CommandState.Exited else PipelineLogEntry.CommandState.Running,
                exitCode = if (done) 0 else null,
                durationMs = if (done) System.currentTimeMillis() - command.at else null,
            )
            val at = System.currentTimeMillis()
            changeNode("r-child", "unit") {
                val line = PipelineStatusLine("tests/test_$lines.py", lines.toFloat() / UNIT_LINES, at)
                if (done) it.copy(state = PipelineNodeState.Succeeded, endedAt = at, status = line, statuses = it.statuses + line)
                else it.copy(status = line, statuses = it.statuses + line)
            }
            if (done) changeNode("r-child", "report") { it.copy(state = PipelineNodeState.Running, startedAt = at, status = PipelineStatusLine("Summarising 212 results", null, at)) }
            emit(PipelinesSource.NODE_LOG, event("r-child", "unit"))
            emit(PipelinesSource.NODE_UPDATED, event("r-child", "unit"))
            if (done) return
        }
    }

    private fun event(runId: String, nodeId: String? = null) = buildJsonObject {
        put("runId", runId)
        nodeId?.let { put("nodeId", it) }
    }

    private fun change(id: String, change: (PipelineRun) -> PipelineRun) {
        val run = change(details.getValue(id))
        details[id] = run
        val at = runs.indexOfFirst { it.id == id }
        runs[at] = runs[at].copy(run = run.entry)
    }

    private fun changeNode(runId: String, nodeId: String, change: (PipelineNodeRun) -> PipelineNodeRun) =
        change(runId) { run -> run.copy(nodes = run.nodes.map { if (it.nodeId == nodeId) change(it) else it }) }

    override suspend fun pipelines(): List<PipelineSummary> {
        delay(300)
        fun last(id: String) = runs.firstOrNull { it.pipelineId == id }?.run?.let { PipelineRunSummary(it.id, it.state, it.createdAt, it.endedAt) }
        return summaries.map { it.copy(lastRun = last(it.id)) }
    }

    override suspend fun runs(cursor: String?): PipelineRunPage<PipelineRunListEntry> {
        delay(400)
        val from = cursor?.let { id -> runs.indexOfFirst { it.id == id } } ?: 0
        val page = runs.drop(from).take(PAGE)
        return PipelineRunPage(page, runs.getOrNull(from + PAGE)?.id)
    }

    override suspend fun run(runId: String): PipelineRun? {
        delay(250)
        return details[runId]
    }

    override suspend fun pipelineName(pipelineId: String): String? {
        delay(150)
        return names[pipelineId]
    }

    private val summaries = listOf(
        PipelineSummary(deploy.first, deploy.second, "Builds, tests and ships main.", 3, true, null),
        PipelineSummary(email.first, email.second, null, 12, true, null),
        PipelineSummary("p-nightly", "Nightly backup", null, 1, false, null),
        PipelineSummary(tests.first, tests.second, null, 7, true, null),
    )

    override suspend fun pipeline(pipelineId: String): PipelineDetail? {
        delay(300)
        val summary = summaries.firstOrNull { it.id == pipelineId } ?: return null
        val head = versions[pipelineId]?.first() ?: return null
        return PipelineDetail(summary.id, summary.name, summary.description, summary.enabled, PipelineVersionDetail(head, definitions[pipelineId]))
    }

    override suspend fun versions(pipelineId: String): List<PipelineVersion>? {
        delay(200)
        return versions[pipelineId]
    }

    /** Every version reads as the head's definition: enough to page through. */
    override suspend fun version(pipelineId: String, number: Int): PipelineVersionDetail? {
        delay(200)
        val version = versions[pipelineId]?.firstOrNull { it.number == number } ?: return null
        return PipelineVersionDetail(version, definitions[pipelineId])
    }

    override suspend fun pipelineRuns(pipelineId: String, cursor: String?): PipelineRunPage<PipelineRunEntry>? {
        delay(300)
        val own = runs.filter { it.pipelineId == pipelineId }
        val from = cursor?.let { id -> own.indexOfFirst { it.id == id } } ?: 0
        return PipelineRunPage(own.drop(from).take(PAGE).map { it.run }, own.getOrNull(from + PAGE)?.id)
    }

    override suspend fun log(runId: String, nodeId: String, after: Long): PipelineLogPage? {
        delay(200)
        val entries = logs[runId to nodeId] ?: return if (details[runId]?.node(nodeId)?.startedAt == null) null else PipelineLogPage(emptyList(), after, 0, emptyList())
        // A command rewritten in place comes back under `changed`; a reader replaces its copy.
        return PipelineLogPage(entries.filter { it.seq > after }, entries.lastOrNull()?.seq ?: after, 0, entries.filter { it.seq <= after && it is PipelineLogEntry.Command })
    }

    override suspend fun abort(runId: String) {
        delay(600)
        val ended = System.currentTimeMillis()
        fun aborted(id: String) = change(id) { run ->
            if (!run.state.active) {
                run
            } else {
                run.copy(
                    entry = run.entry.copy(state = PipelineRunState.Aborted, endedAt = ended),
                    nodes = run.nodes.map { if (it.state == PipelineNodeState.Pending || it.state == PipelineNodeState.Running) it.copy(state = PipelineNodeState.Aborted, endedAt = it.startedAt?.let { ended }) else it },
                    leases = run.leases.map { it.copy(holders = emptyList(), releasedAt = ended) },
                )
            }
        }
        aborted(runId)
        // Its children nothing else waits for go with it.
        val children = details.getValue(runId).childIds
        children.forEach { aborted(it) }
        (listOf(runId) + children).forEach { emit(PipelinesSource.RUN_UPDATED, event(it)) }
    }

    private companion object {
        const val PAGE = 6
        const val UNIT_LINES = 30
    }
}
