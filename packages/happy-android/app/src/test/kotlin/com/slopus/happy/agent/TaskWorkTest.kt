package com.slopus.happy.agent

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
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Happy Cloud's tasks' repositories and changed lines (`GET /v0/tasks/repositories`): the wire, following it, and home's rows. */
@OptIn(ExperimentalCoroutinesApi::class)
class TaskWorkTest {
    private class Server(var status: Int = 200, var text: String = ANSWER) : Transport {
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    private class Api(var answer: JsonObject? = json(ANSWER)) : TaskWorkApi {
        var reads = 0
        override suspend fun read(): JsonObject? {
            reads++
            return answer
        }
    }

    @Test
    fun repositoriesAndEachAgentsChangesReadAsTheContractWritesThem() {
        val work = TaskWork.parse(json(ANSWER))!!
        assertEquals(
            listOf(
                RepositoryMark("r1", "happy", "/v0/repositories/r1/avatar", "3OcRJYB4d3h3iIeHeEh3eIhw+j2w"),
                RepositoryMark("r2", "site"),
            ),
            work.repositories["t1"],
        )
        assertEquals("a task with no repositories", emptyList<RepositoryMark>(), work.repositories["t2"])
        // at1: 10+2 over two repositories; the failed checkout and the one not scanned add nothing.
        assertEquals(WorkspaceLineChanges("ready", 12, 4, true, 0.0), work.changes["at1"])
        assertEquals("a subtask's own checkout", WorkspaceLineChanges("ready", 5, 0, true, 0.0), work.changes["as1"])
        assertNull("not scanned yet", work.changes["as2"])
        assertTrue(work.changes["as1"]!!.visible)
        assertNull("not that shape", TaskWork.parse(json("""{"repositories":[]}""")))
    }

    @Test
    fun theRouteAndAServerWithoutIt() = runBlocking {
        val server = Server()
        val api = ClusterTaskWork(AgentClient(server, "t", cloud = true))
        assertEquals(json(ANSWER), api.read())
        assertEquals("GET /v0/tasks/repositories", server.asked.last())
        for (status in listOf(404, 501)) {
            server.status = status
            server.text = """{"error":"Not found","code":"not_found"}"""
            assertNull("$status: none", api.read())
        }
    }

    /** Read on every connect and on the events after which desktop reads it again; kept for the next start; a failed read keeps what showed. */
    @Test
    fun readOnHelloAndOnTheEventsThatChangeIt() = runTest {
        val api = Api()
        val events = MutableSharedFlow<AgentEvent>()
        val kept = mutableListOf<JsonObject>()
        val source = TaskWorkSource(api, events, { null }, { kept += it }, backgroundScope)
        runCurrent()
        assertEquals(0, api.reads)
        events.emit(AgentEvent(null, AgentEvent.HELLO, JsonObject(emptyMap())))
        runCurrent()
        assertEquals(1, api.reads)
        assertEquals(WorkspaceLineChanges("ready", 12, 4, true, 0.0), source.work.value.changes["at1"])
        assertEquals(json(ANSWER), kept.last())
        for ((index, type) in TaskWorkSource.REREAD.withIndex()) {
            events.emit(AgentEvent("c$index", type, JsonObject(emptyMap())))
            runCurrent()
            assertEquals(type, index + 2, api.reads)
        }
        events.emit(AgentEvent("c9", "agent.updated", JsonObject(emptyMap())))
        runCurrent()
        assertEquals("another event reads nothing", TaskWorkSource.REREAD.size + 1, api.reads)
    }

    @Test
    fun whatWasKeptShowsBeforeTheFirstRead() = runTest {
        val source = TaskWorkSource(Api(), MutableSharedFlow(), { json(ANSWER) }, {}, backgroundScope)
        runCurrent()
        assertEquals(2, source.work.value.repositories["t1"]?.size)
    }

    /** A task wears its repositories; a task's and a subtask's rows the lines their own agents changed. */
    @Test
    fun homesRowsWearThem() {
        val bootstrap = Wire.bootstrap(
            tasks = listOf(
                Wire.task("t1", "Fix login", Wire.agent("at1", subtasks = listOf(Wire.agent("as1", title = "Tests", subtask = true, parent = "at1")))),
                Wire.task("t2", "Notes", Wire.agent("at2")),
            ),
            memberships = listOf(Wire.membership("t1", "1"), Wire.membership("t2", "2")),
        )
        val catalog = AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))
        val feed = AgentFeed.derive(catalog, work = TaskWork.parse(json(ANSWER))!!)
        val rows = feed.conversations.associateBy { it.agentId }
        assertEquals(listOf("r1", "r2"), rows.getValue("at1").repositories.map { it.id })
        assertEquals(12L, rows.getValue("at1").lineChanges?.insertions)
        assertEquals(emptyList<RepositoryMark>(), rows.getValue("as1").repositories)
        assertEquals(5L, rows.getValue("as1").lineChanges?.insertions)
        assertEquals(emptyList<RepositoryMark>(), rows.getValue("at2").repositories)
        assertNull(rows.getValue("at2").lineChanges)
    }

    private companion object {
        fun json(text: String) = Json.parseToJsonElement(text).jsonObject

        val ANSWER = """{"tasks":[
            {"taskId":"t1","agentId":"at1","repositories":[
                {"repositoryId":"r1","name":"happy","path":"slopus/happy","host":"github.com",
                 "avatar":{"thumbhash":"3OcRJYB4d3h3iIeHeEh3eIhw+j2w"},"avatarUrl":"/v0/repositories/r1/avatar",
                 "checkouts":[
                    {"checkoutId":"c1","agentId":"at1","folder":"happy","branch":"main","status":"ready","scoped":false,"computer":null,
                     "changes":{"changedFiles":3,"insertions":10,"deletions":4}},
                    {"checkoutId":"c2","agentId":"at1","folder":"happy-2","branch":"x","status":"failed","scoped":false,"computer":null,
                     "changes":{"changedFiles":1,"insertions":100,"deletions":100}},
                    {"checkoutId":"c3","agentId":"as1","folder":"happy","branch":"y","status":"ready","scoped":true,"computer":null,
                     "changes":{"changedFiles":1,"insertions":5,"deletions":0}}]},
                {"repositoryId":"r2","name":"site","path":"slopus/site","host":"github.com","avatar":null,"avatarUrl":null,
                 "checkouts":[
                    {"checkoutId":"c4","agentId":"at1","folder":"site","branch":"main","status":"ready","scoped":false,"computer":null,
                     "changes":{"changedFiles":1,"insertions":2,"deletions":0}},
                    {"checkoutId":"c5","agentId":"as2","folder":"site","branch":"main","status":"pending","scoped":false,"computer":null,"changes":null}]}]},
            {"taskId":"t2","agentId":"at2","repositories":[]}]}"""
    }
}
