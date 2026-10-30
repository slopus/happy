package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.ByteSource
import com.slopus.happy.connection.TransportStream
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** SSE framing, the streamed HTTP answer, and the agent client's errors. */
class AgentWireTest {
    @Test
    fun framesSplitAnywhereAndHeartbeatsAreSkipped() {
        val text = ": heartbeat\n\n" + Wire.hello("c0") + Wire.frame("c1", "agent.updated", buildJsonObject { put("agentId", "a1") }) +
            "id: c2\r\nevent: run.started\r\ndata: {\"cursor\":\"c2\",\"type\":\"run.started\",\r\ndata: \"payload\":{\"agentId\":\"a2\"}}\r\n\r\n"
        val bytes = text.toByteArray()
        // One byte at a time, so every boundary (CR LF pairs too) is split.
        val parser = ServerSentEventParser()
        val frames = bytes.flatMap { parser.append(byteArrayOf(it)) }
        val events = frames.mapNotNull { it.toAgentEvent() }
        assertEquals(listOf("hello", "agent.updated", "run.started"), events.map { it.type })
        assertNull(events[0].cursor)
        assertEquals("c0", AgentHello.of(events[0]).cursor)
        assertEquals("c1", events[1].cursor)
        assertEquals("a1", events[1].agentId)
        assertEquals("a2", events[2].agentId)
    }

    @Test
    fun agentIdComesFromTheObjectsEventsCarry() {
        assertEquals("a3", AgentEvent("c", "agent.created", buildJsonObject { put("agent", buildJsonObject { put("id", "a3") }) }).agentId)
        assertEquals("a4", AgentEvent("c", "question.created", buildJsonObject { put("question", buildJsonObject { put("agentId", "a4") }) }).agentId)
        assertNull(AgentEvent("c", "config.updated", buildJsonObject {}).agentId)
    }

    @Test
    fun aHelloReportsAGap() {
        val parser = ServerSentEventParser()
        val event = parser.append(Wire.hello("c9", gap = true).toByteArray()).single().toAgentEvent()!!
        assertTrue(AgentHello.of(event).gap)
    }

    private fun source(vararg pieces: String) = object : ByteSource {
        val queue = ArrayDeque(pieces.map { it.toByteArray() })
        override suspend fun read() = queue.removeFirstOrNull() ?: ByteArray(0)
        override fun close() {}
    }

    @Test
    fun aChunkedStreamIsReadAsItComes() = runBlocking {
        val stream = TransportStream.open(source("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel", "lo\r\n", "6\r\n world\r\n0\r\n\r\n"))
        assertEquals(200, stream.status)
        val out = StringBuilder()
        while (true) out.append(String(stream.read() ?: break))
        assertEquals("hello world", out.toString())
    }

    @Test
    fun aStreamThatEndsMidChunkIsInvalid() = runBlocking {
        val stream = TransportStream.open(source("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe"))
        try {
            while (stream.read() != null) Unit
            fail()
        } catch (e: AgentConnectionException) {
            assertEquals(AgentConnectionException.Reason.InvalidResponse, e.reason)
        }
    }

    @Test
    fun errorsCarryTheirCodeAndRevocationIsItsOwn() = runBlocking {
        val agent = FakeAgent()
        val client = AgentClient(agent, "token")
        try {
            client.send("GET", "/v0/agents/missing")
            fail()
        } catch (e: AgentApiException) {
            assertEquals(404, e.status)
            assertEquals("not_found", e.code)
        }
        agent.revoked = true
        try {
            client.send("GET", "/v0/health")
            fail()
        } catch (e: AgentConnectionException) {
            assertEquals(AgentConnectionException.Reason.Revoked, e.reason)
        }
    }

    @Test
    fun newIdsAreWhatTheAgentAccepts() {
        repeat(200) { assertTrue(Regex("^[a-z][a-z0-9]{23}$").matches(AgentClient.newId())) }
        assertEquals("a%20b%2Fc", AgentClient.escape("a b/c"))
    }
}
