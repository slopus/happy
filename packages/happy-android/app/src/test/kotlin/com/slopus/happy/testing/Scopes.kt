package com.slopus.happy.testing

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Cancels a test's scope and waits (at most 5 s) for its work to stop.
 * Work still running after tearDown can fail against the closed database or
 * server; its exception then lands on the next test that uses runTest, as
 * UncaughtExceptionsBeforeTest, far from its cause.
 */
fun CoroutineScope.cancelAndAwait() {
    val job = coroutineContext.job
    runBlocking { withTimeoutOrNull(5_000) { job.cancelAndJoin() } }
}
