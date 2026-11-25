package com.slopus.happy.viewers

import kotlinx.coroutines.CompletableDeferred
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

    /**
     * The computer's side of the route: each PUT is applied as it arrives
     * ([held]), then answered at once, or held for the test to answer, fail
     * or never answer.
     */
    private class Computer(var people: (ViewerTarget) -> List<Viewer> = { emptyList() }) {
        class Call(val at: Long, val streamId: String, val targets: List<ViewerTarget>, val reply: CompletableDeferred<Map<ViewerTarget, List<Viewer>>?>)
        val calls = mutableListOf<Call>()
        val held = mutableMapOf<String, List<ViewerTarget>>()
        var refuse = false
        var holdReplies = false
        lateinit var clock: () -> Long

        fun answer(targets: List<ViewerTarget>) = targets.associateWith { people(it) }

        val backend = ViewersBackend { streamId, targets ->
            if (refuse) return@ViewersBackend null
            held[streamId] = targets
            val call = Call(clock(), streamId, targets, CompletableDeferred())
            calls += call
            if (holdReplies) call.reply.await() else answer(targets)
        }
        val sent get() = calls.map { it.targets }
    }

    private fun TestScope.store(computer: Computer): Viewers {
        computer.clock = { testScheduler.currentTime }
        return Viewers(backgroundScope, computer.backend, now = { testScheduler.currentTime })
    }

    private fun TestScope.viewing(viewers: Viewers, target: ViewerTarget): Job = backgroundScope.launch { viewers.view(target) }.also { runCurrent() }

    private val settle = Viewers.SETTLE_MILLIS
    private val handoff = Viewers.HANDOFF_MILLIS
    private val beat = Viewers.HEARTBEAT_MILLIS

    @Test
    fun aViewedTargetIsSentOnceSettledAndItsAnswerShown() = runTest {
        val computer = Computer { listOf(anna, kirill) }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle - 1)
        assertEquals(emptyList<Any>(), computer.sent)
        advanceTimeBy(2)
        assertEquals(listOf(listOf(chat)), computer.sent)
        assertEquals(mapOf(chat to listOf(kirill, anna)), viewers.lists.value)
        assertEquals(ViewersAvailability.Served, viewers.availability.value)
    }

    @Test
    fun changesSettleTogetherBeforeTheyAreSent() = runTest {
        val computer = Computer()
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(200)
        viewing(viewers, todo)
        advanceTimeBy(settle - 1)
        assertEquals(emptyList<Any>(), computer.sent)
        advanceTimeBy(2)
        assertEquals(listOf(listOf(todo, chat)), computer.sent)
    }

    @Test
    fun renewalsCountFromTheSendSoASlowAnswerKeepsTheLease() = runTest {
        val computer = Computer().apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        advanceTimeBy(10_000)
        computer.calls.last().reply.complete(computer.answer(listOf(chat)))
        advanceTimeBy(beat - 10_000 + 1)
        assertEquals(listOf(settle, settle + beat), computer.calls.map { it.at })
    }

    @Test
    fun aSendWhoseAnswerWasLostIsStillClearedOnLeaving() = runTest {
        val computer = Computer().apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        val view = viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        computer.calls.last().reply.completeExceptionally(java.io.IOException("answer lost"))
        runCurrent()
        assertEquals(listOf(chat), computer.held["st1"])
        view.cancel()
        computer.holdReplies = false
        advanceTimeBy(handoff + 1)
        assertEquals(listOf(listOf(chat), emptyList()), computer.sent)
        assertEquals(emptyList<ViewerTarget>(), computer.held["st1"])
        advanceTimeBy(10 * beat)
        assertEquals(2, computer.calls.size)
    }

    @Test
    fun aSendStillWaitingForItsAnswerIsClearedOnLeaving() = runTest {
        val computer = Computer().apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        val view = viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        view.cancel()
        advanceTimeBy(handoff + 1)
        assertEquals(listOf(listOf(chat), emptyList()), computer.sent)
        assertEquals(emptyList<ViewerTarget>(), computer.held["st1"])
    }

    @Test
    fun framesThatOvertakeAnAnswerStayOnIt() = runTest {
        val computer = Computer { listOf(kirill) }.apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        viewers.frame("""{"target":{"type":"agent","id":"a1"},"viewer":{"userId":"anna","here":true,"lastSeenAt":1000500}}""")
        viewers.frame("""{"target":{"type":"agent","id":"a1"},"viewer":{"userId":"kirill","here":false,"lastSeenAt":1000600}}""")
        runCurrent()
        computer.calls.single().reply.complete(mapOf(chat to listOf(kirill, anna)))
        runCurrent()
        assertEquals(mapOf(chat to listOf(Viewer("anna", true, 1_000_500), Viewer("kirill", false, 1_000_600))), viewers.lists.value)
    }

    @Test
    fun navigationFramesAndAReconnectInterleaved() = runTest {
        val computer = Computer { listOf(kirill) }.apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        val onChat = viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        // The chat's answer is out when the phone moves to the todo list and the stream drops.
        onChat.cancel()
        viewing(viewers, todo)
        viewers.frame("""{"target":{"type":"agent","id":"a1"},"viewer":{"userId":"anna","here":true,"lastSeenAt":1000500}}""")
        viewers.closed()
        computer.calls.single().reply.complete(computer.answer(listOf(chat)))
        runCurrent()
        assertEquals(emptyMap<ViewerTarget, List<Viewer>>(), viewers.lists.value)
        viewers.opened("st2")
        runCurrent()
        assertEquals("st2" to listOf(todo, chat), computer.calls.last().let { it.streamId to it.targets })
        computer.calls.last().reply.complete(computer.answer(listOf(todo, chat)))
        runCurrent()
        assertEquals(mapOf(todo to listOf(kirill), chat to listOf(kirill)), viewers.lists.value)
        // The chat's handoff runs out: it is cleared, and its list goes.
        advanceTimeBy(handoff + 1)
        assertEquals("st2" to listOf(todo), computer.calls.last().let { it.streamId to it.targets })
        computer.calls.last().reply.complete(computer.answer(listOf(todo)))
        runCurrent()
        assertEquals(mapOf(todo to listOf(kirill)), viewers.lists.value)
        assertEquals(3, computer.calls.size)
    }

    @Test
    fun aNewStreamIsToldAtOnceAndTheOldStreamsAnswerIsDropped() = runTest {
        val computer = Computer { listOf(kirill) }.apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        val old = computer.calls.single()
        viewers.closed()
        viewers.opened("st2")
        runCurrent()
        assertEquals(listOf("st1", "st2"), computer.calls.map { it.streamId })
        assertEquals(settle + 1, computer.calls.last().at)
        old.reply.complete(computer.answer(listOf(chat)))
        runCurrent()
        assertEquals(emptyMap<ViewerTarget, List<Viewer>>(), viewers.lists.value)
        computer.calls.last().reply.complete(mapOf(chat to listOf(anna)))
        runCurrent()
        assertEquals(mapOf(chat to listOf(anna)), viewers.lists.value)
    }

    @Test
    fun aChangeWhileASendIsOutGoesOnceSettledNotAtTheNextHeartbeat() = runTest {
        val computer = Computer().apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        viewing(viewers, todo)
        advanceTimeBy(settle + 1)
        assertEquals(listOf(listOf(chat), listOf(todo, chat)), computer.sent)
        assertEquals(2 * settle + 1, computer.calls.last().at)
    }

    @Test
    fun aClosedStreamDropsWhatItWasStillWaitingFor() = runTest {
        val computer = Computer { listOf(kirill) }.apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        viewers.closed()
        runCurrent()
        computer.calls.single().reply.complete(computer.answer(listOf(chat)))
        advanceTimeBy(3 * beat)
        assertEquals(emptyMap<ViewerTarget, List<Viewer>>(), viewers.lists.value)
        assertEquals(1, computer.calls.size)
    }

    @Test
    fun goingFromOneScreenOfATargetToAnotherNeverSaysItWasLeft() = runTest {
        val computer = Computer { listOf(kirill) }
        val viewers = store(computer)
        viewers.opened("st1")
        val folder = viewing(viewers, todo)
        advanceTimeBy(settle + 1)
        folder.cancel()
        runCurrent()
        // A page's push takes 450 ms before the next one is resumed.
        advanceTimeBy(450)
        viewing(viewers, todo)
        advanceTimeBy(beat - 450 - 2)
        assertEquals(listOf(listOf(todo)), computer.sent)
        assertEquals(mapOf(todo to listOf(kirill)), viewers.lists.value)
    }

    @Test
    fun aTargetLeftForGoodLosesItsListAndIsCleared() = runTest {
        val computer = Computer { listOf(kirill) }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        val other = viewing(viewers, todo)
        advanceTimeBy(settle + 1)
        other.cancel()
        advanceTimeBy(handoff + 1)
        assertEquals(listOf(listOf(todo, chat), listOf(chat)), computer.sent)
        assertEquals(mapOf(chat to listOf(kirill)), viewers.lists.value)
    }

    @Test
    fun theNewestEightAreSentNewestFirst() = runTest {
        val computer = Computer()
        val viewers = store(computer)
        viewers.opened("st1")
        val targets = (1..10).map { ViewerTarget.surface("s$it") }
        targets.forEach { viewing(viewers, it) }
        advanceTimeBy(settle + 1)
        assertEquals(targets.reversed().take(8), computer.sent.single())
    }

    @Test
    fun framesLandOnTheAnswerInArrivalOrder() = runTest {
        val viewers = store(Computer { listOf(kirill, max) })
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        viewers.frame("""{"target":{"type":"agent","id":"a1"},"viewer":{"userId":"anna","here":true,"lastSeenAt":1000500}}""")
        viewers.frame("""{"target":{"type":"agent","id":"a1"},"viewer":{"userId":"kirill","here":false,"lastSeenAt":1000600}}""")
        viewers.frame("""{"target":{"type":"surface","id":"elsewhere"},"viewer":{"userId":"max","here":true,"lastSeenAt":1000700}}""")
        viewers.frame("""{"target":{"type":"vault_file","id":"a1"},"viewer":{"userId":"max","here":true,"lastSeenAt":1000800}}""")
        viewers.frame("not json")
        runCurrent()
        assertEquals(
            mapOf(chat to listOf(Viewer("anna", true, 1_000_500), Viewer("kirill", false, 1_000_600), max)),
            viewers.lists.value,
        )
    }

    @Test
    fun anAnswerEntryThisBuildCantReadIsDroppedAlone() {
        val answer = ViewersWire.answer(kotlinx.serialization.json.Json.parseToJsonElement(
            """{"targets":[
                {"target":{"type":"vault_file","id":"f1"},"viewers":[{"userId":"max","here":true,"lastSeenAt":1}]},
                {"target":{"type":"agent","id":"a1"},"viewers":[{"userId":"kirill","here":true,"lastSeenAt":5},{"userId":"bad"},{"userId":"anna","here":false,"lastSeenAt":4,"device":"phone"}]}
            ]}""",
        ) as kotlinx.serialization.json.JsonObject)
        assertEquals(mapOf(chat to listOf(Viewer("kirill", true, 5), Viewer("anna", false, 4))), answer)
    }

    @Test
    fun aRefusalHoldsForItsStreamAndANewStreamAsksAgain() = runTest {
        val computer = Computer().apply { refuse = true }
        var asked = 0
        val counting = ViewersBackend { id, targets -> asked++; computer.backend.put(id, targets) }
        computer.clock = { testScheduler.currentTime }
        val viewers = Viewers(backgroundScope, counting, now = { testScheduler.currentTime })
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        assertEquals(ViewersAvailability.Refused, viewers.availability.value)
        viewing(viewers, todo)
        viewers.opened("st1")
        advanceTimeBy(5 * beat)
        assertEquals("the same stream said again", 1, asked)
        assertEquals(ViewersAvailability.Refused, viewers.availability.value)
        computer.refuse = false
        viewers.closed()
        viewers.opened("st2")
        runCurrent()
        assertEquals(2, asked)
        assertEquals("st2" to listOf(todo, chat), computer.calls.last().let { it.streamId to it.targets })
        assertEquals(ViewersAvailability.Served, viewers.availability.value)
    }

    @Test
    fun aFailedSendIsTriedAgainSoon() = runTest {
        val computer = Computer { listOf(anna) }.apply { holdReplies = true }
        val viewers = store(computer)
        viewers.opened("st1")
        viewing(viewers, chat)
        advanceTimeBy(settle + 1)
        computer.calls.single().reply.completeExceptionally(java.io.IOException("lost"))
        computer.holdReplies = false
        advanceTimeBy(Viewers.RETRY_MILLIS + 1)
        assertEquals(2, computer.calls.size)
        assertEquals(mapOf(chat to listOf(anna)), viewers.lists.value)
    }
}
