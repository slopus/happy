package com.slopus.happy.search

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.FakeAgent
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A daemon answering `POST /v0/search` with [reply], or with 404 as an older one does. */
private class SearchDaemon(private val reply: String? = null) : Transport by FakeAgent() {
    val paths = ArrayList<String>()
    val bodies = ArrayList<String?>()

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
        paths += "$method $path"
        bodies += body?.decodeToString()
        val text = reply ?: return TransportResponse(404, mapOf("content-type" to "application/json"), """{"error":"Not found","code":"not_found"}""".toByteArray())
        return TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
    }
}

/**
 * Search's wire and fusion (happy-agent API.md, "Search").
 * `search/searchFusion.fixtures.json` is the client package's own test
 * vectors, copied unchanged from happy-agent
 * `packages/happy-agent-client/fixtures/searchFusion.fixtures.json` at
 * c67719baf (`@slopus/happy-agent-client@0.0.158`), so the phone fuses as
 * desktop and iOS do.
 */
class SearchTest {
    @Test
    fun fusionPassesTheClientPackagesVectors() {
        val text = requireNotNull(javaClass.getResource("/search/searchFusion.fixtures.json")) { "missing fixtures" }.readText()
        val fixtures = Json.parseToJsonElement(text).jsonObject
        val k = fixtures.getValue("k").jsonPrimitive.int
        val cases = fixtures.getValue("cases").jsonArray
        assertEquals(8, cases.size)
        for (case in cases.map { it.jsonObject }) {
            val name = case.getValue("name").jsonPrimitive.content
            val remote = case.getValue("remote").jsonArray.map { it.jsonObject.getValue("key").jsonPrimitive.content to it.jsonObject.getValue("rank").jsonPrimitive.int }
            val local = case.getValue("local").jsonArray.map { it.jsonObject.getValue("key").jsonPrimitive.content }
            val expected = case.getValue("expected").jsonArray.map { it.jsonObject.getValue("key").jsonPrimitive.content to it.jsonObject.getValue("from").jsonPrimitive.content }
            val fused = SearchFusion.fuse(remote, local, { it.first }, { it.second }, { it }, k)
            assertEquals(name, expected, fused.map { it.key to if (it.remote != null) "remote" else "local" })
        }
    }

    @Test
    fun theDaemonsResultsAreReadByTheirTypeAndAnUnknownOneIsLeftOut() = runBlocking {
        val daemon = SearchDaemon(
            """
            {"results":[
              {"type":"vault_file","key":"vault_file:f1","rank":1,"surfaceId":"v1","fileId":"f1","name":"Launch plan.md","path":"/Docs/Launch plan.md","kind":"file","match":"content","innerPath":null,"line":4,"snippet":"The launch moves to Friday"},
              {"type":"hologram","key":"hologram:h1","rank":2,"hologramId":"h1"},
              {"type":"todo","key":"todo:t1","rank":3,"surfaceId":"s1","todoId":"t1","text":"Book the launch venue","status":"active"},
              {"type":"agent","key":"agent:a1","rank":4,"agentId":"a1","title":"Launch","kind":"task","archived":false,"workspaceId":"w1","projectId":"p1","mood":"curious"},
              {"type":"agent","key":"agent:a2","rank":5,"agentId":"a2","title":"Launch bot","kind":"bot","archived":false,"workspaceId":null,"projectId":null},
              {"type":"calendar_event","key":"calendar_event:e1","rank":6,"surfaceId":"c1","eventId":"e1","title":"Launch party","allDay":true,"start":1767225600000,"match":"content","snippet":"Bring the launch banner"},
              {"type":"message","key":"message:m1","rank":7,"agentId":"a1","messageId":"m1","role":"user","snippet":"when is the launch?","createdAt":1767225600000,"workspaceId":"w1","projectId":"p1"},
              {"type":"user","key":"user:u1","rank":8,"userId":"u1","name":"Launch Lee"},
              {"type":"skill","key":"skill:k1","rank":9,"skillId":"k1","name":"launch-check","description":"Checks a launch"}
            ],"truncated":true,"partial":true}
            """.trimIndent(),
        )
        val answer = SearchClient(AgentClient(daemon, "t")).search("  café & launch  ")!!
        assertEquals("café & launch", answer.query)
        // The query in a JSON body, never the URL.
        assertEquals("POST /v0/search", daemon.paths.single())
        assertEquals(Json.parseToJsonElement("""{"q":"café & launch","limit":20}"""), Json.parseToJsonElement(daemon.bodies.single()!!))
        // People and skills have no page on the phone, so they're left out with the type it doesn't know.
        assertEquals(listOf("vault_file:f1", "todo:t1", "agent:a1", "agent:a2", "calendar_event:e1", "message:m1"), answer.hits.map { it.key })
        // Each keeps the rank the daemon gave it in its whole list.
        assertEquals(listOf(1, 3, 4, 5, 6, 7), answer.hits.map { it.rank })
        val file = answer.hits.first() as SearchHit.VaultFile
        assertEquals(4, file.line)
        assertEquals("The launch moves to Friday", file.snippet)
        // A field it doesn't know ("mood") left out; where the conversation is, or null for none.
        val task = answer.hits[2] as SearchHit.Agent
        assertEquals(Triple("task", "w1", "p1"), Triple(task.kind, task.workspaceId, task.projectId))
        val bot = answer.hits[3] as SearchHit.Agent
        assertEquals(Triple("bot", null, null), Triple(bot.kind, bot.workspaceId, bot.projectId))
        val event = answer.hits[4] as SearchHit.CalendarEvent
        assertTrue(event.allDay)
        assertEquals("content" to "Bring the launch banner", event.match to event.snippet)
        val message = answer.hits[5] as SearchHit.Message
        assertEquals(listOf("a1", "m1", "user", "when is the launch?", "w1", "p1"), listOf(message.agentId, message.messageId, message.role, message.snippet, message.workspaceId, message.projectId))
        assertTrue(answer.truncated && answer.partial)
    }

    @Test
    fun anOlderDaemonHasNoSearch() = runBlocking {
        assertNull(SearchClient(AgentClient(SearchDaemon(), "t")).search("launch"))
        // Nothing to ask for nothing typed.
        val daemon = SearchDaemon("""{"results":[]}""")
        assertEquals(emptyList<SearchHit>(), SearchClient(AgentClient(daemon, "t")).search("  ")!!.hits)
        assertTrue(daemon.paths.isEmpty())
    }

    @Test
    fun healthSaysWhetherTheDaemonHasSearch() = runBlocking {
        fun requester(capabilities: String) = AgentIdentity.Requester { _, path, _, _ ->
            val text = when (path) {
                "/v0/health" -> """{"healthy":true,"ready":true,"version":{"protocol":33,"daemon":"1"}$capabilities}"""
                else -> """{"config":{"node":{"name":"Studio"}}}"""
            }
            TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
        }
        assertTrue(AgentIdentity.refresh(requester(""","capabilities":{"search":true}"""), "fallback").search)
        assertFalse(AgentIdentity.refresh(requester(""), "fallback").search)
    }
}
