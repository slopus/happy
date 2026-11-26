package com.slopus.happy.pipelines

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A Happy Cloud server's pipelines (happy-cluster API.md, "Pipelines"), against a fake server. */
@OptIn(ExperimentalCoroutinesApi::class)
class PipelinesTest {
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

    // As production answers: summaries by name, an archived pipeline's runs still listed.
    private val pipelines = """{"pipelines":[
        {"id":"p2","name":"triage","description":"","enabled":false,"head":{"number":4,"digest":"ab","message":"m","createdAt":1},
         "lastRun":{"id":"r9","state":"failed","createdAt":100,"endedAt":160},"createdBy":"u1","createdAt":1,"updatedAt":2},
        {"id":"p1","name":"Deploy","description":"Ships main.","enabled":true,"head":{"number":2},"lastRun":null},
        {"id":"p3","name":"No head"}]}"""

    private fun run(id: String, state: String, createdAt: Long, extra: String = "") =
        """{"id":"$id","version":3,"state":"$state","trigger":{"kind":"agent","agentId":"a1"},"parentRunId":null,"createdAt":$createdAt,"startedAt":${createdAt + 1},"endedAt":null,"pipelineId":"p1","pipelineName":"Deploy","pipelineArchived":false$extra}"""

    @Test
    fun pipelinesReadByNameAndWhatIsntOneIsLeftOut() = runBlocking {
        val read = backend(Server(mapOf("GET /v0/pipelines" to listOf(200 to pipelines)))).pipelines()
        assertEquals(
            listOf(
                PipelineSummary("p1", "Deploy", "Ships main.", 2, true, null),
                PipelineSummary("p2", "triage", null, 4, false, PipelineRunSummary("r9", PipelineRunState.Failed, 100, 160)),
            ),
            read,
        )
    }

    @Test
    fun runsReadAsProductionSendsThem() {
        val page = ClusterPipelines.runList(
            Json.parseToJsonElement(
                """{"runs":[
                {"id":"r1","version":1,"state":"succeeded","trigger":{"kind":"agent","agentId":null},"parentRunId":null,"createdAt":5,"startedAt":6,"endedAt":9,"pipelineId":"p1","pipelineName":"Deploy","pipelineArchived":false},
                {"id":"r2","version":2,"state":"running","trigger":{"kind":"pipeline","runId":"r1","nodeId":"test"},"parentRunId":"r1","createdAt":4,"startedAt":null,"endedAt":null,"pipelineId":"p9","pipelineArchived":true},
                {"id":"r3","version":1,"state":"paused","pipelineId":"p1"},
                {"id":"r4","version":1,"state":"queued","trigger":{"kind":"cron"},"createdAt":3,"pipelineId":"p1","pipelineName":""}],
                "nextCursor":"r4"}""",
            ),
        )
        assertEquals(listOf("r1", "r2", "r4"), page.runs.map { it.id })
        // An agent the server no longer names is still an agent's run.
        assertEquals(PipelineRunTrigger.Agent(null), page.runs[0].run.trigger)
        assertEquals(PipelineRunTrigger.Pipeline("r1", "test"), page.runs[1].run.trigger)
        assertEquals("r1", page.runs[1].run.parentRunId)
        assertTrue(page.runs[1].pipelineArchived)
        assertEquals("a pipeline without a name goes by its ID", "p9", page.runs[1].pipelineName)
        assertNull("a trigger this app doesn't know", page.runs[2].run.trigger)
        assertEquals("p1", page.runs[2].pipelineName)
        assertEquals("r4", page.nextCursor)
    }

    @Test
    fun aServerWithoutTheRunsListSaysSoAndIsntAskedAgain() = runTest {
        val server = Server(mapOf("GET /v0/pipelines" to listOf(200 to pipelines)))
        val events = MutableSharedFlow<AgentEvent>()
        val source = PipelinesSource(backend(server), events, backgroundScope)
        runCurrent()
        assertFalse(source.state.value.runs.listed)
        assertFalse(source.state.value.runs.loading)
        assertEquals(2, source.state.value.pipelines.size)
        events.emit(AgentEvent(null, PipelinesSource.RUN_UPDATED, JsonObject(emptyMap())))
        runCurrent()
        assertEquals(1, server.asked.count { it == "GET /v0/pipeline-runs" })
        assertEquals(2, server.asked.count { it == "GET /v0/pipelines" })
    }

    @Test
    fun runEventsReadTheNewestPageAgainOverTheOlderOnesPaged() = runTest {
        val server = Server(
            mapOf(
                "GET /v0/pipelines" to listOf(200 to pipelines),
                "GET /v0/pipeline-runs" to listOf(
                    200 to """{"runs":[${run("r3", "running", 30)},${run("r2", "running", 20)}],"nextCursor":"r2"}""",
                    // r4 arrives, r3 ended, r2 slipped to the next page.
                    200 to """{"runs":[${run("r4", "queued", 40)},${run("r3", "succeeded", 30)}],"nextCursor":"r3"}""",
                ),
                "GET /v0/pipeline-runs?cursor=r2" to listOf(200 to """{"runs":[${run("r2", "running", 20)},${run("r1", "failed", 10)}],"nextCursor":null}"""),
            ),
        )
        val events = MutableSharedFlow<AgentEvent>()
        val source = PipelinesSource(backend(server), events, backgroundScope)
        runCurrent()
        assertEquals(listOf("r3", "r2"), source.state.value.runs.entries.map { it.id })
        assertTrue(source.state.value.live)
        source.more()
        runCurrent()
        assertEquals(listOf("r3", "r2", "r1"), source.state.value.runs.entries.map { it.id })
        assertNull(source.state.value.runs.nextCursor)
        events.emit(AgentEvent(null, PipelinesSource.RUN_UPDATED, JsonObject(emptyMap())))
        runCurrent()
        val runs = source.state.value.runs
        assertEquals("the older runs read stay under the fresh page", listOf("r4", "r3", "r2", "r1"), runs.entries.map { it.id })
        assertEquals(PipelineRunState.Succeeded, runs.entries[1].run.state)
        assertNull("paged to the end, the cursor stays there", runs.nextCursor)
        assertEquals("the run's change is the pipeline's last run too", 2, server.asked.count { it == "GET /v0/pipelines" })
    }

    @Test
    fun aFailedReadKeepsWhatWasShownAndSaysSo() = runTest {
        val server = Server(
            mapOf(
                "GET /v0/pipelines" to listOf(200 to pipelines, 503 to """{"error":"Busy","code":"unavailable"}"""),
                "GET /v0/pipeline-runs" to listOf(200 to """{"runs":[${run("r1", "running", 10)}],"nextCursor":null}""", 503 to """{"error":"Busy"}"""),
            ),
        )
        val events = MutableSharedFlow<AgentEvent>()
        val source = PipelinesSource(backend(server), events, backgroundScope)
        runCurrent()
        events.emit(AgentEvent(null, AgentEvent.HELLO, JsonObject(emptyMap())))
        runCurrent()
        val state = source.state.value
        assertTrue(state.failed)
        assertEquals(2, state.pipelines.size)
        assertTrue(state.runs.failed)
        assertEquals(listOf("r1"), state.runs.entries.map { it.id })
    }

    /**
     * Pipelines turned off for the account: a route's `403 feature_not_installed`
     * tells the session and is no failure; the page is leaving, and what showed stays.
     */
    @Test
    fun aRouteRefusedAsTurnedOffTellsTheSessionAndShowsNoError() = runTest {
        val off = """{"error":"Pipelines are turned off for your account. Turn them on in your account settings to use them again.","code":"feature_not_installed","feature":"pipelines"}"""
        val server = Server(
            mapOf(
                "GET /v0/pipelines" to listOf(200 to pipelines, 403 to off),
                "GET /v0/pipeline-runs" to listOf(200 to """{"runs":[${run("r1", "running", 10)}],"nextCursor":null}""", 403 to off),
                "POST /v0/pipeline-runs/r1/abort" to listOf(403 to off),
            ),
        )
        var told = 0
        val backend = ClusterPipelines(AgentClient(server, "t", cloud = true)) { told++ }
        val events = MutableSharedFlow<AgentEvent>()
        val source = PipelinesSource(backend, events, backgroundScope)
        runCurrent()
        events.emit(AgentEvent(null, AgentEvent.HELLO, JsonObject(emptyMap())))
        runCurrent()
        assertEquals(2, told)
        val state = source.state.value
        assertFalse(state.failed)
        assertFalse(state.runs.failed)
        assertEquals(2, state.pipelines.size)
        assertEquals(listOf("r1"), state.runs.entries.map { it.id })
        try {
            backend.abort("r1")
            org.junit.Assert.fail("refused")
        } catch (_: PipelinesTurnedOff) {
        }
        assertEquals(3, told)
        // A role's refusal is still a refusal to say.
        val role = ClusterPipelines(AgentClient(Server(mapOf("GET /v0/pipelines" to listOf(403 to """{"error":"This needs the pipelines.read permission.","code":"forbidden"}"""))), "t", cloud = true)) { told++ }
        try {
            role.pipelines()
            org.junit.Assert.fail("refused")
        } catch (e: com.slopus.happy.agent.AgentApiException) {
            assertEquals("forbidden", e.code)
        }
        assertEquals(3, told)
    }
}
