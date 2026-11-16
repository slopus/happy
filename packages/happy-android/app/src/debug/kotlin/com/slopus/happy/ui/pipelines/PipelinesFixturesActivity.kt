package com.slopus.happy.ui.pipelines

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.pipelines.PipelineDefinition
import com.slopus.happy.pipelines.PipelineEdge
import com.slopus.happy.pipelines.PipelineFailure
import com.slopus.happy.pipelines.PipelineLease
import com.slopus.happy.pipelines.PipelineLogEntry
import com.slopus.happy.pipelines.PipelineLogPage
import com.slopus.happy.pipelines.PipelineModelUsage
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelineNodeRun
import com.slopus.happy.pipelines.PipelineNodeState
import com.slopus.happy.pipelines.PipelineRun
import com.slopus.happy.pipelines.PipelineRunEntry
import com.slopus.happy.pipelines.PipelineRunListEntry
import com.slopus.happy.pipelines.PipelineRunPage
import com.slopus.happy.pipelines.PipelineRunState
import com.slopus.happy.pipelines.PipelineRunSummary
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineStatusLine
import com.slopus.happy.pipelines.PipelineSummary
import com.slopus.happy.pipelines.PipelinesBackend
import com.slopus.happy.pipelines.PipelinesSource
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.connection.AgentHomeItem
import com.slopus.happy.ui.connection.AgentHomeList
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Debug builds only: the real pipeline pages over an in-memory Happy Cloud
 * server ([FakePipelines]), reached from a home card with the Pipelines
 * row under Plugins. Every run opens: a running deploy waiting on its child
 * test run, whose unit tests print a line every 2.5 s and pass after a
 * minute; a failed deploy with a traceback and an agent node that triaged
 * it; an agent pipeline with its usage. The queued run starts after 5 s.
 * Each change comes with the `pipeline.*` events a server journals, so the
 * pages follow them as they would a real one, and Abort aborts. Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.pipelines.PipelinesFixturesActivity`
 * (`--ez pipelines.open true` opens the list at once; `--es pipelines.run r-failed`
 * a run, and with `--es pipelines.node build` one of its nodes).
 */
class PipelinesFixturesActivity : ComponentActivity() {
    @Serializable private data object FixtureHomeRoute

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val open = intent.getBooleanExtra("pipelines.open", false)
        val run = intent.getStringExtra("pipelines.run")
        val node = intent.getStringExtra("pipelines.node")
        setContent {
            HappyTheme {
                val nav = rememberNavController()
                val events = remember { MutableSharedFlow<AgentEvent>(extraBufferCapacity = 64) }
                val backend = remember { FakePipelines(System.currentTimeMillis()) { type, data -> events.tryEmit(AgentEvent(null, type, data)) } }
                LaunchedEffect(Unit) { backend.play() }
                val agents = AgentNames { mapOf("a-chief" to "Happy", "a-release" to "Release bot")[it] }
                val start: Any = when {
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
                        pipelineRoutes(nav) { PagePipelines(backend, events, agents) }
                    }
                }
            }
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

    private fun node(id: String, kind: PipelineNodeKind, model: String? = null, pipeline: String? = null, leases: Set<String> = emptySet()) =
        PipelineNodeDefinition(id, kind, model, pipeline, leases)

    private fun success(from: String, to: String) = PipelineEdge(from, to, onSuccess = true)
    private fun failure(from: String, to: String) = PipelineEdge(from, to, onSuccess = false)

    private val definitions = mapOf(
        deploy.first to PipelineDefinition(
            "build",
            listOf(
                node("build", PipelineNodeKind.Code, leases = setOf("builder")),
                node("test", PipelineNodeKind.Pipeline, pipeline = tests.first),
                node("deploy", PipelineNodeKind.Code, leases = setOf("builder")),
                node("announce", PipelineNodeKind.Agent, model = "openai/gpt-6.1-terra"),
                node("triage", PipelineNodeKind.Agent, model = "anthropic/claude-sonnet-5"),
            ),
            listOf(
                success("build", "test"), success("test", "deploy"), success("deploy", "announce"),
                failure("build", "triage"), failure("test", "triage"), failure("deploy", "triage"),
            ),
        ),
        tests.first to PipelineDefinition(
            "setup",
            listOf(node("setup", PipelineNodeKind.Code), node("unit", PipelineNodeKind.Code, leases = setOf("runner")), node("lint", PipelineNodeKind.Code), node("report", PipelineNodeKind.Agent, model = "openai/gpt-6.1-sol")),
            listOf(success("setup", "unit"), success("setup", "lint"), success("unit", "report"), success("lint", "report")),
        ),
        email.first to PipelineDefinition(
            "classify",
            listOf(node("classify", PipelineNodeKind.Agent, model = "openai/gpt-6.1-sol"), node("reply", PipelineNodeKind.Agent, model = "anthropic/claude-sonnet-5")),
            listOf(success("classify", "reply")),
        ),
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
        return listOf(
            PipelineSummary(deploy.first, deploy.second, "Builds, tests and ships main.", 3, true, last(deploy.first)),
            PipelineSummary(email.first, email.second, null, 12, true, last(email.first)),
            PipelineSummary("p-nightly", "Nightly backup", null, 1, false, null),
            PipelineSummary(tests.first, tests.second, null, 7, true, last(tests.first)),
        )
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

    override suspend fun definition(pipelineId: String, version: Int): PipelineDefinition? {
        delay(200)
        return definitions[pipelineId]
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
