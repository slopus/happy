package com.slopus.happy.browser

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserComputeTest {
    @Test fun anAgentsComputeSaysWhetherItIsThere() {
        fun compute(json: String) = BrowserCompute.of(Json.parseToJsonElement(json))
        assertEquals(BrowserCompute.Detached, compute("""{"type":"none"}"""))
        assertEquals(BrowserCompute.Detached, compute("""{"type":"computer","computerId":"c1","status":"offline"}"""))
        assertEquals(BrowserCompute.Attached, compute("""{"type":"computer","computerId":"c1","status":"online"}"""))
        assertNull(compute("""{"type":"computer","computerId":"c1"}"""))
        assertNull(BrowserCompute.of(null))
    }

    @Test fun onlyTheComputesRefusalsCloseThePage() {
        for ((status, code) in listOf(409 to "no_compute", 503 to "compute_offline", 503 to "runner_unavailable", 503 to "draining")) {
            assertTrue("$status $code", BrowserCompute.gone(status, code))
            assertTrue("$status $code body", BrowserCompute.gone(status, """{"error":"x","code":"$code"}""".toByteArray()))
        }
        for ((status, code) in listOf(409 to "conflict", 503 to null, 502 to "compute_offline", 429 to "too_many_tunnels", 404 to "not_found")) {
            assertFalse("$status $code", BrowserCompute.gone(status, code))
        }
        assertFalse(BrowserCompute.gone(503, "not json".toByteArray()))
        // An open tunnel's close: only Happy Cloud's for the compute.
        assertTrue(BrowserCompute.goneOnClose(1001, "no_compute"))
        assertTrue(BrowserCompute.goneOnClose(1001, "compute_offline"))
        assertFalse(BrowserCompute.goneOnClose(1000, "idle"))
        assertFalse(BrowserCompute.goneOnClose(1008, ""))
        assertFalse(BrowserCompute.goneOnClose(1001, "going_away"))
    }

    @Test fun aPageClosesOnceAndReopensWhenTheComputeIsBack() {
        val gate = BrowserComputeGate()
        assertNull(gate.apply(BrowserCompute.Attached))
        assertEquals(BrowserComputeGate.Action.Close, gate.apply(BrowserCompute.Detached))
        // The compute's own news of a loss a tunnel told first doesn't close it again.
        assertNull(gate.apply(BrowserCompute.Detached))
        assertTrue(gate.closed)
        assertEquals(BrowserComputeGate.Action.Reopen, gate.apply(BrowserCompute.Attached))
        assertNull(gate.apply(BrowserCompute.Attached))
        assertEquals(BrowserComputeGate.Action.Close, gate.apply(BrowserCompute.Detached))
    }

    @Test fun thePageHearsOfATunnelRefusedForItsCompute() {
        val refusals = BrowserRefusals()
        var heard = 0
        refusals.onComputeGone { heard++ }
        val authority = BrowserPolicy.Authority.of("http://localhost:5173")!!
        refusals.record(BrowserProxyRefusal(502, "browser_proxy_upstream_refused"), authority)
        assertEquals(0, heard)
        val failure = BrowserFailure.of(BrowserException(BrowserException.Kind.ComputeGone, 503))
        assertEquals(BrowserProxyRefusal.COMPUTE_GONE, failure.code)
        refusals.record(BrowserProxyRefusal(failure.status, failure.code), authority)
        assertEquals(1, heard)
        assertEquals(BrowserProblem.ComputeDisconnected, BrowserProxyRefusal(failure.status, failure.code).problem)
        assertEquals(BrowserProblem.ComputeDisconnected, BrowserProblem.opening(BrowserException(BrowserException.Kind.ComputeGone), BrowserLink.Online))
        assertEquals(BrowserProblem.ComputeDisconnected, BrowserProblem.response(503, failure.code, true, BrowserLink.Online))
    }

    /** `GET /v0/agents/a1`, its compute each read the next of [computes] (the last kept). */
    private class Agents(vararg computes: String) : Transport {
        private val computes = computes.toMutableList()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            if (path != "/v0/agents/a1") return TransportResponse(404, body = "{}".toByteArray())
            val compute = if (computes.size > 1) computes.removeAt(0) else computes[0]
            return TransportResponse(200, body = """{"agent":{"id":"a1","workspaceId":"w1","status":"idle","compute":$compute}}""".toByteArray())
        }

        override suspend fun close() {}
    }

    private fun updated(agentId: String, compute: String?): AgentEvent {
        val changes = if (compute == null) """{"status":"idle"}""" else """{"status":"idle","compute":$compute}"""
        return AgentEvent("c", "agent.updated", Json.parseToJsonElement("""{"agentId":"$agentId","changes":$changes}""").jsonObject)
    }

    @Test fun anAgentsComputeIsFollowedFromItsEventsOnceItHasAStatus() = runBlocking {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        val client = AgentClient(Agents("""{"type":"computer","status":"online"}""", """{"type":"computer","status":"offline"}"""), "test", cloud = true)
        val changes = browserAgentCompute(client, events, "a1").produceIn(this)
        withTimeout(5_000) {
            assertEquals(BrowserCompute.Attached, changes.receive())
            events.emit(updated("other", """{"type":"none"}"""))
            events.emit(updated("a1", null))
            events.emit(updated("a1", """{"type":"none"}"""))
            assertEquals(BrowserCompute.Detached, changes.receive())
            // Events may have been lost: the agent is read again.
            events.emit(AgentEvent(null, AgentEvent.HELLO, JsonObject(emptyMap())))
            assertEquals(BrowserCompute.Detached, changes.receive())
            events.emit(updated("a1", """{"type":"computer","status":"online"}"""))
            assertEquals(BrowserCompute.Attached, changes.receive())
        }
        changes.cancel()
    }

    @Test fun aComputersOwnAgentIsNeverClosedForHavingNoCompute() = runBlocking {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        val client = AgentClient(Agents("""{"type":"none"}"""), "test")
        val changes = browserAgentCompute(client, events, "a1").produceIn(this)
        withTimeout(5_000) {
            while (events.subscriptionCount.value == 0) kotlinx.coroutines.delay(10)
            events.emit(updated("a1", """{"type":"none"}"""))
            events.emit(updated("a1", """{"type":"computer","status":"online"}"""))
            assertEquals(BrowserCompute.Attached, changes.receive())
        }
        changes.cancel()
    }
}
