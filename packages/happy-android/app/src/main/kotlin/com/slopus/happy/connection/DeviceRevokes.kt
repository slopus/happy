package com.slopus.happy.connection

import com.slopus.happy.auth.ExpoSecureStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A disconnected pairing whose device is still to be removed from its agent, with what the request needs. */
@Serializable
data class PendingDeviceRevoke(val credentials: AgentConnectionCredentials, val queuedAt: Long)

/**
 * Removes disconnected pairings' devices from their agents (iOS's
 * DeviceRevokeQueue), after the connection has already gone from this
 * phone, so the agent's device list doesn't keep a phone that will never
 * come back: a new pairing is a new device. `DELETE
 * /v0/mobile-connector/device` with the pairing's own token, kept
 * Keystore-encrypted until the agent answers: a 2xx; a 401 (already gone);
 * a 403 (a daemon from before the route: nothing can be done); any other
 * refusal but 408 and 429. Anything else (no network, Tailcat not through,
 * a 5xx) is tried again at 1, 2, 4 … 30 s while the app runs, and at once on
 * [resume]: each start, each return to the foreground, and each new
 * pairing. One left for 30 days is dropped.
 *
 * Only the old pairing's token is ever sent; a token a connection on this
 * phone holds now ([inUse]) is dropped unsent.
 */
class DeviceRevokes(
    private val store: ExpoSecureStore,
    private val scope: CoroutineScope,
    private val makeTransport: (AgentConnectionCredentials) -> Transport = { agentTransport(it.address, it.port, it.publicUrl, it.tailcatAvailable != false) },
    private val now: () -> Long = System::currentTimeMillis,
    private val backoffMillis: (attempt: Int) -> Long = { attempt -> minOf(30_000L, 1_000L shl minOf(attempt - 1, 5)) },
    private val attemptTimeoutMillis: Long = 30_000,
) {
    /** Whether a connection on this phone holds the token now; [AgentConnections] says. */
    @Volatile
    var inUse: suspend (String) -> Boolean = { false }

    private val lock = Mutex()
    private var loaded: Map<String, PendingDeviceRevoke>? = null
    private var running: Job? = null

    /**
     * Keeps [credentials]' revocation under the connection's [id], then
     * sends it. Returns once it is kept, not sent. A team server's sign-in
     * has no device to revoke.
     */
    suspend fun enqueue(id: String, credentials: AgentConnectionCredentials) {
        if (credentials.oauth != null || credentials.deviceToken.isEmpty()) return
        lock.withLock { save(load() + (id to PendingDeviceRevoke(credentials, now()))) }
        resume()
    }

    /** Sends what is waiting now, without waiting for the backoff. */
    fun resume() {
        synchronized(this) {
            running?.cancel()
            running = scope.launch { run() }
        }
    }

    /** What waits. For tests. */
    suspend fun waiting(): Map<String, PendingDeviceRevoke> = lock.withLock { load() }

    /** Returns once a pass with nothing left to retry has ended. For tests. */
    suspend fun awaitIdle() {
        while (true) {
            val job = synchronized(this) { running } ?: return
            job.join()
            if (synchronized(this) { running } === job) return
        }
    }

    private suspend fun run() {
        var attempt = 0
        while (true) {
            val items = lock.withLock { load() }
            if (items.isEmpty()) return
            for ((id, value) in items.entries.sortedBy { it.value.queuedAt }) {
                val done = now() - value.queuedAt > EXPIRY_MILLIS || inUse(value.credentials.deviceToken) || send(value)
                // Only the exact one sent: a newer one under the same id meanwhile stays.
                if (done) withContext(NonCancellable) { lock.withLock { load().let { if (it[id] == value) save(it - id) } } }
            }
            if (lock.withLock { load() }.isEmpty()) return
            attempt += 1
            delay(backoffMillis(attempt))
        }
    }

    /** True once the agent has answered for good. */
    private suspend fun send(value: PendingDeviceRevoke): Boolean = withContext(Dispatchers.IO) {
        val transport = makeTransport(value.credentials)
        try {
            withTimeoutOrNull(attemptTimeoutMillis) {
                transport.request("DELETE", PATH, value.credentials.deviceToken).status
            }?.let(::final) ?: false
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        } finally {
            withContext(NonCancellable) { transport.close() }
        }
    }

    /** Holding [lock]. A locked or unreadable store reads as nothing waiting until it can be read. */
    private suspend fun load(): Map<String, PendingDeviceRevoke> {
        loaded?.let { return it }
        val read = withContext(Dispatchers.IO) {
            try {
                store.getItem(KEY)?.let { json.decodeFromString<Map<String, PendingDeviceRevoke>>(it) } ?: emptyMap()
            } catch (_: Exception) {
                null
            }
        } ?: return emptyMap()
        loaded = read
        return read
    }

    /** Holding [lock]. */
    private suspend fun save(next: Map<String, PendingDeviceRevoke>) {
        loaded = next
        withContext(Dispatchers.IO) {
            if (next.isEmpty()) store.deleteItem(KEY) else store.setItem(KEY, json.encodeToString(next))
        }
    }

    companion object {
        const val PATH = "/v0/mobile-connector/device"
        /** Its own encrypted store, apart from the connections' credentials. */
        const val PREFS = "agent-device-revokes"
        const val KEYCHAIN_SERVICE = "agent-device-revoke"
        private const val KEY = "pending"
        private const val EXPIRY_MILLIS = 30L * 24 * 60 * 60 * 1000
        private val json = Json { ignoreUnknownKeys = true }

        /** Whether [status] ends the revocation: gone (2xx, 401) or refused for good (403 from an older daemon, any 4xx but 408 and 429). */
        fun final(status: Int): Boolean = status in 200..299 || (status in 400..499 && status != 408 && status != 429)
    }
}
