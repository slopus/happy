package com.slopus.happy.onboarding

import com.slopus.happy.agent.AgentEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Onboarding is read again on every event that may move a gate and each time the app comes back, never latching. */
@OptIn(ExperimentalCoroutinesApi::class)
class OnboardingSourceTest {
    private fun event(type: String) = AgentEvent(null, type, JsonObject(emptyMap()))

    @Test
    fun itIsReadOnTheContractsEventsAndOnReturning() {
        val scope = TestScope(StandardTestDispatcher())
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 8)
        val active = MutableStateFlow(false)
        var reads = 0
        var finished = false
        val source = OnboardingSource({ reads++; CloudOnboarding(finished) }, events, active, scope)
        scope.runCurrent()
        assertEquals(0, reads)
        active.value = true
        scope.runCurrent()
        assertEquals(1, reads)
        for (type in listOf("onboarding.updated", "profile.updated", "bot.updated", "config.updated", "plugins.changed", "invite.created", "member.updated", "member.removed", AgentEvent.HELLO)) {
            events.tryEmit(event(type))
            scope.runCurrent()
        }
        assertEquals(10, reads)
        events.tryEmit(event("message.created"))
        scope.runCurrent()
        assertEquals(10, reads)
        // Back from the background: read again; a finished flow turns unfinished when a gate changes.
        finished = true
        active.value = false
        scope.runCurrent()
        active.value = true
        scope.runCurrent()
        assertTrue(source.current.value!!.finished)
        finished = false
        events.tryEmit(event("onboarding.updated"))
        scope.runCurrent()
        assertFalse(source.current.value!!.finished)
    }

    @Test
    fun aFailedReadKeepsWhatWasShownAndNotNowIsKept() {
        val scope = TestScope(StandardTestDispatcher())
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 8)
        var fail = false
        val source = OnboardingSource({ if (fail) error("offline") else CloudOnboarding(false) }, events, MutableStateFlow(true), scope)
        scope.runCurrent()
        assertFalse(source.current.value!!.finished)
        fail = true
        events.tryEmit(event("onboarding.updated"))
        scope.runCurrent()
        assertFalse(source.current.value!!.finished)
        source.took(CloudOnboarding(true))
        assertTrue(source.current.value!!.finished)
        source.putAway()
        assertTrue(source.later.value)
    }
}
