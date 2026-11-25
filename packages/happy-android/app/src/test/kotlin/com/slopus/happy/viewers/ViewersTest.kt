package com.slopus.happy.viewers

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ViewersTest {
    private val chat = ViewerTarget.agent("a1")
    private val todo = ViewerTarget.surface("s1")
    private val kirill = Viewer("kirill", here = true, lastSeenAt = 1_000_000)
    private val anna = Viewer("anna", here = false, lastSeenAt = 900_000)
    private val max = Viewer("max", here = false, lastSeenAt = 100_000)

    @Test
    fun tiersFollowHereAndTheLastTenMinutes() {
        val now = 1_000_000L
        assertEquals(ViewerTier.Here, ViewerTier.of(Viewer("u", true, now - 3_600_000), now))
        assertEquals(ViewerTier.Recent, ViewerTier.of(Viewer("u", false, now - 600_000), now))
        assertEquals(ViewerTier.Seen, ViewerTier.of(Viewer("u", false, now - 600_001), now))
        assertEquals(1, ViewerTier.minutesAway(Viewer("u", false, now - 20_000), now))
        assertEquals(4, ViewerTier.minutesAway(Viewer("u", false, now - 299_000), now))
    }

    @Test
    fun theNextRedrawIsTheNextBadgeMinuteOrTheTurnToSeen() {
        val now = 1_000_000L
        assertEquals(1_020_000L, ViewerTier.nextChange(listOf(Viewer("u", false, now - 100_000)), now))
        assertEquals(1_000_001L, ViewerTier.nextChange(listOf(Viewer("u", false, now - 600_000)), now))
        assertEquals(1_010_000L, ViewerTier.nextChange(listOf(Viewer("a", false, now - 590_000), Viewer("b", false, now - 30_000)), now))
        assertNull(ViewerTier.nextChange(listOf(Viewer("u", true, now), Viewer("v", false, now - 700_000)), now))
    }

    private class Backend(var answer: (List<ViewerTarget>) -> Map<ViewerTarget, List<Viewer>>? = { targets -> targets.associateWith { emptyList() } }) : ViewersBackend {
        val calls = mutableListOf<Pair<String, List<ViewerTarget>>>()
        override suspend fun put(streamId: String, targets: List<ViewerTarget>): Map<ViewerTarget, List<Viewer>>? {
            calls += streamId to targets
            return answer(targets)
        }
    }

    private fun TestScope.viewing(viewers: Viewers, target: ViewerTarget): Job = backgroundScope.launch { viewers.view(target) }

    @Test
    fun aViewedTargetIsSentOnceSettledAndItsAnswerShown() = runTest {
        val backend = Backend { mapOf(chat to listOf(anna, kirill)) }
        val viewers = Viewers(backgroundScope, backend)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(Viewers.SETTLE_MILLIS - 1)
        assertEquals(emptyList<Any>(), backend.calls)
        advanceTimeBy(2)
        assertEquals(listOf("st1" to listOf(chat)), backend.calls)
        assertEquals(mapOf(chat to listOf(kirill, anna)), viewers.lists.value)
        assertEquals(ViewersAvailability.Served, viewers.availability.value)
    }

    @Test
    fun itBeatsEveryFifteenSecondsThenSaysNothingIsViewedOnce() = runTest {
        val backend = Backend()
        val viewers = Viewers(backgroundScope, backend)
        viewers.opened("st1")
        val view = viewing(viewers, chat)
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        advanceTimeBy(Viewers.HEARTBEAT_MILLIS + Viewers.SETTLE_MILLIS)
        assertEquals(listOf(listOf(chat), listOf(chat)), backend.calls.map { it.second })
        view.cancel()
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        advanceTimeBy(10 * Viewers.HEARTBEAT_MILLIS)
        assertEquals(listOf(listOf(chat), listOf(chat), emptyList()), backend.calls.map { it.second })
    }

    @Test
    fun leavingOneScreenForAnotherSendsOnlyTheNewOne() = runTest {
        val backend = Backend()
        val viewers = Viewers(backgroundScope, backend)
        viewers.opened("st1")
        val first = viewing(viewers, chat)
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        first.cancel()
        advanceTimeBy(100)
        viewing(viewers, todo)
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        assertEquals(listOf(listOf(chat), listOf(todo)), backend.calls.map { it.second })
    }

    @Test
    fun theNewestEightAreSentNewestFirst() = runTest {
        val backend = Backend()
        val viewers = Viewers(backgroundScope, backend)
        viewers.opened("st1")
        val targets = (1..10).map { ViewerTarget.surface("s$it") }
        targets.forEach { viewing(viewers, it); runCurrent() }
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        assertEquals(targets.reversed().take(8), backend.calls.single().second)
    }

    @Test
    fun framesLandOnTheAnswerInArrivalOrder() = runTest {
        val viewers = Viewers(backgroundScope, Backend { mapOf(chat to listOf(kirill, max)) })
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        viewers.frame("""{"target":{"type":"agent","id":"a1"},"viewer":{"userId":"anna","here":true,"lastSeenAt":1000500}}""")
        viewers.frame("""{"target":{"type":"agent","id":"a1"},"viewer":{"userId":"kirill","here":false,"lastSeenAt":1000600}}""")
        viewers.frame("""{"target":{"type":"surface","id":"elsewhere"},"viewer":{"userId":"max","here":true,"lastSeenAt":1000700}}""")
        viewers.frame("not json")
        assertEquals(
            mapOf(chat to listOf(Viewer("anna", true, 1_000_500), Viewer("kirill", false, 1_000_600), max)),
            viewers.lists.value,
        )
    }

    @Test
    fun aRefusalHidesViewersUntilTheNextStream() = runTest {
        val backend = Backend { null }
        val viewers = Viewers(backgroundScope, backend)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        assertEquals(ViewersAvailability.Refused, viewers.availability.value)
        viewing(viewers, todo)
        advanceTimeBy(5 * Viewers.HEARTBEAT_MILLIS)
        assertEquals(1, backend.calls.size)
        assertEquals(emptyMap<ViewerTarget, List<Viewer>>(), viewers.lists.value)

        backend.answer = { targets -> targets.associateWith { listOf(anna) } }
        viewers.closed()
        viewers.opened("st2")
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        assertEquals("st2" to listOf(todo, chat), backend.calls.last())
        assertEquals(ViewersAvailability.Served, viewers.availability.value)
    }

    @Test
    fun aClosedStreamDropsTheListsAndTheNextOneIsToldAgain() = runTest {
        val backend = Backend { targets -> targets.associateWith { listOf(kirill) } }
        val viewers = Viewers(backgroundScope, backend)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        viewers.closed()
        assertEquals(emptyMap<ViewerTarget, List<Viewer>>(), viewers.lists.value)
        advanceTimeBy(3 * Viewers.HEARTBEAT_MILLIS)
        assertEquals(1, backend.calls.size)
        viewers.opened("st2")
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        assertEquals(listOf("st1" to listOf(chat), "st2" to listOf(chat)), backend.calls)
        assertEquals(ViewersAvailability.Served, viewers.availability.value)
        assertEquals(mapOf(chat to listOf(kirill)), viewers.lists.value)
    }

    @Test
    fun aFailedSendIsTriedAgainAtTheHeartbeat() = runTest {
        var fail = true
        val backend = Backend { targets -> if (fail) throw java.io.IOException("lost") else targets.associateWith { listOf(anna) } }
        val viewers = Viewers(backgroundScope, backend)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(Viewers.SETTLE_MILLIS + 1)
        assertEquals(ViewersAvailability.Unknown, viewers.availability.value)
        fail = false
        advanceTimeBy(Viewers.HEARTBEAT_MILLIS + Viewers.SETTLE_MILLIS)
        assertEquals(2, backend.calls.size)
        assertEquals(mapOf(chat to listOf(anna)), viewers.lists.value)
    }
}
