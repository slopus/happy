package com.slopus.happy.connection

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** A current snapshot of public transport data, containing no credentials or Tailcat addresses. */
data class TransportDiagnostics(val kind: Kind, val openFlows: Int, val tunnels: List<Tunnel> = emptyList(), val server: String? = null) {
    enum class Kind { Tailcat, Https }
    enum class Path { Direct, Relayed }
    data class Tunnel(val category: RequestCategory, val path: Path, val configuredRelay: String?, val openFlows: Int)
}

/** Discovery and session transports belong to the account they were created for, even after a switch. */
internal class TransportDiagnosticsRegistry {
    private val lock = Any()
    private val transports = mutableMapOf<String, MutableMap<UUID, Transport>>()

    fun track(accountId: String, transport: Transport): Transport {
        val id = UUID.randomUUID()
        synchronized(lock) { transports.getOrPut(accountId) { mutableMapOf() }[id] = transport }
        return object : Transport by transport {
            private val closed = AtomicBoolean()
            override suspend fun close() {
                if (!closed.compareAndSet(false, true)) return
                try { transport.close() } finally {
                    synchronized(lock) {
                        transports[accountId]?.let { own ->
                            own.remove(id)
                            if (own.isEmpty()) transports.remove(accountId)
                        }
                    }
                }
            }
        }
    }

    suspend fun snapshot(accountId: String): List<TransportDiagnostics> = withContext(Dispatchers.IO) {
        val own = synchronized(lock) { transports[accountId]?.values?.toList().orEmpty() }
        own.mapNotNull { it.diagnostics() }
    }
}