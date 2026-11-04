package com.slopus.happy.calendar

import com.slopus.happy.agent.AgentApiException
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
import org.junit.Assert.fail
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class CalendarRoutesTest {
    private class Daemon : Transport by FakeAgent() {
        data class Request(val method: String, val path: String, val body: JsonObject?, val headers: Map<String, String>)
        val requests = ArrayList<Request>()
        var conflict = false
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            requests += Request(method, path, body?.let { Json.parseToJsonElement(it.decodeToString()).jsonObject }, headers)
            val event = """{"id":"one","surfaceId":"team","title":"Theirs","timing":{"kind":"allDay","startDate":"2026-10-20","endDate":"2026-10-21"},"version":"v2","status":"active"}"""
            val reply = if (conflict) """{"code":"conflict","error":"Changed elsewhere","event":$event}""" else """{"event":$event}"""
            return TransportResponse(if (conflict) 409 else 200, emptyMap(), reply.toByteArray())
        }
    }

    @Test fun createRetriesKeepTheIdAndExistingMutationsCarryIfMatch() = runBlocking {
        val daemon = Daemon()
        val routes = CalendarRoutes(AgentClient(daemon, "test"))
        val draft = CalendarDraft.new(LocalDate.of(2026, 10, 20), ZoneId.of("UTC"))
        val event = routes.save("team", null, "retry-id", draft)
        routes.save("team", null, "retry-id", draft)
        routes.save("team", event, "ignored", draft)
        routes.delete(event)
        assertEquals(listOf("POST", "POST", "PATCH", "DELETE"), daemon.requests.map { it.method })
        assertEquals(listOf("\"retry-id\"", "\"retry-id\""), daemon.requests.take(2).map { it.body?.get("id").toString() })
        assertEquals(listOf(null, null, "v2", "v2"), daemon.requests.map { it.headers["If-Match"] })
        assertNull(daemon.requests[2].body?.get("id"))
        assertEquals("/v0/surfaces/calendar/team/one", daemon.requests[2].path)
    }

    @Test fun concurrentChangeIsReturnedToTheEditorWithoutRetryingTheWrite() = runBlocking {
        val daemon = Daemon()
        val routes = CalendarRoutes(AgentClient(daemon, "test"))
        val draft = CalendarDraft.new(LocalDate.of(2026, 10, 20), ZoneId.of("UTC"))
        val event = routes.save("team", null, "retry-id", draft)
        daemon.conflict = true
        try { routes.save("team", event.copy(version = "v1"), "ignored", draft); fail("Expected conflict") }
        catch (error: AgentApiException) {
            assertEquals(409, error.status)
            assertEquals("Theirs", CalendarEvent.parse(error.body?.jsonObject?.get("event"))?.title)
        }
        assertEquals(2, daemon.requests.size)
    }
}