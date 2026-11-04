package com.slopus.happy.todos

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.FakeAgent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TodoRoutesTest {
    private data class Request(val method: String, val path: String, val body: JsonObject?, val headers: Map<String, String>)

    private class Daemon : Transport by FakeAgent() {
        val requests = ArrayList<Request>()
        var reply: (Request) -> String = { """{"todo":{"id":"t1","surfaceId":"s1","text":"Milk","status":"active","version":"v2"}}""" }

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            val request = Request(method, path, body?.let { Json.parseToJsonElement(it.decodeToString()).jsonObject }, headers)
            requests += request
            return TransportResponse(200, mapOf("content-type" to "application/json"), reply(request).toByteArray())
        }
    }

    @Test
    fun mutationsCarryTheirRetryIdAndCurrentVersion() = runBlocking {
        val daemon = Daemon()
        val routes = AgentTodoRoutes(AgentClient(daemon, "test"))
        assertEquals("Milk", routes.create("s1", "t1", "Milk", "i1").text)
        routes.update("s1", "t1", "Oat milk", null, "v2", "i2")
        routes.delete("s1", "t1", "v3", "i3")
        routes.reorder("s1", "t1", null, "v4", "i4")
        assertEquals(listOf(
            "POST /v0/surfaces/todo/s1", "PATCH /v0/surfaces/todo/s1/t1",
            "DELETE /v0/surfaces/todo/s1/t1", "POST /v0/surfaces/todo/s1/t1/reorder",
        ), daemon.requests.map { "${it.method} ${it.path}" })
        assertEquals(listOf("i1", "i2", "i3", "i4"), daemon.requests.map { it.body?.get("mutationId").toString().trim('"') })
        assertEquals(listOf(null, "v2", "v3", "v4"), daemon.requests.map { it.headers["If-Match"] })
        assertEquals("""{"id":"t1","text":"Milk","mutationId":"i1"}""", daemon.requests[0].body.toString())
        assertNull(daemon.requests[1].body?.get("status"))
        assertEquals("null", daemon.requests[3].body?.get("afterId").toString())
    }

    @Test
    fun historyFollowsPagesAndEscapesTheCursor() = runBlocking {
        val daemon = Daemon()
        daemon.reply = { request ->
            val first = request.path.endsWith("?limit=200")
            val version = if (first) "v1" else "v2"
            """{"versions":[{"todo":{"id":"t1","surfaceId":"s1","text":"Milk","status":"active","version":"$version"},"source":"api"}],"nextAfterVersion":${if (first) "\"v 1\"" else "null"}}"""
        }
        val revisions = AgentTodoRoutes(AgentClient(daemon, "test")).versions("s1", "t1")
        assertEquals(listOf("v1", "v2"), revisions.map { it.todo.version })
        assertEquals(listOf("/v0/surfaces/todo/s1/t1/versions?limit=200", "/v0/surfaces/todo/s1/t1/versions?limit=200&afterVersion=v%201"), daemon.requests.map { it.path })
    }

    @Test
    fun authorsAreResolvedInBatchesOfAtMostOneHundred() = runBlocking {
        val daemon = Daemon()
        daemon.reply = { request ->
            val users = request.path.substringAfter("?ids=").split(',').joinToString(",") { """{"id":"$it","name":"Person $it"}""" }
            """{"users":[$users]}"""
        }
        val ids = (1..101).map { "u$it" }
        val names = AgentTodoRoutes(AgentClient(daemon, "test")).names(ids + "u1")
        assertEquals(101, names.size)
        assertEquals("Person u101", names["u101"])
        assertEquals(listOf(100, 1), daemon.requests.map { it.path.substringAfter("?ids=").split(',').size })
    }
}