package com.slopus.happy.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

/**
 * happy-app's InvalidateSync: [invalidate] asks for a run; requests that
 * arrive while one is running collapse into a single follow-up run. A
 * failed run is retried with exponential backoff until it succeeds or
 * [scope] is cancelled.
 */
class InvalidateSync(
    scope: CoroutineScope,
    private val minDelayMs: Long = 1_000,
    private val maxDelayMs: Long = 30_000,
    private val command: suspend () -> Unit,
) {
    private val requests = Channel<Unit>(Channel.CONFLATED)
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
    }

    /** Asks for a run and waits until one that started after this call has succeeded. */
    suspend fun invalidateAndAwait() {
        val request = requested.incrementAndGet()
        requests.trySend(Unit)
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
        var wait = minDelayMs
        while (true) {
            try {
                command()
                return
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                delay(wait)
                wait = (wait * 2).coerceAtMost(maxDelayMs)
            }
        }
    }
}
