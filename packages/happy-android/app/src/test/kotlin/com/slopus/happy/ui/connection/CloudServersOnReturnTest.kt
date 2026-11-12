package com.slopus.happy.ui.connection

import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudServer
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An invite is a link accepted in the browser: back in the app, the
 * account's servers load again, so the one it added shows up on Join a
 * server, and the first Bootstrap gives way to it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CloudServersOnReturnTest {
    private val acme = CloudServer(id = "s1", name = "acme", url = "https://acme.happy-clusters.com")
    private val beta = CloudServer(id = "s2", name = "beta", url = "https://beta.happy-clusters.com")

    @Test
    fun theServersLoadAgainOnEveryReturnToTheForeground() = runTest(UnconfinedTestDispatcher()) {
        val foreground = MutableStateFlow(true)
        var listed = listOf(acme)
        var loads = 0
        val shown = mutableListOf<List<CloudServer>>()
        val job = launch { serversOnReturn(foreground) { loads++; listed }.collect { shown += it } }
        // The list showing loads its own; already in the foreground is no return.
        assertEquals(0, loads)
        foreground.value = false
        listed = listOf(acme, beta)
        assertEquals(0, loads)
        foreground.value = true
        assertEquals(1, loads)
        assertEquals(listOf(listOf(acme, beta)), shown)
        foreground.value = false
        foreground.value = true
        assertEquals(2, loads)
        job.cancel()
    }

    @Test
    fun aListThatFailsToLoadIsSkipped() = runTest(UnconfinedTestDispatcher()) {
        val foreground = MutableStateFlow(true)
        var fail = true
        val shown = mutableListOf<List<CloudServer>>()
        val job = launch {
            serversOnReturn(foreground) { if (fail) throw CloudException(CloudException.Reason.Unreachable) else listOf(acme) }.collect { shown += it }
        }
        foreground.value = false
        foreground.value = true
        assertTrue(shown.isEmpty())
        fail = false
        foreground.value = false
        foreground.value = true
        assertEquals(listOf(listOf(acme)), shown)
        job.cancel()
    }

    /** The first Bootstrap waits for a return with a server, as CloudCreate does, then gives way to the list. */
    @Test
    fun theFirstBootstrapGivesWayOnceTheAccountHasAServer() = runTest(UnconfinedTestDispatcher()) {
        val foreground = MutableStateFlow(true)
        var listed = emptyList<CloudServer>()
        var gaveWay: List<CloudServer>? = null
        val job = launch { gaveWay = serversOnReturn(foreground) { listed }.first { it.isNotEmpty() } }
        foreground.value = false
        foreground.value = true
        assertEquals(null, gaveWay)
        listed = listOf(acme)
        foreground.value = false
        foreground.value = true
        assertEquals(listOf(acme), gaveWay)
        assertTrue(job.isCompleted)
    }
}
