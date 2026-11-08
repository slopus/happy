package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ComputePoolsTest {
    private val pools = """{"pools":[{"id":"default","name":"Team","memberSandboxes":4,"nodeCounts":{"total":1,"online":1,"offline":0,"draining":0,"enrolling":0,"revoked":0},"sandboxCapacity":{"used":3,"total":null}}]}"""
    private val nodes = """{"nodes":[{"id":"node-1","pool":"default","name":null,"hostname":"worker","status":"online","version":"linux.8","lastSeenAt":1730000000000,"sandboxCapacity":{"used":3,"total":null},"activeSandboxes":[{"sandboxId":"s1","agentId":"a1","agentTitle":null}]}]}"""

    private class Server(private val answer: suspend (String) -> Pair<Int, String>) : Transport {
        val asked = mutableListOf<Pair<String, String?>>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            val key = "$method $path"
            asked += key to body?.decodeToString()
            val (status, json) = answer(key)
            return TransportResponse(status, mapOf("content-type" to "application/json"), json.toByteArray())
        }
        override suspend fun close() {}
    }
    private fun answer(path: String): Pair<Int, String> = 200 to when (path) {
        "GET /v0/compute/pools" -> pools
        "GET /v0/compute/nodes" -> nodes
        else -> "{}"
    }
    private fun client(server: Server) = AgentClient(server, "test", cloud = true)

    @Test
    fun monitoringKeepsUnknownCapacityAndAgentIdFallbackWithoutInferringFromLimits() = runTest {
        val server = Server(::answer)
        val snapshot = ComputePools.read(client(server))
        assertEquals(SandboxCapacity(3, null), snapshot.pools.single().capacity)
        assertEquals(SandboxCapacity(3, null), snapshot.nodes.single().capacity)
        assertEquals("worker", snapshot.nodes.single().name)
        assertEquals("a1", snapshot.nodes.single().agents.single().agentId)
        assertNull(snapshot.nodes.single().agents.single().title)
        assertEquals(listOf("GET /v0/compute/pools", "GET /v0/compute/nodes"), server.asked.map { it.first })
    }

    @Test
    fun hostFactsPreserveLargeByteTotalsWithoutInventingMissingValues() = runTest {
        suspend fun host(fragment: String): ComputeHost? {
            val server = Server { path -> answer(path).let { (status, text) ->
                status to if (path.endsWith("/nodes")) text.replace("\"version\":", "$fragment\"version\":") else text
            } }
            return ComputePools.read(client(server)).nodes.single().host
        }
        assertNull(host(""))
        assertNull(host("\"host\":null,"))
        assertEquals(ComputeHost(4, 8_326_934_528, 165_295_407_104), host("\"host\":{\"cpuCores\":4,\"totalMemoryBytes\":8326934528,\"totalDiskBytes\":165295407104},"))
        assertEquals(ComputeHost(4, null, null), host("\"host\":{\"cpuCores\":4,\"totalMemoryBytes\":null},"))
        assertEquals(ComputeHost(null, null, null), host("\"host\":{\"cpuCores\":0,\"totalMemoryBytes\":-1,\"totalDiskBytes\":\"123\"},"))
    }

    @Test
    fun missingMonitoringFieldsAreNotInventedAsEmptyData() = runTest {
        val server = Server { path -> if (path.endsWith("/pools")) 200 to """{"pools":[{"id":"default","name":"Team"}]}""" else answer(path) }
        val source = ComputePoolsSource(client(server))
        source.refresh()
        assertEquals(ComputePoolsSource.State.Failed, source.state.value)
    }

    @Test
    fun emptyPoolHasARealZeroAndKnownCapacityIsPreserved() = runTest {
        val server = Server { path -> answer(path).let { (status, text) -> status to text.replace("\"used\":3,\"total\":null", "\"used\":0,\"total\":0") } }
        assertEquals(SandboxCapacity(0, 0), ComputePools.read(client(server)).pools.single().capacity)
    }

    @Test
    fun forbiddenClearsExistingDataAndStopsAllFurtherReadsAndActions() = runTest {
        var forbidden = false
        val server = Server { if (forbidden) 403 to """{"code":"forbidden"}""" else answer(it) }
        val source = ComputePoolsSource(client(server))
        source.refresh()
        val node = (source.state.value as ComputePoolsSource.State.Loaded).snapshot.nodes.single()
        forbidden = true
        source.refresh()
        assertEquals(ComputePoolsSource.State.Forbidden, source.state.value)
        val count = server.asked.size
        source.refresh()
        assertFalse(source.drain(node))
        assertEquals(count, server.asked.size)
    }

    @Test
    fun visibleObservationPollsAndFollowsEventsButStopsWhenCancelled() = runTest {
        val server = Server(::answer)
        val source = ComputePoolsSource(client(server))
        val events = MutableSharedFlow<AgentEvent>()
        val observer = launch { source.observe(events) }
        runCurrent()
        assertEquals(2, server.asked.size)
        advanceTimeBy(30_001)
        assertEquals(4, server.asked.size)
        events.emit(AgentEvent("c1", "compute.nodes.updated", kotlinx.serialization.json.JsonObject(emptyMap())))
        runCurrent()
        assertEquals(6, server.asked.size)
        observer.cancelAndJoin()
        advanceTimeBy(90_000)
        assertEquals(6, server.asked.size)
        val revealed = launch { source.observe(events) }
        runCurrent()
        assertEquals(8, server.asked.size)
        revealed.cancelAndJoin()
        assertTrue(server.asked.all { it.first.startsWith("GET ") })
    }

    @Test
    fun leavingCancelsAnInFlightRead() = runTest {
        var cancelled = false
        val server = Server { try { awaitCancellation() } finally { cancelled = true } }
        val observer = launch { ComputePoolsSource(client(server)).observe(MutableSharedFlow()) }
        runCurrent()
        observer.cancelAndJoin()
        assertTrue(cancelled)
    }

    @Test
    fun drainAndUndrainAreExplicitAndRefreshBothLists() = runTest {
        val server = Server(::answer)
        val source = ComputePoolsSource(client(server))
        source.refresh()
        val node = (source.state.value as ComputePoolsSource.State.Loaded).snapshot.nodes.single()
        assertTrue(source.drain(node))
        assertEquals(listOf("POST /v0/compute/nodes/node-1/drain", "GET /v0/compute/pools", "GET /v0/compute/nodes"), server.asked.takeLast(3).map { it.first })
        assertTrue(source.drain(node.copy(status = "draining")))
        assertEquals("POST /v0/compute/nodes/node-1/undrain", server.asked[server.asked.size - 3].first)
        val before = server.asked.size
        assertFalse(source.drain(node.copy(status = "revoked")))
        assertEquals(before, server.asked.size)
    }

    @Test
    fun aMutationForbiddenAnswerClearsFactsAndIsNotRetried() = runTest {
        val server = Server { if (it.startsWith("POST ")) 403 to """{"code":"forbidden"}""" else answer(it) }
        val source = ComputePoolsSource(client(server))
        source.refresh()
        assertFalse(source.drain((source.state.value as ComputePoolsSource.State.Loaded).snapshot.nodes.single()))
        assertEquals(ComputePoolsSource.State.Forbidden, source.state.value)
        assertEquals(1, server.asked.count { it.first.startsWith("POST ") })
    }

    @Test
    fun forbiddenEnrollmentClearsTheSnapshotWithoutRetryingOrKeepingACommand() = runTest {
        val server = Server { if (it.startsWith("POST ")) 403 to """{"code":"forbidden"}""" else answer(it) }
        val source = ComputePoolsSource(client(server))
        source.refresh()
        val pool = (source.state.value as ComputePoolsSource.State.Loaded).snapshot.pools.single()
        try {
            source.joinCommand(pool)
            fail("forbidden enrollment must not return a command")
        } catch (e: AgentApiException) {
            assertEquals(403, e.status)
        }
        assertEquals(ComputePoolsSource.State.Forbidden, source.state.value)
        source.refresh()
        assertEquals(3, server.asked.size)
    }

    @Test
    fun commandsAreReturnedVerbatimOnlyAfterAnExplicitRequestAndNullInstallerIsKept() = runTest {
        val server = Server { path ->
            if (path.endsWith("/join-tokens")) 201 to """{"token":"not-a-real-token","expiresAt":1730000000000,"commands":{"unix":"  run --exact 'x'  ","windows":"Run-Exact -x"}}""" else answer(path)
        }
        val source = ComputePoolsSource(client(server))
        source.refresh()
        val pool = (source.state.value as ComputePoolsSource.State.Loaded).snapshot.pools.single()
        assertEquals(0, server.asked.count { it.first.startsWith("POST ") })
        val command = source.joinCommand(pool)
        assertEquals("  run --exact 'x'  ", command.unix)
        assertEquals("Run-Exact -x", command.windows)
        assertEquals("{}", server.asked.last().second)
        assertFalse(command.toString().contains("run --exact"))
        val unconfigured = Server { 201 to """{"expiresAt":1730000000000,"commands":null}""" }
        val absent = ComputePools.joinCommand(client(unconfigured), "a/b")
        assertNull(absent.unix)
        assertNull(absent.windows)
        assertEquals("POST /v0/compute/pools/a%2Fb/join-tokens", unconfigured.asked.single().first)
    }

    @Test
    fun localConnectionsNeverCallCloudMonitoring() = runTest {
        val server = Server(::answer)
        val source = ComputePoolsSource(AgentClient(server, "test", cloud = false))
        source.refresh()
        assertEquals(ComputePoolsSource.State.Failed, source.state.value)
        assertTrue(server.asked.isEmpty())
    }
}