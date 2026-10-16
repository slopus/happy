package com.slopus.happy.sync

import com.slopus.happy.testing.cancelAndAwait
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** utils/sync.ts InvalidateSync with time.ts `backoff`: retries 0–1 s apart, at once when asked again. */
class InvalidateSyncTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun tearDown() = scope.cancelAndAwait()

    @Test
    fun theDefaultRetryWaitNeverExceedsOneSecond() {
        repeat(1_000) { assertTrue(InvalidateSync.retryDelay() in 0..InvalidateSync.MAX_RETRY_DELAY_MS) }
    }

    @Test
    fun aFailedRunIsRetriedUntilItSucceeds() = runBlocking {
        val calls = AtomicInteger()
        val sync = InvalidateSync(scope, retryDelayMs = { 10 }) { if (calls.incrementAndGet() < 4) error("down") }
        withTimeout(5_000) { sync.invalidateAndAwait() }
        assertEquals(4, calls.get())
    }

    @Test
    fun anInvalidateDuringTheWaitRetriesAtOnce() = runBlocking {
        val calls = AtomicInteger()
        var down = true
        val sync = InvalidateSync(scope, retryDelayMs = { 60_000 }) { calls.incrementAndGet(); if (down) error("down") }
        sync.invalidate()
        withTimeout(5_000) { while (calls.get() < 1) delay(5) }
        // The outage ends (a reconnect); the next ask must not sit out the minute.
        down = false
        withTimeout(2_000) { sync.invalidateAndAwait() }
        assertTrue(calls.get() >= 2)
    }

    @Test
    fun requestsDuringARunCollapseIntoOneFollowUp() = runBlocking {
        val calls = AtomicInteger()
        val gate = CompletableDeferred<Unit>()
        val sync = InvalidateSync(scope) { if (calls.incrementAndGet() == 1) gate.await() }
        sync.invalidate()
        withTimeout(5_000) { while (calls.get() < 1) delay(5) }
        repeat(5) { sync.invalidate() }
        gate.complete(Unit)
        withTimeout(5_000) { sync.awaitQueue() }
        assertEquals(2, calls.get())
    }
}
