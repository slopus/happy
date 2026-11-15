package com.slopus.happy.connection

import kotlinx.coroutines.*

/** Blocking Tailcat IO; kept separate so the real HTTP exchange can run against fake TCP. */
internal interface HttpFlow {
    fun read(maximumBytes: Int, timeoutMillis: Long): ByteArray
    fun write(bytes: ByteArray, timeoutMillis: Long)
    fun close()
    fun abort()
}

/** iOS HTTP1.IdleFlows: four newest flows, watched for peer close/data or fifty seconds. */
internal class IdleFlows(private val idleMillis: Long = 50_000) {
    private class Entry(val flow: HttpFlow) {
        lateinit var watch: Job
        val open = CompletableDeferred<Boolean>()
    }
    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val entries = mutableListOf<Entry>()
    private var dropped = 0
    private var shut = false
    val count: Int get() = synchronized(lock) { entries.size }
    val epoch: Int get() = synchronized(lock) { dropped }

    fun put(flow: HttpFlow, epoch: Int) {
        val entry = Entry(flow)
        entry.watch = scope.launch(start = CoroutineStart.LAZY) {
            val open = try {
                withTimeout(idleMillis) { runInterruptible { flow.read(1, 0) } }
                false // Any data, including EOF, makes this unsuitable for another response.
            } catch (error: CancellationException) {
                error !is TimeoutCancellationException
            } catch (_: Exception) { false }
            entry.open.complete(open)
            if (!open) evict(entry)
        }
        // Cancellation before the lazy watcher enters its body means no read took place.
        entry.watch.invokeOnCompletion { entry.open.complete(true) }
        val closing = synchronized(lock) {
            if (shut || epoch != dropped) entry else {
                entries += entry
                if (entries.size > 4) entries.removeAt(0) else null
            }
        }
        closing?.let(::close)
        entry.watch.start()
    }

    suspend fun take(): HttpFlow? {
        while (true) {
            val entry = synchronized(lock) { entries.removeLastOrNull() } ?: return null
            try {
                entry.watch.cancelAndJoin()
                if (entry.open.await()) return entry.flow
            } catch (error: CancellationException) {
                close(entry)
                throw error
            }
            entry.flow.close()
        }
    }

    suspend fun warm(count: Int, open: () -> HttpFlow) = coroutineScope {
        val epoch = epoch
        repeat((count - this@IdleFlows.count).coerceAtLeast(0)) {
            launch(Dispatchers.IO) {
                var flow: HttpFlow? = null
                var parked = false
                try {
                    runInterruptible { open().also { flow = it } }
                    put(checkNotNull(flow), epoch)
                    parked = true
                }
                catch (error: CancellationException) { throw error }
                catch (_: Exception) { /* Warming is best effort. */ }
                finally { if (!parked) flow?.close() }
            }
        }
    }

    fun drop() {
        val closing = synchronized(lock) { dropped++; entries.toList().also { entries.clear() } }
        closing.forEach(::close)
    }
    fun shut() {
        synchronized(lock) { shut = true }
        drop()
        scope.cancel()
    }
    private fun evict(entry: Entry) {
        if (synchronized(lock) { entries.remove(entry) }) close(entry)
    }
    private fun close(entry: Entry) { entry.watch.cancel(); entry.flow.close() }
}

/** One retry of a stale kept GET, before the caller considers resetting the tunnel. */
internal suspend fun exchangeHttp(
    pool: IdleFlows,
    method: String,
    head: ByteArray,
    body: ByteArray?,
    timeoutMillis: Long,
    progress: BodyProgress? = null,
    heard: () -> Unit = {},
    open: () -> HttpFlow,
): TransportResponse {
    val epoch = pool.epoch
    suspend fun exchange(flow: HttpFlow, reused: Boolean): TransportResponse {
        var received = 0
        var finished = false
        try {
            val parser = HttpResponseParser()
            val response = runInterruptible(Dispatchers.IO) {
                flow.write(head, if (reused) 5_000 else timeoutMillis)
                if (body != null) {
                    if (progress == null) flow.write(body, timeoutMillis)
                    else progress.write(body) { flow.write(it, timeoutMillis) }
                }
                while (true) {
                    val bytes = flow.read(65536, timeoutMillis)
                    received += bytes.size
                    if (bytes.isNotEmpty()) heard()
                    parser.append(bytes, bytes.isEmpty())?.let { return@runInterruptible it }
                }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }
            currentCoroutineContext().ensureActive()
            if (parser.reusable) pool.put(flow, epoch) else flow.close()
            finished = true
            return response
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            if (reused && received == 0 && method == "GET" && error !is CancellationException) throw StaleFlow()
            throw error
        } finally {
            if (!finished) flow.abort()
        }
    }
    pool.take()?.let { kept ->
        try { return exchange(kept, true) } catch (_: StaleFlow) { /* One fresh GET below. */ }
    }
    var opened: HttpFlow? = null
    try {
        runInterruptible(Dispatchers.IO) { open().also { opened = it } }
    } catch (error: Throwable) {
        opened?.abort()
        throw error
    }
    return exchange(checkNotNull(opened), false)
}

private class StaleFlow : Exception()