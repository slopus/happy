package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.agentTransport
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
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
    private val identityRefreshMillis: Long = 60_000,
    private val makeTransport: (AgentConnectionCredentials) -> Transport = { agentTransport(it.address, it.port, it.publicUrl, it.tailcatAvailable != false) },
) {
    private val sessions = HashMap<String, AgentSession>()

    init {
        // Discovery belongs to every paired account, not only the open
        // session. These identity-only jobs never open a catalog or SSE and
        // their transient failures cannot cancel the selected session.
        scope.launch {
            combine(connections.accounts, foreground) { accounts, front ->
                if (front) accounts.filterNot { it.revoked }.map { it.id }.toSet() else emptySet()
            }.distinctUntilChanged().collectLatest { ids ->
                coroutineScope {
                    ids.forEach { id -> launch { refreshIdentity(id) } }
                }
            }
        }
        scope.launch {
            connections.accounts.collect { list ->
                val ids = list.map { it.id }.toSet()
                val gone = synchronized(sessions) { sessions.keys.filter { it !in ids }.map { sessions.remove(it)!! } }
                gone.forEach { session ->
                    session.close()
                    cacheFile(session.connectionId)?.let { file ->
                        file.delete()
                        // And what is kept beside it: resources and conversations (`AgentSession.keepResource`), pictures.
                        file.parentFile?.listFiles { f -> f.name.startsWith(file.nameWithoutExtension + ".") }?.forEach { it.deleteRecursively() }
                    }
                }
            }
        }
    }

    private suspend fun refreshIdentity(id: String) {
        val credentials = connections.credentials(id) ?: return
        val transport = connections.transport(id, credentials, makeTransport)
        try {
            while (true) {
                val known = connections.accounts.value.firstOrNull { it.id == id && !it.revoked } ?: return
                try {
                    val etag = known.avatarFile?.takeIf { File(it).isFile }?.let { known.avatarETag }
                    val info = AgentIdentity.refresh(transport, credentials.deviceToken, known.name, etag)
                    connections.update(id, info.avatar) { it.copy(name = info.name, thumbhash = info.thumbhash ?: it.thumbhash) }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: AgentConnectionException) {
                    if (error.reason == AgentConnectionException.Reason.Revoked) {
                        connections.update(id) { it.copy(revoked = true) }
                        return
                    }
                    transport.reset()
                } catch (_: Exception) {
                    // Reconnect this identity job's tunnel on failure, without
                    // touching the selected session's separate SSE delegate.
                    transport.reset()
                }
                delay(identityRefreshMillis)
            }
        } finally {
            withContext(NonCancellable) { transport.close() }
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
