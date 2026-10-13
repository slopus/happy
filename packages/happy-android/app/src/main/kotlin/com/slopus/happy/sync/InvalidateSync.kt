package com.slopus.happy.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

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

    /** True while a run (including its retries) is in progress. */
    val isRunning: StateFlow<Boolean> = running.asStateFlow()

    init {
        scope.launch {
            for (request in requests) {
                running.value = true
                try {
                    runWithBackoff()
                } finally {
                    running.value = false
                }
            }
        }
    }

    fun invalidate() {
        requests.trySend(Unit)
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
