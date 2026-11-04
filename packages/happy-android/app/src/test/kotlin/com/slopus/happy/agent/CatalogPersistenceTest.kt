package com.slopus.happy.agent

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CatalogPersistenceTest {
    @Test
    fun aHomeLoadedBeforeItsCacheWriterStartsIsStillKept() = runTest {
        val home = MutableStateFlow(AgentCatalog(loaded = true, cursor = "already-loaded"))
        val kept = mutableListOf<AgentCatalog>()
        backgroundScope.launch { home.cacheSnapshots().collect { kept += it } }
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(home.value), kept)
    }

    @Test
    fun anUnloadedSeedNeverReplacesTheKeptHome() = runTest {
        val home = MutableStateFlow(AgentCatalog())
        val kept = mutableListOf<AgentCatalog>()
        backgroundScope.launch { home.cacheSnapshots().collect { kept += it } }
        runCurrent()
        advanceTimeBy(2_000)
        runCurrent()
        assertTrue(kept.isEmpty())
    }

    @Test
    fun changesKeepOnlyTheLatestSettledLoadedHome() = runTest {
        val home = MutableStateFlow(AgentCatalog())
        val kept = mutableListOf<AgentCatalog>()
        backgroundScope.launch { home.cacheSnapshots().collect { kept += it } }
        runCurrent()
        home.value = AgentCatalog(loaded = true, cursor = "first")
        runCurrent()
        advanceTimeBy(500)
        home.value = home.value.copy(cursor = "latest")
        runCurrent()
        advanceTimeBy(999)
        runCurrent()
        assertTrue("The write waits for a settled snapshot", kept.isEmpty())
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(home.value), kept)
    }
}