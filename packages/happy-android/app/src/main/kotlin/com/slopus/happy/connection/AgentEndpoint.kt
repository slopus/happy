package com.slopus.happy.connection

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import java.lang.ref.WeakReference

internal sealed interface AgentEndpointAdvertisement {
    data object Unchanged : AgentEndpointAdvertisement
    data class Select(val publicUrl: String?) : AgentEndpointAdvertisement

    companion object {
        fun decode(bytes: ByteArray): AgentEndpointAdvertisement {
            fun invalid(): Nothing = throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
            val root = Json.parseToJsonElement(bytes.decodeToString()) as? JsonObject ?: invalid()
            val config = root["config"] as? JsonObject ?: invalid()
            val api = config["api"]?.let { it as? JsonObject ?: invalid() } ?: return Unchanged
            val value = api["publicUrl"] ?: return Unchanged
            if (value == JsonNull) return Select(null)
            val url = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalid()
            return Select(AgentOrigin.parse(url).value)
        }
    }
}

/** One saved connection's authenticated, durable routing selection. */
internal class AgentEndpoint(
    credentials: AgentConnectionCredentials,
    private val save: suspend (AgentConnectionCredentials) -> Unit,
) {
    data class Snapshot(val credentials: AgentConnectionCredentials, val revision: Long)
    private val lock = Any()
    private val changes = Mutex()
    private var snapshot = Snapshot(credentials, 0)
    private var retired = false
    private val observers = mutableMapOf<UUID, suspend (Long) -> Unit>()

    fun observe(id: UUID, invalidate: suspend (Long) -> Unit): Snapshot = synchronized(lock) {
        if (retired) throw CancellationException("connection removed")
        observers[id] = invalidate
        snapshot
    }

    fun removeObserver(id: UUID) { synchronized(lock) { observers.remove(id) } }

    suspend fun apply(advertisement: AgentEndpointAdvertisement, source: Snapshot) = changes.withLock {
        val next = synchronized(lock) {
            if (retired || snapshot.revision != source.revision || advertisement !is AgentEndpointAdvertisement.Select || advertisement.publicUrl == snapshot.credentials.publicUrl) return@withLock false
            snapshot.credentials.copy(publicUrl = advertisement.publicUrl)
        }
        save(next) // A failed secure-store write leaves the old route selected.
        val (revision, callbacks) = synchronized(lock) {
            if (retired) return@withLock false
            snapshot = Snapshot(next, snapshot.revision + 1)
            snapshot.revision to observers.values.toList()
        }
        callbacks.forEach { it(revision) }
        true
    }

    suspend fun retire() {
        val (revision, callbacks) = synchronized(lock) {
            retired = true
            snapshot = snapshot.copy(revision = snapshot.revision + 1)
            snapshot.revision to observers.values.toList().also { observers.clear() }
        }
        callbacks.forEach { it(revision) }
    }
}

/** Stable references for sync/outbox/browser while the actual route changes. */
internal class AgentEndpointTransport(
    private val endpoint: AgentEndpoint,
    private val make: (AgentConnectionCredentials) -> Transport,
) : Transport {
    private val id = UUID.randomUUID()
    private val lock = Mutex()
    private var selected: Pair<Transport, AgentEndpoint.Snapshot>? = null
    private var closed = false

    private suspend fun current(): Pair<Transport, AgentEndpoint.Snapshot> = lock.withLock {
        if (closed) throw CancellationException("transport closed")
        val reference = WeakReference(this)
        val snapshot = endpoint.observe(id) { revision -> reference.get()?.invalidate(revision) }
        selected?.takeIf { it.second.revision == snapshot.revision }?.let { return@withLock it }
        selected?.first?.close()
        (make(snapshot.credentials) to snapshot).also { selected = it }
    }

    private suspend fun invalidate(revision: Long) {
        val old = lock.withLock {
            selected?.takeIf { it.second.revision < revision }?.also { selected = null }?.first
        }
        old?.close()
    }

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): TransportResponse {
        val (base, snapshot) = current()
        val response = base.request(method, path, credential, body, headers)
        if (method == "GET" && path == "/v0/config" && response.status == 200 && credential == snapshot.credentials.deviceToken) {
            val advertisement = AgentEndpointAdvertisement.decode(response.body)
            val changed = endpoint.apply(advertisement, snapshot)
            if (changed && advertisement == AgentEndpointAdvertisement.Select(null) && snapshot.credentials.tailcatAvailable == false) {
                throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            }
        }
        return response
    }

    override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream =
        current().first.stream(path, credential, headers, silenceMillis)

    override suspend fun socket(): TransportSocket = current().first.socket()
    override suspend fun reset() { lock.withLock { selected?.first }?.reset() }
    override suspend fun close() {
        val old = lock.withLock { closed = true; selected?.first.also { selected = null } }
        endpoint.removeObserver(id)
        old?.close()
    }
}