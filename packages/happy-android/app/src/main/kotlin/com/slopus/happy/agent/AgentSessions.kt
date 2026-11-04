package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.agentTransport
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
    /** Desktop's completion chime, for a conversation that finished while its connection is open ([CompletionWatch]). */
    private val chime: () -> Unit = {},
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
            var known: Set<String>? = null
            connections.accounts.collect { list ->
                val ids = list.map { it.id }.toSet()
                val gone = synchronized(sessions) { sessions.keys.filter { it !in ids }.map { sessions.remove(it)!! } }
                gone.forEach { it.close() }
                // Every connection that went, open or not (another member's replaced, one forgotten), and at the
                // start whatever a connection gone while the app wasn't running left behind.
                val wiped = known?.let { it - ids }.orEmpty() + gone.map { it.connectionId }
                withContext(Dispatchers.IO) {
                    wiped.forEach(::deleteCache)
                    if (known == null) sweep(ids)
                }
                known = ids
            }
        }
    }

    private suspend fun refreshIdentity(id: String) {
        val credentials = connections.credentials(id) ?: return
        val transport = connections.transport(id, credentials, makeTransport)
        val renew: (suspend (String) -> String)? = if (credentials.oauth != null) { stale -> connections.renew(id, stale) } else null
        val client = AgentClient.lazy {
            // The sign-in this request is made under: only its refusal signs out, never a newer one's.
            val grant = connections.grant(id)
            AgentClient.Link(transport, connections.bearer(id, credentials), renew, credentials.oauth?.let { { profile -> connections.signedOut(id, profile, grant) } })
        }
        try {
            while (true) {
                val known = connections.accounts.value.firstOrNull { it.id == id && !it.revoked } ?: return
                val grant = connections.grant(id)
                // A team server that wants signing in again waits for the person.
                if (!known.signInRequired) try {
                    val etag = known.avatarFile?.takeIf { File(it).isFile }?.let { known.avatarETag }
                    val info = AgentIdentity.refresh(client.requester, known.name, etag, oauth = credentials.oauth != null)
                    connections.update(id, info.avatar) { it.copy(name = info.name, thumbhash = info.thumbhash ?: it.thumbhash, instanceId = info.instanceId, daemonVersion = info.daemonVersion) }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: AgentConnectionException) {
                    if (error.reason == AgentConnectionException.Reason.Revoked) {
                        connections.update(id) { it.copy(revoked = true) }
                        return
                    }
                    if (error.reason == AgentConnectionException.Reason.SignInRequired || error.reason == AgentConnectionException.Reason.ProfileRequired) {
                        val profile = error.reason == AgentConnectionException.Reason.ProfileRequired
                        connections.signedOut(id, profile, grant)
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
                    chime = chime,
                )
            }
        }
    }

    /** [connectionId]'s catalog and what is kept beside it: resources and conversations (`AgentSession.keepResource`), pictures. */
    private fun deleteCache(connectionId: String) {
        val file = cacheFile(connectionId) ?: return
        file.delete()
        file.parentFile?.listFiles { f -> f.name.startsWith(file.nameWithoutExtension + ".") }?.forEach { it.deleteRecursively() }
    }

    /** Deletes the caches of connections not in [ids]. */
    private fun sweep(ids: Set<String>) {
        val keep = ids.mapNotNull { cacheFile(it)?.nameWithoutExtension }.toSet()
        cacheDir?.listFiles()?.forEach { f ->
            if (f.name.substringBefore('.') !in keep) f.deleteRecursively()
        }
    }

    private fun cacheFile(connectionId: String): File? =
        cacheDir?.let { File(it, "${connectionId.filter { c -> c.isLetterOrDigit() || c == '-' }}.json") }
}
