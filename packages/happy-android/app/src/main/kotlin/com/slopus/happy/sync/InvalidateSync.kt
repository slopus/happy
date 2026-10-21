package com.slopus.happy.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/**
 * happy-app's InvalidateSync: [invalidate] asks for a run; requests that
 * arrive while one is running collapse into a single follow-up run. A
 * failed run is retried until it succeeds or [scope] is cancelled, after a
 * wait of 0–1 s ([retryDelayMs]; time.ts `backoff` draws uniformly under
 * a ceiling of min + (max − min) / 50 × max(failures, 50), which is its
 * 1 s max from the first failure on, so the wait never grows). An
 * [invalidate] during that wait retries at once: a reconnect or a new send
 * means the cause may be gone.
 */
class InvalidateSync(
    scope: CoroutineScope,
    private val retryDelayMs: () -> Long = ::retryDelay,
    private val command: suspend () -> Unit,
) {
    private val requests = Channel<Unit>(Channel.CONFLATED)
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val running = MutableStateFlow(false)
    private val requested = AtomicLong()
    private val completed = MutableStateFlow(0L)

    /** True while a run (including its retries) is in progress. */
    val isRunning: StateFlow<Boolean> = running.asStateFlow()

    private val job = scope.launch {
        for (request in requests) {
            running.value = true
            // Every request made before this run starts is answered by it.
            val answers = requested.get()
            // Asked for before this run started: answered by it, not a reason to skip a wait.
            wake.tryReceive()
            try {
                runWithBackoff()
                completed.value = maxOf(completed.value, answers)
            } finally {
                running.value = false
            }
        }
    }

    fun invalidate() {
        requested.incrementAndGet()
        requests.trySend(Unit)
        wake.trySend(Unit)
    }

    /** Asks for a run and waits until one that started after this call has succeeded. */
    suspend fun invalidateAndAwait() {
        val request = requested.incrementAndGet()
        requests.trySend(Unit)
        wake.trySend(Unit)
        completed.first { it >= request }
    }

    /** Waits until every run asked for so far has succeeded. */
    suspend fun awaitQueue() {
        val request = requested.get()
        completed.first { it >= request }
    }

    fun cancel() {
        job.cancel()
    }

    private suspend fun runWithBackoff() {
        while (true) {
            try {
                command()
                return
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                withTimeoutOrNull(retryDelayMs()) { wake.receive() }
            }
        }
    }

    companion object {
        const val MAX_RETRY_DELAY_MS = 1_000L

        fun retryDelay(): Long = Random.nextLong(0, MAX_RETRY_DELAY_MS + 1)
    }
}
