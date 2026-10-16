package com.slopus.happy.ui.home

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** sync.ts nativeUpdateSync: checked at start and again on every return to the foreground. */
@OptIn(ExperimentalCoroutinesApi::class)
class NativeUpdateCheckTest {
    @Test
    fun checksAtStartAndOnEveryReturnToTheForeground() = runTest(UnconfinedTestDispatcher()) {
        val foreground = MutableStateFlow(true)
        var checks = 0
        val results = mutableListOf<String?>()
        val job = launch { nativeUpdateChecks(foreground) { checks++; if (checks >= 2) "https://play.google.com/x" else null }.collect { results += it } }
        assertEquals(1, checks)
        foreground.value = false
        assertEquals(1, checks)
        foreground.value = true
        assertEquals(2, checks)
        foreground.value = false
        foreground.value = true
        assertEquals(3, checks)
        assertEquals(listOf(null, "https://play.google.com/x", "https://play.google.com/x"), results)
        job.cancel()
    }

    @Test
    fun startingInTheBackgroundStillChecksOnce() = runTest(UnconfinedTestDispatcher()) {
        val foreground = MutableStateFlow(false)
        var checks = 0
        val job = launch { nativeUpdateChecks(foreground) { checks++; null }.collect {} }
        assertEquals(1, checks)
        foreground.value = true
        assertEquals(2, checks)
        job.cancel()
    }

    @Test
    fun aNewerCheckReplacesOneStillRunning() = runTest(UnconfinedTestDispatcher()) {
        val foreground = MutableStateFlow(true)
        val first = CompletableDeferred<String?>()
        var calls = 0
        val results = mutableListOf<String?>()
        val job = launch {
            nativeUpdateChecks(foreground) { if (++calls == 1) first.await() else "url" }.collect { results += it }
        }
        foreground.value = false
        foreground.value = true
        first.complete("stale")
        assertEquals(listOf<String?>("url"), results)
        job.cancel()
    }
}
