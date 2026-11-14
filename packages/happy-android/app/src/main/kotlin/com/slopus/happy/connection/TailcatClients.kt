package com.slopus.happy.connection

import io.tailcat.NodePrivateKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * What a request to the agent is for. Each category has Tailcat clients
 * of its own ([TailcatClients]) and its own deadline, so a long upload or
 * a broken file client never holds up the event stream or the next call.
 */
enum class RequestCategory {
    /** The event stream: one request that stays open while the agent talks. */
    Realtime,

    /** Ordinary API calls, small JSON both ways. What a request is unless it says. */
    Query,

    /**
     * Bytes: pictures and avatars, attachments and messages that carry
     * images, tool-call media, artifact files; and the in-app browser's
     * sockets, which carry whole pages.
     */
    File,
}

/**
 * One agent connection's Tailcat clients: one for [RequestCategory.Realtime],
 * one for [RequestCategory.Query] and up to [maxFileClients] for
 * [RequestCategory.File], each made on first use. Every connect is made
 * with a node key of its own, fresh each time: the agent and the DERP relay
 * tell clients apart by node key, and a relay keeps one connection per key,
 * dropping the older of two that share one.
 *
 * A file request goes to the file client with the fewest requests in
 * flight; while every one of them is busy, another is made, up to the cap.
 * A failure resets only the client it happened on ([reset] with the
 * [Lease]); the others, the event stream's included, stay.
 *
 * A relay can go dead with nothing said (a NAT rebinding, a handoff on the
 * same interface, a relay box gone): a request with nothing back over its
 * client for [STALL_AFTER_MILLIS], and a stream silent past its heartbeat,
 * have the client checked ([check]: the relay pinged, replaced only if it
 * doesn't answer), at most once every [checkEveryMillis] (iOS's 5a960ac2e).
 * A slow answer on a live client costs a ping.
 */
internal class TailcatClients<C : Any>(
    /** Blocking; any failure is the agent being unreachable. */
    private val connect: (RequestCategory, NodePrivateKey) -> C,
    /** Blocking: it tells the relay. */
    private val disconnect: (C) -> Unit,
    private val maxFileClients: Int = MAX_FILE_CLIENTS,
    private val newKey: () -> NodePrivateKey = { NodePrivateKey.generate() },
    /** Blocking: the relay pinged and replaced only if it doesn't answer, direct paths probed. */
    private val check: (C) -> Unit = {},
    private val checkEveryMillis: Long = CHECK_EVERY_MILLIS,
) {
    /** One client's place: connected, reset and connected again on its own. */
    inner class Slot internal constructor(val category: RequestCategory, val index: Int) {
        internal val connecting = Mutex()
        /** Written under [lock]. */
        @Volatile internal var client: C? = null
        internal val inFlight = AtomicInteger()
        /** When [client] last brought bytes back, or connected. */
        internal val heard = AtomicLong()
        /** When [client] was last checked ([Lease.watch]); guarded by [lock]. */
        internal var checked: Long? = null
    }

    /** A request's hold on one client; [release] once its answer or stream is done. */
    inner class Lease internal constructor(val slot: Slot, val client: C) {
        private val released = AtomicBoolean(false)

        /** Safe to call more than once, from any thread. */
        fun release() {
            if (released.compareAndSet(false, true)) slot.inFlight.decrementAndGet()
        }

        /** Bytes came back over this lease's client. Any thread. */
        fun heard() {
            if (slot.client === client) slot.heard.set(now())
        }

        /**
         * A request going out over this lease's client: unless bytes come back
         * over the client within [quietMillis], it is checked; [repeating],
         * again each time it has been silent that long. Cancel once answered.
         */
        fun watch(quietMillis: Long = STALL_AFTER_MILLIS, repeating: Boolean = false): Job = watch(this, quietMillis, repeating)
    }

    private val lock = Mutex()
    private val slots = mutableListOf<Slot>()
    private var closed = false
    /** Watches and their checks; cancelled by [close]. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** A client for [category], connected; waits while its slot connects. */
    suspend fun lease(category: RequestCategory): Lease {
        val slot = lock.withLock {
            if (closed) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            pick(category).also { it.inFlight.incrementAndGet() }
        }
        try {
            return Lease(slot, client(slot))
        } catch (e: Throwable) {
            slot.inFlight.decrementAndGet()
            throw e
        }
    }

    /** Under [lock]. */
    private fun pick(category: RequestCategory): Slot {
        val own = slots.filter { it.category == category }
        val limit = if (category == RequestCategory.File) maxFileClients else 1
        val idlest = own.minByOrNull { it.inFlight.get() }
        if (idlest != null && (idlest.inFlight.get() == 0 || own.size >= limit)) return idlest
        return Slot(category, own.size).also { slots += it }
    }

    private suspend fun client(slot: Slot): C = slot.connecting.withLock {
        lock.withLock {
            if (closed) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            slot.client
        }?.let { return@withLock it }
        val made = try {
            runInterruptible(Dispatchers.IO) { connect(slot.category, newKey()) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        }
        // Closed while it connected: nobody will close it later.
        val kept = lock.withLock { if (closed) null else made.also { slot.client = it; slot.heard.set(now()) } }
        kept ?: run {
            closeOffMain(made)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        }
    }

    private fun watch(lease: Lease, quietMillis: Long, repeating: Boolean): Job {
        val start = now()
        return scope.launch {
            var since = start
            while (true) {
                delay(since + quietMillis - now())
                val slot = lease.slot
                val (due, heard) = lock.withLock {
                    if (closed || slot.client !== lease.client) return@launch
                    val heard = slot.heard.get().takeIf { it > since }
                    val due = heard == null && slot.checked.let { it == null || now() - it >= checkEveryMillis }
                    if (due) slot.checked = now()
                    due to heard
                }
                if (due) {
                    try {
                        check(lease.client)
                    } catch (_: Exception) {
                        // Closed meanwhile: its next request connects again.
                    }
                }
                if (!repeating) return@launch
                since = heard ?: now()
            }
        }
    }

    /** Lets go of [lease]'s client after a failure on it, if its slot still holds it; the next request there connects again. */
    suspend fun reset(lease: Lease) {
        val old = lock.withLock { lease.slot.client.takeIf { it === lease.client }?.also { lease.slot.client = null } }
        old?.let { closeOffMain(it) }
    }

    /** Lets go of every client of [category]; the other categories' stay. */
    suspend fun reset(category: RequestCategory) {
        val old = lock.withLock { slots.filter { it.category == category }.mapNotNull { slot -> slot.client.also { slot.client = null } } }
        old.forEach { closeOffMain(it) }
    }

    /** Closes every client; nothing connects again. */
    suspend fun close() {
        scope.cancel()
        val old = lock.withLock {
            closed = true
            slots.mapNotNull { slot -> slot.client.also { slot.client = null } }
        }
        old.forEach { closeOffMain(it) }
    }

    /** How many places [category] has, connected or not. */
    internal suspend fun count(category: RequestCategory): Int = lock.withLock { slots.count { it.category == category } }

    /** Connected clients only; no reservations or empty slots, and no connect as a side effect. */
    internal suspend fun connected(): List<Pair<RequestCategory, C>> = lock.withLock {
        slots.mapNotNull { slot -> slot.client?.let { slot.category to it } }
    }

    /** Closing a client tells the relay, which is network I/O: never on the caller's (maybe main) thread. */
    private suspend fun closeOffMain(client: C) = withContext(NonCancellable + Dispatchers.IO) {
        try {
            disconnect(client)
        } catch (_: Exception) {
            // Already gone.
        }
    }

    companion object {
        /** File clients one agent connection may have up at once. */
        const val MAX_FILE_CLIENTS = 8

        /** How long a request may go with nothing back over its client before the client is checked. */
        const val STALL_AFTER_MILLIS = 3_000L

        /** A client is checked at most this often, however many of its requests stall. */
        const val CHECK_EVERY_MILLIS = 5_000L

        /** The event stream's silence before its client is checked: the agent's heartbeat comes every 15 s. */
        const val STREAM_QUIET_MILLIS = 20_000L

        private fun now(): Long = System.nanoTime() / 1_000_000
    }
}
