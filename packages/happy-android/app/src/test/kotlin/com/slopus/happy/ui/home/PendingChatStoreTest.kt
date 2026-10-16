package com.slopus.happy.ui.home

import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.PENDING_CHAT_PREFIX
import com.slopus.happy.model.PendingChatStatus
import com.slopus.happy.model.SessionStartRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PendingChatStoreTest {
    private class FakeSessions(
        val known: Set<String> = setOf("anchor"),
        val reply: (String) -> Boolean = { true },
    ) : PendingChatSessions {
        val sent = ArrayList<Pair<String, String>>()
        val drafts = HashMap<String, String>()
        val alerts = ArrayList<String>()

        override suspend fun send(sessionId: String, text: String): Boolean {
            sent += sessionId to text
            if (text == "boom") throw IllegalStateException("Machine is offline")
            return reply(text)
        }
        override fun draft(sessionId: String) = drafts[sessionId]
        override suspend fun writeDraft(sessionId: String, text: String) { drafts[sessionId] = text }
        override fun exists(sessionId: String) = sessionId in known
        override fun alert(message: String) { alerts += message }
    }

    private var ids = 0
    private fun store() = PendingChatStore(clock = { 7 }, newId = { "id${++ids}" })

    /** pendingChats.ts: typing and Send land on the stand-in until its chat arrives; then the chat owns them. */
    @Test
    fun aStandInTakesTheWritingUntilItSettles() {
        val store = store()
        val chat = store.open("anchor", listOf("anchor", "b"))
        assertEquals(PENDING_CHAT_PREFIX + "id1", chat.id)
        assertEquals(7, chat.createdAt)

        store.setDraft(chat.id, "hello")
        store.submit(chat.id, "hello")
        store.submit(chat.id, "  ")
        store.setDraft(chat.id, "more")
        assertEquals(listOf("hello"), store[chat.id]!!.queued)
        assertEquals("more", store[chat.id]!!.draft)

        store.settle(chat.id, "real")
        store.setDraft(chat.id, "ignored")
        store.submit(chat.id, "ignored")
        store.fail(chat.id)
        val settled = store[chat.id]!!
        assertEquals("real", settled.sessionId)
        assertEquals("more", settled.draft)
        assertEquals(PendingChatStatus.Starting, settled.status)

        store.dismiss(chat.id)
        assertNull(store[chat.id])
    }

    @Test
    fun openingAnotherSweepsTheFailedOnes() {
        val store = store()
        val failed = store.open("anchor", emptyList())
        val starting = store.open("anchor", emptyList())
        store.fail(failed.id)
        val third = store.open("anchor", emptyList())
        assertEquals(setOf(starting.id, third.id), store.chats.value.keys)
    }

    /** pendingChatHandover.ts: the queued messages go out in order, then the draft follows them. */
    @Test
    fun theHandoverSendsWhatWaitedThenMovesTheDraft() = runTest {
        val store = store()
        val sessions = FakeSessions()
        val chat = store.open("anchor", emptyList())
        store.submit(chat.id, " one ")
        store.submit(chat.id, "two")
        store.setDraft(chat.id, "still typing")

        PendingChatHandover(store, sessions).handOver(chat.id, "real")
        assertEquals(listOf("real" to "one", "real" to "two"), sessions.sent)
        assertEquals("still typing", sessions.drafts["real"])
        assertEquals("real", store[chat.id]!!.sessionId)
    }

    @Test
    fun aRefusedSendHandsItsTextAndTheRestBackIntoTheDraft() = runTest {
        val store = store()
        val sessions = FakeSessions()
        val chat = store.open("anchor", emptyList())
        listOf("one", "boom", "three").forEach { store.submit(chat.id, it) }
        store.setDraft(chat.id, "draft")

        PendingChatHandover(store, sessions).handOver(chat.id, "real")
        // Nothing is sent after a failure, so "three" never overtakes "boom".
        assertEquals(listOf("one", "boom"), sessions.sent.map { it.second })
        assertEquals("boom\n\nthree\n\ndraft", sessions.drafts["real"])
        assertEquals(listOf("Machine is offline"), sessions.alerts)

        val declined = FakeSessions(reply = { false })
        val other = store.open("anchor", emptyList())
        store.submit(other.id, "x")
        PendingChatHandover(store, declined).handOver(other.id, "real2")
        assertEquals("x", declined.drafts["real2"])
        assertTrue(declined.alerts.isEmpty())
    }

    /** returnPendingChatDraft: the writing goes back in front of the anchor's own draft, once. */
    @Test
    fun aRetiredStartGivesItsWritingBackToTheAnchor() = runTest {
        val store = store()
        val sessions = FakeSessions().apply { drafts["anchor"] = "mine" }
        val handover = PendingChatHandover(store, sessions)
        val chat = store.open("anchor", emptyList())
        store.submit(chat.id, "queued")
        store.setDraft(chat.id, "typed")

        handover.retire(chat.id)
        assertEquals("queued\n\ntyped\n\nmine", sessions.drafts["anchor"])
        assertEquals(PendingChatStatus.Failed, store[chat.id]!!.status)

        handover.retire(chat.id)
        assertEquals("queued\n\ntyped\n\nmine", sessions.drafts["anchor"])

        // An anchor that is gone gets nothing.
        val orphan = FakeSessions(known = emptySet())
        val lost = store.open("anchor", emptyList())
        store.setDraft(lost.id, "text")
        PendingChatHandover(store, orphan).retire(lost.id)
        assertTrue(orphan.drafts.isEmpty())
    }

    /** WorktreeTabStrip `+`: starts run one at a time; each ends in a handover or a retirement. */
    @Test
    fun startsRunInTurnAndLandAsHandoverOrRetirement() = runTest(UnconfinedTestDispatcher()) {
        val store = store()
        val sessions = FakeSessions()
        val gates = ArrayDeque<CompletableDeferred<StartResult>>()
        val started = ArrayList<SessionStartRequest>()
        val failures = ArrayList<String>()
        val starter = PendingChatStarter(
            store, PendingChatHandover(store, sessions), backgroundScope,
            start = { request -> started += request; CompletableDeferred<StartResult>().also(gates::addLast).await() },
            failed = { failures += it },
        )
        val request = SessionStartRequest(NewSessionDraft())
        val first = starter.open("anchor", listOf("anchor"), request)
        val second = starter.open("anchor", listOf("anchor"), request)
        val third = starter.open("anchor", listOf("anchor"), request)
        assertEquals(1, started.size)

        store.submit(first.id, "hi")
        gates.removeFirst().complete(StartResult.Started("s1"))
        assertEquals("s1", store[first.id]!!.sessionId)
        assertEquals(listOf("s1" to "hi"), sessions.sent)
        assertEquals(2, started.size)

        gates.removeFirst().complete(StartResult.Failed("No machine"))
        assertEquals(listOf("No machine"), failures)
        assertEquals(PendingChatStatus.Failed, store[second.id]!!.status)

        gates.removeFirst().complete(StartResult.Abandoned)
        assertEquals(listOf("No machine"), failures)
        assertEquals(PendingChatStatus.Failed, store[third.id]!!.status)
    }
}
