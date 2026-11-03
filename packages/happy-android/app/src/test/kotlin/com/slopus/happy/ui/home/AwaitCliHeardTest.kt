package com.slopus.happy.ui.home

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An old CLI's first message waits for the session's first heartbeat (its
 * socket is up), then a moment for its startup event; never forever.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AwaitCliHeardTest {
    @Test
    fun waitsForTheFirstHeartbeatThenSettles() = runTest {
        val start = currentTime
        assertTrue(awaitCliHeard({ if (currentTime - start >= 3_000) currentTime else null }))
        assertEquals("3 s to be heard, 1.5 s to settle", 4_500L, currentTime - start)
    }

    @Test
    fun aSessionAlreadyHeardOnlySettles() = runTest {
        val start = currentTime
        assertTrue(awaitCliHeard({ 1L }))
        assertEquals(1_500L, currentTime - start)
    }

    @Test
    fun sendsAnywayWhenNeverHeard() = runTest {
        val start = currentTime
        assertFalse(awaitCliHeard({ null }))
        assertEquals(15_000L, currentTime - start)
    }
}
