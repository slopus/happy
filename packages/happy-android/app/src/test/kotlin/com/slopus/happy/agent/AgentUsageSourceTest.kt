package com.slopus.happy.agent

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AgentUsageSourceTest {
    private fun answer(used: Int) = Json.parseToJsonElement(
        """{"providers":[{"providerId":"a","usage":{"planName":"Pro","windows":{"weekly":{"usedPercent":$used}}}}]}""",
    ).jsonObject

    private fun event(type: String) = AgentEvent(null, type, JsonObject(emptyMap()))

    @Test fun `followed, it reads once and again on usage, configuration and reconnect, and lingers after the last follower`() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        var reads = 0
        val source = AgentUsageSource({ reads += 1; answer(70 + reads) }, events, backgroundScope)
        val first = source.follow()
        runCurrent()
        assertEquals(1, reads)
        assertEquals(71.0, source.usage.value.getValue("a").week!!.usedPercent, 0.0)
        // A second follower doesn't read again.
        val second = source.follow()
        runCurrent()
        assertEquals(1, reads)
        for (type in listOf("provider.usage.updated", "config.updated", AgentEvent.HELLO)) {
            events.emit(event(type))
            runCurrent()
        }
        assertEquals(4, reads)
        events.emit(event("agent.updated"))
        runCurrent()
        assertEquals(4, reads)
        assertEquals(26, source.usage.value.getValue("a").week!!.left)
        first.close()
        second.close()
        // Still following for a while after the last goes.
        advanceTimeBy(AgentUsageSource.LINGER_MS - 1_000)
        events.emit(event("provider.usage.updated"))
        runCurrent()
        assertEquals(5, reads)
        advanceTimeBy(2_000)
        runCurrent()
        events.emit(event("provider.usage.updated"))
        advanceUntilIdle()
        assertEquals(5, reads)
        // Followed again, it reads at once.
        source.follow()
        runCurrent()
        assertEquals(6, reads)
    }
}
