package com.slopus.happy.pipelines

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One run, its version's graph and a node's log (happy-cluster API.md, "Runs" and "Node log"), against a fake server. */
@OptIn(ExperimentalCoroutinesApi::class)
class PipelineRunTest {
    /** Answers by "METHOD path", in turn where a route lists several; records each request. */
    private class Server(answers: Map<String, List<Pair<Int, String>>>) : Transport {
        private val queues = answers.mapValues { ArrayDeque(it.value) }.toMutableMap()
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            val queue = queues["$method $path"]
            val (status, text) = (if (queue != null && queue.size > 1) queue.removeFirst() else queue?.firstOrNull()) ?: (404 to """{"error":"Not found","code":"not_found"}""")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    private fun backend(server: Server) = ClusterPipelines(AgentClient(server, "t", cloud = true))

    private fun run(state: String, nodes: String = "[]") =
        """{"run":{"id":"r1","version":3,"state":"$state","trigger":{"kind":"agent","agentId":"a1"},"parentRunId":null,"createdAt":1,"startedAt":2,"endedAt":null,
        "pipelineId":"p1","rootRunId":"r1","group":null,"input":{"sha":"4f2c"},"result":null,"nodes":$nodes,"leases":[],"childRunIds":[]}}"""

    private val definition = """{"version":{"number":3,"definition":{"root":"build","input":{"type":"object","properties":{}},
        "nodes":{"notify":{"kind":"agent","model":"openai/gpt-6.1-sol","instructions":"Say so."},"deploy":{"kind":"code","source":"def main(i): pass","compute":{"use":["builder"]}},
        "build":{"kind":"code","source":"def main(i): pass","compute":{"acquire":[{"name":"builder","pool":"p"}],"pass":["builder"]}},"test":{"kind":"pipeline","pipeline":"p-tests"}},
        "edges":[{"from":"build","to":"test","on":"success"},{"from":"test","to":"deploy","on":"success"},{"from":"build","to":"notify","on":"failure"},{"from":"deploy","to":"notify","on":"success"}]}}}"""

    private fun event(type: String, runId: String?, nodeId: String? = null) = AgentEvent(
        null, type,
        JsonObject(listOfNotNull(runId?.let { "runId" to JsonPrimitive(it) }, nodeId?.let { "nodeId" to JsonPrimitive(it) }).toMap()),
    )

    @Test
    fun aRunReadsAsProductionSendsIt() {
        val run = ClusterPipelines.readRun(
            Json.parseToJsonElement(
                """{"run":{"id":"r2","version":7,"state":"failed","trigger":{"kind":"pipeline","runId":"r1","nodeId":"test"},"parentRunId":"r1","createdAt":10,"startedAt":11,"endedAt":90,
                "pipelineId":"p-tests","group":"main","input":null,"result":{"outputs":{"report":{"ok":false}}},
                "nodes":[
                  {"nodeId":"unit","kind":"code","state":"failed","status":{"text":"tests","progress":1.7,"at":40},"statuses":[{"text":"tests","progress":1.7,"at":40}],"input":{"sha":"4f2c"},"output":null,
                   "failure":{"code":"exception","message":"Traceback\nValueError: no"},"agentId":null,"childRunId":null,"startedAt":12,"endedAt":50},
                  {"nodeId":"report","kind":"agent","state":"succeeded","status":null,"statuses":[],"failure":null,"agentId":"ag1","startedAt":51,"endedAt":80,
                   "usage":{"openai":{"openai/gpt-6.1-sol":{"input":1200,"output":80,"cacheRead":512,"cacheWrite":0,"reasoning":40,"costUsd":0.01}},"anthropic":{"anthropic/claude":{"input":10,"output":-3}}}},
                  {"nodeId":"odd","kind":"shell","state":"running"}],
                "leases":[{"name":"runner","computerId":"c1","holders":["unit"],"releasedAt":null},{"name":"broken"}],"childRunIds":["r3"]}}""",
            ),
        )!!
        assertEquals("a run without its root is its own", "r2", run.rootRunId)
        assertEquals(PipelineRunTrigger.Pipeline("r1", "test"), run.entry.trigger)
        assertEquals("main", run.group)
        assertNull("JSON null is no input", run.input)
        assertEquals(Json.parseToJsonElement("""{"report":{"ok":false}}"""), run.outputs)
        assertEquals("a node of a kind this app doesn't know is left out", listOf("unit", "report"), run.nodes.map { it.nodeId })
        val unit = run.nodes[0]
        assertEquals(PipelineFailure("exception", "Traceback\nValueError: no"), unit.failure)
        assertEquals("progress is held to 0..1", 1f, unit.status!!.progress)
        assertNull(unit.usage)
        val usage = run.nodes[1].usage!!
        assertEquals("by provider, then model", listOf("anthropic/claude", "openai/gpt-6.1-sol"), usage.map { it.model })
        assertEquals("a negative count reads as none, an unpriced model as null", 0L, usage[0].output)
        assertNull(usage[0].costUsd)
        assertEquals(0.01, usage[1].costUsd!!, 0.0)
        assertEquals(listOf(PipelineLease("runner", "c1", listOf("unit"), null)), run.leases)
        assertEquals(listOf("r3"), run.childIds)
    }

    @Test
    fun theNodesGoInGraphOrder() {
        val read = ClusterPipelines.readDefinition(Json.parseToJsonElement(definition).let { (it as JsonObject)["version"]!!.let { v -> (v as JsonObject)["definition"] } })!!
        assertEquals(setOf("builder"), read.node("build")!!.leases)
        assertEquals("p-tests", read.node("test")!!.pipelineId)
        assertEquals("openai/gpt-6.1-sol", read.node("notify")!!.model)
        // The root leads though listed late; notify follows deploy's longest path; a node the definition lacks comes last.
        val ran = listOf(nodeRun("zeta"), nodeRun("build"))
        assertEquals(listOf("build", "test", "deploy", "notify", "zeta"), pipelineNodeOrder(read, ran))
        // Without the graph, the order they started in.
        assertEquals(listOf("build", "zeta"), pipelineNodeOrder(null, listOf(nodeRun("zeta", started = 5), nodeRun("build", started = 1))))
        assertNull("a node this app can't read refuses the whole graph", ClusterPipelines.readDefinition(Json.parseToJsonElement("""{"root":"a","nodes":{"a":{"kind":"shell"}},"edges":[]}""")))
    }

    private fun nodeRun(id: String, started: Long? = null) =
        PipelineNodeRun(id, PipelineNodeKind.Code, PipelineNodeState.Succeeded, null, emptyList(), null, null, null, null, null, started, null, null)

    @Test
    fun aLogReadsEveryKindAndARewrittenCommandReplacesItsCopy() {
        val first = ClusterPipelines.logPage(
            Json.parseToJsonElement(
                """{"entries":[
                {"seq":1,"at":10,"kind":"output","stream":"stderr","text":"oops\n"},
                {"seq":2,"at":11,"kind":"command","id":"sh-1","command":"make","cwd":null,"lease":"builder","state":"running","exitCode":null,"durationMs":null,"output":"cc …","outputTruncated":false},
                {"seq":3,"at":12,"kind":"tool","id":"fetch-1","name":"fetch","summary":"https://a.dev","state":"error","durationMs":30,"error":"404"},
                {"seq":4,"at":13,"kind":"message","text":"**done**"},
                {"seq":5,"at":14,"kind":"status","text":"half","progress":0.5},
                {"seq":6,"at":15,"kind":"thought","text":"?"}],"nextAfter":6,"dropped":0,"changed":[]}""",
            ),
            after = 0,
        )
        assertEquals("a kind this app doesn't know is left out", listOf(1L, 2L, 3L, 4L, 5L), first.entries.map { it.seq })
        assertTrue((first.entries[0] as PipelineLogEntry.Output).stderr)
        assertEquals("404", (first.entries[2] as PipelineLogEntry.Tool).error)
        val (entries, watched) = pipelineLogMerge(emptyList(), emptySet(), first)
        assertEquals("a command first read running was watched", setOf(2L), watched)
        val next = ClusterPipelines.logPage(
            Json.parseToJsonElement(
                """{"entries":[{"seq":7,"at":20,"kind":"output","stream":"stdout","text":"ok"}],"nextAfter":7,"dropped":2,
                "changed":[{"seq":2,"at":11,"kind":"command","id":"sh-1","command":"make","state":"exited","exitCode":2,"durationMs":900,"output":"cc …\nerror","outputTruncated":true}]}""",
            ),
            after = 6,
        )
        assertEquals(2, next.dropped)
        val (merged, stillWatched) = pipelineLogMerge(entries, watched, next)
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L, 7L), merged.map { it.seq })
        val command = merged[1] as PipelineLogEntry.Command
        assertEquals(2, command.exitCode)
        assertTrue(command.failed)
        assertTrue(command.outputTruncated)
        assertEquals(setOf(2L), stillWatched)
    }

    @Test
    fun abortAsksTheServerAndTheRunReadsAbortedOnlyWhenItSaysSo() = runTest {
        val server = Server(
            mapOf(
                "GET /v0/pipeline-runs/r1" to listOf(200 to run("running"), 200 to run("aborted")),
                "GET /v0/pipelines/p1" to listOf(200 to """{"pipeline":{"id":"p1","name":"Deploy"}}"""),
                "GET /v0/pipelines/p1/versions/3" to listOf(200 to definition),
                "POST /v0/pipeline-runs/r1/abort" to listOf(200 to run("aborted")),
            ),
        )
        val source = PipelineRunSource(backend(server), "r1", "Old name", MutableSharedFlow(), backgroundScope)
        assertEquals("the opening page's name shows until the server's", "Old name", source.state.value.pipelineName)
        runCurrent()
        assertEquals("Deploy", source.state.value.pipelineName)
        assertEquals("in the order the definition lists them", listOf("notify", "deploy", "build", "test"), source.state.value.definition!!.nodes.map { it.id })
        source.abort()
        assertEquals(PipelineAbort.Sending, source.state.value.abort)
        assertEquals("nothing is set aborted before the server says", PipelineRunState.Running, source.state.value.run!!.state)
        runCurrent()
        assertEquals(PipelineRunState.Aborted, source.state.value.run!!.state)
        assertEquals(PipelineAbort.Idle, source.state.value.abort)
        source.abort()
        runCurrent()
        assertEquals("an ended run isn't aborted again", 1, server.asked.count { it == "POST /v0/pipeline-runs/r1/abort" })
        assertEquals("the graph is read once", 1, server.asked.count { it == "GET /v0/pipelines/p1/versions/3" })
    }

    @Test
    fun aRefusedAbortSaysWhyAndLeavesTheRunAsItIs() = runTest {
        val server = Server(
            mapOf(
                "GET /v0/pipeline-runs/r1" to listOf(200 to run("running")),
                "POST /v0/pipeline-runs/r1/abort" to listOf(403 to """{"error":"Your role can't abort runs","code":"forbidden"}"""),
            ),
        )
        val source = PipelineRunSource(backend(server), "r1", null, MutableSharedFlow(), backgroundScope)
        runCurrent()
        assertNull("an archived pipeline (404) goes by its ID", source.state.value.pipelineName)
        source.abort()
        runCurrent()
        assertEquals(PipelineAbort.Failed("Your role can't abort runs"), source.state.value.abort)
        assertEquals(PipelineRunState.Running, source.state.value.run!!.state)
    }

    @Test
    fun aRunPageReadsAgainForItsOwnEventsAndAMissingRunSaysSo() = runTest {
        val server = Server(mapOf("GET /v0/pipeline-runs/r1" to listOf(200 to run("running"))))
        val events = MutableSharedFlow<AgentEvent>()
        val source = PipelineRunSource(backend(server), "r1", null, events, backgroundScope)
        runCurrent()
        events.emit(event(PipelinesSource.NODE_UPDATED, "r9"))
        runCurrent()
        assertEquals("another run's event isn't this page's", 1, server.asked.count { it == "GET /v0/pipeline-runs/r1" })
        events.emit(event(PipelinesSource.NODE_UPDATED, "r1", "build"))
        runCurrent()
        assertEquals(2, server.asked.count { it == "GET /v0/pipeline-runs/r1" })
        val missing = PipelineRunSource(backend(server), "r-gone", null, events, backgroundScope)
        runCurrent()
        assertTrue(missing.state.value.missing)
        assertFalse(missing.state.value.loading)
    }

    @Test
    fun aNodeLogFollowsItsOwnEventsAndANodeNotStartedHasNone() = runTest {
        val log = "/v0/pipeline-runs/r1/nodes/build/log"
        val server = Server(
            mapOf(
                "GET $log?after=0&limit=500" to listOf(404 to """{"error":"Not found"}""", 200 to """{"entries":[{"seq":1,"at":1,"kind":"output","stream":"stdout","text":"hi"}],"nextAfter":1,"dropped":0,"changed":[]}"""),
                "GET $log?after=1&limit=500" to listOf(200 to """{"entries":[],"nextAfter":1,"dropped":0,"changed":[]}"""),
            ),
        )
        val events = MutableSharedFlow<AgentEvent>()
        val source = PipelineNodeLogSource(backend(server), "r1", "build", events, backgroundScope)
        runCurrent()
        assertFalse(source.state.value.loading)
        assertTrue(source.state.value.entries.isEmpty())
        events.emit(event(PipelinesSource.NODE_LOG, "r1", "deploy"))
        runCurrent()
        assertEquals("another node's log isn't read", 1, server.asked.size)
        events.emit(event(PipelinesSource.NODE_LOG, "r1", "build"))
        runCurrent()
        assertEquals(listOf(1L), source.state.value.entries.map { it.seq })
        events.emit(event(PipelinesSource.NODE_LOG, "r1", "build"))
        runCurrent()
        assertEquals("only what came after is asked for", "GET $log?after=1&limit=500", server.asked.last())
    }
}
