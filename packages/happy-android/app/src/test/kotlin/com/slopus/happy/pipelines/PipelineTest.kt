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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One pipeline, its versions and its runs (happy-cluster API.md, "Pipelines"), against a fake server. */
@OptIn(ExperimentalCoroutinesApi::class)
class PipelineTest {
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

    private val definition = """{"root":"build",
        "input":{"type":"object","properties":{"sha":{"type":"string","description":"ignored"},"branch":{"type":["string","null"]},"notes":{"type":"array","items":{"type":"string"}},
          "mode":{"type":"string","enum":["fast","full"]}},"required":["sha"]},
        "concurrency":{"group":"{{ input.branch }}","mode":"queue","batch":true},
        "triggers":{"agents":["a1","bot1"]},
        "permissions":{"tools":["web_fetch"],"vaults":[{"id":"v1","access":"write"},{"id":"v2","access":"read"},{"id":"v3","access":"own"}],"secrets":["S"],
          "repositories":[{"id":"happy/app","access":"read"}],"egress":{"hosts":["api.github.com"]},"compute":{"pools":["macs"],"maxLeases":2}},
        "nodes":{
          "build":{"kind":"code","source":"def main(i): pass","compute":{"acquire":[{"name":"builder","pool":"macs"},{"name":"phone","computer":"c9"},{"name":"bad"}],"pass":["builder"]},"timeoutSeconds":600,
            "output":{"type":"object","properties":{"apk":{"type":"string"}},"required":["apk"]}},
          "triage":{"kind":"agent","model":"anthropic/claude","effort":"high","instructions":"Look.","join":"any","permissions":{}},
          "deploy":{"kind":"code","source":"def main(i): pass","compute":{"use":["builder"]},"permissions":{"secrets":["PLAY"]}}},
        "edges":[{"from":"build","to":"deploy","on":"success"},{"from":"build","to":"triage","on":"failure"},{"from":"deploy","to":"triage","on":"failure"}]}"""

    private fun pipeline(id: String = "p1", definition: String = this.definition) =
        """{"pipeline":{"id":"$id","name":"Deploy","description":"Ships main.","enabled":false,"lastRun":null,
        "head":{"number":3,"digest":"ab","parent":2,"message":"Queue runs","author":{"kind":"agent","agentId":"a1","userId":"u1"},"createdAt":30,"definition":$definition}}}"""

    private val versions = """{"versions":[
        {"number":2,"digest":"b","parent":1,"message":"","author":{"kind":"user","userId":"u2"},"createdAt":20},
        {"number":3,"digest":"c","parent":2,"message":"Queue runs","author":{"kind":"agent","agentId":"a1","userId":null},"createdAt":30},
        {"number":1,"digest":"a","parent":null,"author":{"kind":"robot"},"createdAt":10},
        {"digest":"none"}]}"""

    private fun run(id: String, state: String, createdAt: Long) =
        """{"id":"$id","version":3,"state":"$state","trigger":{"kind":"agent","agentId":"a1"},"parentRunId":null,"createdAt":$createdAt,"startedAt":$createdAt,"endedAt":null}"""

    private fun event(type: String, pipelineId: String?) =
        AgentEvent(null, type, JsonObject(listOfNotNull(pipelineId?.let { "pipelineId" to JsonPrimitive(it) }).toMap()))

    @Test
    fun aPipelineReadsWithEverythingItsHeadDefines() {
        val read = ClusterPipelines.readPipeline(Json.parseToJsonElement(pipeline()))!!
        assertFalse(read.enabled)
        assertEquals("Ships main.", read.description)
        assertEquals(PipelineVersion(3, "Queue runs", PipelineAuthor("u1", "a1"), 30), read.head.version)
        val definition = read.head.definition!!
        val input = definition.input!!.schema as PipelineSchema.ObjectOf
        assertEquals(
            "fields in the schema's order; a [type, null] pair is nullable; an enum is its values",
            listOf(
                PipelineField("sha", PipelineSchema.Scalar("string", null, nullable = false), required = true),
                PipelineField("branch", PipelineSchema.Scalar("string", null, nullable = true), required = false),
                PipelineField("notes", PipelineSchema.ListOf(PipelineSchema.Scalar("string", null, false), nullable = false), required = false),
                PipelineField("mode", PipelineSchema.Scalar("string", listOf(JsonPrimitive("fast"), JsonPrimitive("full")), false), required = false),
            ),
            input.fields,
        )
        assertEquals(PipelineConcurrency(PipelineConcurrencyMode.Queue, "{{ input.branch }}", batch = true), definition.concurrency)
        assertEquals(listOf("a1", "bot1"), definition.triggerAgents)
        val ceiling = definition.permissions
        assertEquals("an access this app doesn't know is left out", listOf(PipelineGrant("v1", write = true), PipelineGrant("v2", write = false)), ceiling.vaults)
        assertEquals(listOf("api.github.com"), ceiling.egressHosts)
        assertEquals(PipelineComputeGrant(listOf("macs"), emptyList(), 2), ceiling.compute)
        val build = definition.node("build")!!
        assertEquals(
            "a lease from a pool or on a computer; one from neither is left out",
            PipelineCompute(listOf(PipelineAcquire("builder", "macs", null), PipelineAcquire("phone", null, "c9")), emptyList(), listOf("builder")),
            build.compute,
        )
        assertEquals(setOf("builder", "phone"), build.leases)
        assertEquals(600L, build.timeoutSeconds)
        assertNull("granted nothing at all", build.permissions)
        assertNull(build.input)
        val triage = definition.node("triage")!!
        assertEquals("high", triage.effort)
        assertTrue(triage.joinAny)
        assertTrue("an empty set is granted nothing too", triage.permissions!!.none)
        assertEquals(PipelineNodeDefinition.DEFAULT_TIMEOUT_SECONDS, triage.timeoutSeconds)
        assertEquals("Look.", triage.instructions)
        assertEquals(listOf("PLAY"), definition.node("deploy")!!.permissions!!.secrets)
        assertEquals("the nodes no success edge leaves", listOf("triage", "deploy"), definition.ends.map { it.id })
        assertEquals(listOf("triage"), definition.next("build", onSuccess = false))
    }

    @Test
    fun aTypeThisAppCantReadRefusesTheVersionNotThePipeline() {
        val unknown = definition.replace(""""type":"array","items":{"type":"string"}""", """"type":"date"""")
        val read = ClusterPipelines.readPipeline(Json.parseToJsonElement(pipeline(definition = unknown)))!!
        assertEquals("Deploy", read.name)
        assertNull(read.head.definition)
        val untyped = ClusterPipelines.readDefinition(Json.parseToJsonElement("""{"root":"a","nodes":{"a":{"kind":"code","source":""}},"edges":[]}"""))!!
        assertNull("a definition without an input type has none", untyped.input)
        assertEquals(PipelineConcurrency(), untyped.concurrency)
        assertTrue(untyped.permissions.none)
    }

    @Test
    fun versionsReadNewestFirstWithTheirAuthors() {
        val read = ClusterPipelines.readVersions(Json.parseToJsonElement(versions))
        assertEquals("a version without its number is left out", listOf(3, 2, 1), read.map { it.number })
        assertEquals(PipelineAuthor(null, "a1"), read[0].author)
        assertEquals(PipelineAuthor("u2", null), read[1].author)
        assertNull("an author this app doesn't know", read[2].author)
        assertEquals("", read[2].message)
    }

    @Test
    fun thePageFollowsItsOwnPipelinesEvents() = runTest {
        val server = Server(
            mapOf(
                "GET /v0/pipelines/p1" to listOf(200 to pipeline()),
                "GET /v0/pipelines/p1/versions" to listOf(200 to versions),
                "GET /v0/pipelines/p1/runs" to listOf(
                    200 to """{"runs":[${run("r2", "running", 20)},${run("r1", "failed", 10)}],"nextCursor":"r1"}""",
                    200 to """{"runs":[${run("r3", "queued", 30)},${run("r2", "succeeded", 20)}],"nextCursor":"r2"}""",
                ),
                "GET /v0/pipelines/p1/runs?cursor=r1" to listOf(200 to """{"runs":[${run("r0", "succeeded", 5)}],"nextCursor":null}"""),
            ),
        )
        val events = MutableSharedFlow<AgentEvent>()
        val source = PipelineSource(backend(server), "p1", "Deploy (hint)", events, backgroundScope)
        assertEquals("the name the opener gave, until the server says", "Deploy (hint)", source.state.value.name)
        runCurrent()
        var state = source.state.value
        assertEquals("Deploy", state.name)
        assertEquals(listOf(3, 2, 1), state.versions.map { it.number })
        assertEquals(listOf("r2", "r1"), state.runs.entries.map { it.id })
        assertEquals("the rows carry the pipeline's name", "Deploy", state.runs.entries[0].pipelineName)
        source.more()
        runCurrent()
        assertEquals(listOf("r2", "r1", "r0"), source.state.value.runs.entries.map { it.id })
        events.emit(event(PipelinesSource.PIPELINE_UPDATED, "p2"))
        events.emit(event(PipelinesSource.RUN_UPDATED, "p2"))
        runCurrent()
        assertEquals("another pipeline's events are left alone", 1, server.asked.count { it == "GET /v0/pipelines/p1" })
        assertEquals(1, server.asked.count { it == "GET /v0/pipelines/p1/runs" })
        events.emit(event(PipelinesSource.RUN_UPDATED, "p1"))
        runCurrent()
        state = source.state.value
        assertEquals("a run's change reads its runs, not the pipeline", 1, server.asked.count { it == "GET /v0/pipelines/p1" })
        assertEquals("the older runs read stay under the fresh page", listOf("r3", "r2", "r1", "r0"), state.runs.entries.map { it.id })
        events.emit(event(PipelinesSource.PIPELINE_UPDATED, null))
        runCurrent()
        assertEquals("an event naming no pipeline is about this one", 2, server.asked.count { it == "GET /v0/pipelines/p1" })
        assertEquals(2, server.asked.count { it == "GET /v0/pipelines/p1/versions" })
    }

    @Test
    fun anArchivedPipelineKeepsItsRuns() = runTest {
        val server = Server(mapOf("GET /v0/pipelines/p1/runs" to listOf(200 to """{"runs":[${run("r1", "succeeded", 10)}],"nextCursor":null}""")))
        val source = PipelineSource(backend(server), "p1", null, MutableSharedFlow(), backgroundScope)
        runCurrent()
        val state = source.state.value
        assertTrue(state.missing)
        assertFalse(state.loading)
        assertNull(state.pipeline)
        assertEquals(listOf("r1"), state.runs.entries.map { it.id })
        assertTrue("its runs are listed, just not its page", state.runs.listed)
    }

    @Test
    fun aVersionIsReadOnceAndItsChildPipelinesNamed() = runTest {
        val child = """{"root":"t","input":{"type":"object","properties":{}},"nodes":{"t":{"kind":"pipeline","pipeline":"p-tests"}},"edges":[]}"""
        val server = Server(
            mapOf(
                "GET /v0/pipelines/p1/versions/2" to listOf(503 to """{"error":"Busy"}""", 200 to """{"version":{"number":2,"message":"Old","author":{"kind":"user","userId":"u2"},"createdAt":20,"definition":$child}}"""),
                "GET /v0/pipelines/p-tests" to listOf(200 to pipeline("p-tests").replace("\"Deploy\"", "\"Run tests\"")),
            ),
        )
        val source = PipelineVersionSource(backend(server), "p1", 2, backgroundScope)
        runCurrent()
        assertTrue(source.state.value.failed)
        source.refresh()
        runCurrent()
        val state = source.state.value
        assertNotNull(state.version!!.definition)
        assertEquals(mapOf("p-tests" to "Run tests"), state.pipelineNames)
        source.refresh()
        runCurrent()
        assertEquals("a version never changes: read once it answered", 2, server.asked.count { it == "GET /v0/pipelines/p1/versions/2" })
    }
}
