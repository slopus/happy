package com.slopus.happy.connection

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class AgentEndpointTest {
    private val original = AgentConnectionCredentials("original-tailcat", 24781, "device", "token")

    @Test fun diagnosticsNeverConnectAnIdleOrInvalidatedEndpoint() = runBlocking {
        val endpoint = AgentEndpoint(original) { }
        var made = 0
        val transport = AgentEndpointTransport(endpoint) {
            made++
            object : Transport by Fake() {
                override suspend fun diagnostics() = TransportDiagnostics(TransportDiagnostics.Kind.Tailcat, 1)
            }
        }
        assertNull(transport.diagnostics())
        assertEquals(0, made)
        transport.request("GET", "/v0/health", "token")
        assertEquals(1, transport.diagnostics()!!.openFlows)
        endpoint.retire()
        assertNull(transport.diagnostics())
        assertEquals(1, made)
        transport.close()
    }

    @Test fun advertisementsPreserveAbsentVersusNullAndIgnoreConnectorProjection() {
        for (text in listOf("""{"config":{}}""", """{"config":{"api":{"localPort":1}}}""", """{"config":{"mobileConnector":{"publicUrl":"https://wrong.example"}}}""")) {
            assertEquals(AgentEndpointAdvertisement.Unchanged, AgentEndpointAdvertisement.decode(text.toByteArray()))
        }
        assertEquals(AgentEndpointAdvertisement.Select(null), AgentEndpointAdvertisement.decode("""{"config":{"api":{"publicUrl":null}}}""".toByteArray()))
        assertEquals(AgentEndpointAdvertisement.Select("https://agent.example:8443"), AgentEndpointAdvertisement.decode("""{"config":{"api":{"publicUrl":"https://agent.example:8443","localPort":1}}}""".toByteArray()))
        for (value in listOf("42", "true", "\"http://agent.example\"", "\"https://agent.example/\"")) {
            assertThrows(AgentConnectionException::class.java) { AgentEndpointAdvertisement.decode("{\"config\":{\"api\":{\"publicUrl\":$value}}}".toByteArray()) }
        }
    }

    @Test fun authenticatedAdoptionClosesAllOldClientsAndRemovalRestoresOriginalCoordinates() = runBlocking {
        val saved = mutableListOf<AgentConnectionCredentials>()
        val endpoint = AgentEndpoint(original) { saved += it }
        val made = mutableListOf<Pair<AgentConnectionCredentials, Fake>>()
        val make: (AgentConnectionCredentials) -> Transport = { credentials -> Fake().also { made += credentials to it } }
        val first = AgentEndpointTransport(endpoint, make)
        val second = AgentEndpointTransport(endpoint, make)
        first.request("GET", "/v0/health", "token")
        second.request("GET", "/v0/health", "token")
        val old = made.toList()
        old[1].second.config = """{"config":{"api":{"publicUrl":"https://agent.example:8443","localPort":1}}}"""
        second.request("GET", "/v0/config", "token")
        assertEquals(original.copy(publicUrl = "https://agent.example:8443"), saved.single())
        assertTrue(old.all { it.second.closed })
        first.request("GET", "/v0/health", "token")
        assertEquals("https://agent.example:8443", made.last().first.publicUrl)
        made.last().second.config = """{"config":{"api":{"publicUrl":null}}}"""
        first.request("GET", "/v0/config", "token")
        first.request("GET", "/v0/health", "token")
        assertEquals(original, made.last().first)
        first.close(); second.close()
    }

    @Test fun failedHttpsAndUnrelatedBearerNeverTriggerFallback() = runBlocking {
        val saved = mutableListOf<AgentConnectionCredentials>()
        val credentials = original.copy(publicUrl = "https://agent.example")
        val endpoint = AgentEndpoint(credentials) { saved += it }
        val fake = Fake()
        var made = 0
        val transport = AgentEndpointTransport(endpoint) { assertEquals(credentials, it); made++; fake }
        fake.config = """{"config":{"api":{"publicUrl":null}}}"""
        transport.request("GET", "/v0/config", "not-the-token")
        fake.config = """{"config":{"api":{"publicUrl":"http://poison.example"}}}"""
        try { transport.request("GET", "/v0/config", "token"); fail("malformed advertisement accepted") } catch (_: AgentConnectionException) { }
        fake.failing = true
        try { transport.request("GET", "/v0/config", "token"); fail() } catch (_: AgentConnectionException) { }
        assertTrue(saved.isEmpty())
        assertEquals(1, made)
        transport.close()
    }

    @Test fun inFlightOldConfigCannotReplaceANewerEndpoint() = runBlocking {
        val saved = mutableListOf<AgentConnectionCredentials>()
        val endpoint = AgentEndpoint(original) { saved += it }
        val made = mutableListOf<Fake>()
        val make: (AgentConnectionCredentials) -> Transport = { Fake().also { made += it } }
        val slow = AgentEndpointTransport(endpoint, make)
        val fresh = AgentEndpointTransport(endpoint, make)
        slow.request("GET", "/v0/health", "token")
        val gate = CompletableDeferred<TransportResponse>()
        made[0].gate = gate
        val pending = async(start = CoroutineStart.UNDISPATCHED) { slow.request("GET", "/v0/config", "token") }
        fresh.request("GET", "/v0/health", "token")
        made[1].config = """{"config":{"api":{"publicUrl":"https://fresh.example"}}}"""
        fresh.request("GET", "/v0/config", "token")
        gate.complete(TransportResponse(200, body = """{"config":{"api":{"publicUrl":"https://stale.example"}}}""".toByteArray()))
        pending.await()
        assertEquals(listOf("https://fresh.example"), saved.map { it.publicUrl })
        slow.close(); fresh.close()
    }

    @Test fun failedPersistenceAndStaleResponsesCannotChangeRoute() = runBlocking {
        val saved = mutableListOf<AgentConnectionCredentials>()
        var failSave = true
        val endpoint = AgentEndpoint(original) { if (failSave) error("secure store unavailable"); saved += it }
        val id = UUID.randomUUID()
        val before = endpoint.observe(id) { }
        try { endpoint.apply(AgentEndpointAdvertisement.Select("https://one.example"), before); fail() } catch (_: IllegalStateException) { }
        assertEquals(original, endpoint.observe(id) { }.credentials)
        failSave = false
        endpoint.apply(AgentEndpointAdvertisement.Select("https://one.example"), before)
        endpoint.apply(AgentEndpointAdvertisement.Select("https://stale.example"), before)
        assertEquals("https://one.example", endpoint.observe(id) { }.credentials.publicUrl)
        assertEquals(1, saved.size)
        endpoint.retire()
    }

    @Test fun v2RemovalCannotInventATailcatAddress() = runBlocking {
        val credentials = AgentConnectionCredentials("https://agent.example", 443, "device", "token", "https://agent.example", false)
        var saved: AgentConnectionCredentials? = null
        val endpoint = AgentEndpoint(credentials) { saved = it }
        endpoint.apply(AgentEndpointAdvertisement.Select(null), endpoint.observe(UUID.randomUUID()) { })
        val current = requireNotNull(saved)
        assertNull(current.publicUrl)
        assertEquals(false, current.tailcatAvailable)
        val transport = agentTransport(current.address, current.port, current.publicUrl, current.tailcatAvailable != false)
        assertFalse(transport is TailcatTransport)
        try { transport.request("GET", "/v0/health", "token"); fail() } catch (e: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.Unavailable, e.reason) }
        transport.close()
    }

    private class Fake : Transport {
        var config = """{"config":{}}"""
        var closed = false
        var failing = false
        var gate: CompletableDeferred<TransportResponse>? = null
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            if (failing) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            if (path == "/v0/config") gate?.let { return it.await() }
            return TransportResponse(200, body = (if (path == "/v0/config") config else "{}").toByteArray())
        }
        override suspend fun close() { closed = true }
    }
}