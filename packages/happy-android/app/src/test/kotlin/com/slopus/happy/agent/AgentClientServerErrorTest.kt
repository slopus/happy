package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The connection page's last error: an answer the agent couldn't act on (iOS's `MeteredAgentTransport`). */
class AgentClientServerErrorTest {
    private val agent = FakeAgent()
    private val client = AgentClient(object : Transport by agent {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse = when (path) {
            "/v0/agents/a/send" -> TransportResponse(503, body = """{"error":"Happy Agent is draining and no longer accepts mutations.","code":"draining"}""".toByteArray())
            "/v0/odd" -> TransportResponse(500, body = """{"code":"https://example.test/?token=secret"}""".toByteArray())
            "/v0/missing" -> TransportResponse(404, body = """{"error":"Not found.","code":"not_found"}""".toByteArray())
            else -> agent.request(method, path, credential, body, headers, category)
        }
    }, "token")

    private suspend fun attempt(method: String, path: String) {
        try { client.send(method, path) } catch (_: AgentApiException) {}
    }

    @Test
    fun aDrainingDaemonsRefusalIsTheLastError() = runBlocking {
        assertNull(client.lastServerError.value)
        attempt("POST", "/v0/agents/a/send")
        assertEquals("POST answered 503 (draining)", client.lastServerError.value)
        attempt("GET", "/v0/odd")
        assertEquals("a code that isn't an identifier is left out", "GET answered 500", client.lastServerError.value)
        attempt("GET", "/v0/missing")
        assertEquals("a refusal is the person's, not the link's", "GET answered 500", client.lastServerError.value)
    }
}
