package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.TailcatTransport
import com.slopus.happy.connection.Transport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.io.File

/**
 * Every agent connection's [AgentSession], made on first use and kept while
 * the connection is on the phone. A session's live link runs only while
 * its connection is the open account and the app is in the foreground;
 * otherwise it stays with its cached catalog. Removing a connection closes
 * its session and deletes its cache.
 */
class AgentSessions(
    private val connections: AgentConnections,
    private val scope: CoroutineScope,
    /** Where each connection's catalog is cached, one file per connection. */
    private val cacheDir: File?,
    /** The open agent connection's id ([com.slopus.happy.AppGraph.openAgentId]). */
    private val openId: StateFlow<String?>,
    private val foreground: StateFlow<Boolean>,
    private val makeTransport: (AgentConnectionCredentials) -> Transport = { TailcatTransport(it.address, it.port) },
) {
    private val sessions = HashMap<String, AgentSession>()

    init {
        scope.launch {
            connections.accounts.collect { list ->
                val ids = list.map { it.id }.toSet()
                val gone = synchronized(sessions) { sessions.keys.filter { it !in ids }.map { sessions.remove(it)!! } }
                gone.forEach { session ->
                    session.close()
                    cacheFile(session.connectionId)?.delete()
                }
            }
        }
    }

    /** The session for [connectionId]; null when no such connection is on the phone. */
    fun session(connectionId: String): AgentSession? {
        if (connections.accounts.value.none { it.id == connectionId }) return null
        return synchronized(sessions) {
            sessions.getOrPut(connectionId) {
                AgentSession(
                    connectionId = connectionId,
                    connections = connections,
                    cacheFile = cacheFile(connectionId),
                    active = combine(openId, foreground) { open, front -> open == connectionId && front },
                    parent = scope,
                    makeTransport = makeTransport,
                )
            }
        }
    }

    private fun cacheFile(connectionId: String): File? =
        cacheDir?.let { File(it, "${connectionId.filter { c -> c.isLetterOrDigit() || c == '-' }}.json") }
}
