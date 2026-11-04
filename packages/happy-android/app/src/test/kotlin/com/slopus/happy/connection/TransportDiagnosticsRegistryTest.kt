package com.slopus.happy.connection

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class TransportDiagnosticsRegistryTest {
    private class Fake(val count: Int) : Transport {
        var closes = 0
        override suspend fun diagnostics() = TransportDiagnostics(TransportDiagnostics.Kind.Tailcat, count)
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse = error("Never connect for diagnostics")
        override suspend fun close() { closes++ }
    }

    @Test fun accountSnapshotsIncludeDiscoveryAndSessionWithoutMixingAnotherAccount() = runBlocking {
        val registry = TransportDiagnosticsRegistry()
        val discovery = Fake(1)
        val session = Fake(3)
        val other = Fake(7)
        val first = registry.track("a", discovery)
        val second = registry.track("a", session)
        registry.track("b", other)
        assertEquals(listOf(1, 3), registry.snapshot("a").map { it.openFlows })
        assertEquals(listOf(7), registry.snapshot("b").map { it.openFlows })
        first.close()
        first.close()
        assertEquals(1, discovery.closes)
        assertEquals(listOf(3), registry.snapshot("a").map { it.openFlows })
        second.close()
        val replacement = registry.track("a", Fake(9))
        second.close()
        assertEquals(listOf(9), registry.snapshot("a").map { it.openFlows })
        assertEquals(listOf(7), registry.snapshot("b").map { it.openFlows })
        replacement.close()
        assertEquals(emptyList<TransportDiagnostics>(), registry.snapshot("a"))
    }
}