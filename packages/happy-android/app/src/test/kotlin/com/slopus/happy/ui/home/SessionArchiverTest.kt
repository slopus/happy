package com.slopus.happy.ui.home

import com.slopus.happy.agent.Intent
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.agent.MemoryIntentStorage
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.TaskOpResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** iOS a4049a03a's LegacyIntentTests: a Happy account's archive, leave and delete, kept until the account has them. */
class SessionArchiverTest {
    private val scopes = mutableListOf<CoroutineScope>()

    @After
    fun tearDown() = scopes.forEach { it.cancel() }

    /** The account as [SessionOps] answers it: every call is unreachable until [up]. */
    private class Account : SessionActions {
        val calls = CopyOnWriteArrayList<String>()
        @Volatile var up = false
        @Volatile var refuseLeave: String? = null

        override suspend fun kill(sessionId: String) = OpResult(up).also { calls += "kill:$sessionId" }
        override suspend fun archiveOnServer(sessionId: String) = OpResult(up, if (up) null else "offline").also { calls += "archive:$sessionId" }
        override suspend fun delete(sessionId: String) = OpResult(up, if (up) null else "offline").also { calls += "delete:$sessionId" }
        override suspend fun leaveTask(sessionId: String): TaskOpResult {
            calls += "leaveTask:$sessionId"
            return when {
                !up -> TaskOpResult.Unreachable
                refuseLeave != null -> TaskOpResult.Refused(refuseLeave)
                else -> TaskOpResult.Done
            }
        }
    }

    /** A launch: the account's store, its socket, and home's archiver bound to them. */
    private fun launch(account: Account, storage: MemoryIntentStorage, online: MutableStateFlow<Boolean>): SessionArchiver {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return SessionArchiver(account).also { it.bind(scope, IntentOutbox(scope, storage), online) }
    }

    private suspend fun eventually(check: suspend () -> Boolean) {
        withTimeout(5_000) { while (!check()) delay(10) }
    }

    @Test
    fun anArchiveOfflineGoesAtOnceThroughAKillAndIsSentWhenTheAccountIsBack(): Unit = runBlocking {
        val account = Account()
        val storage = MemoryIntentStorage()
        val online = MutableStateFlow(false)
        val first = launch(account, storage, online)

        assertEquals("nothing to say: it stands", ArchiveResult.Archived, first.archive(session("s1")))
        assertEquals(setOf("s1"), first.archiving.value)
        assertEquals(listOf(Intent.ARCHIVE), storage.load().map { it.kind })

        // Killed and opened again, still offline: the row stays out of the list.
        scopes.forEach { it.cancel() }
        val second = launch(account, storage, online)
        eventually { second.archiving.value == setOf("s1") }

        account.up = true
        online.value = true
        eventually { storage.load().isEmpty() }
        assertTrue(account.calls.last() == "kill:s1")
        assertEquals(setOf("s1"), second.archiving.value)
    }

    @Test
    fun aDeleteOfflineIsGoneAtOnceAndAKeptRefusalIsSaidByHome(): Unit = runBlocking {
        val account = Account()
        val storage = MemoryIntentStorage()
        val online = MutableStateFlow(false)
        val archiver = launch(account, storage, online)

        assertEquals(OpResult(true), archiver.delete(session("s2", active = false)))
        assertEquals(setOf("s2"), archiver.deleting.value)
        assertEquals(emptySet<String>(), archiver.archiving.value)

        // A leave kept offline that the machine refuses once the account is back: no screen waits, so home says it.
        archiver.leave(session("t1"))
        assertEquals(setOf("t1"), archiver.archiving.value)
        account.refuseLeave = "Only members may leave"
        account.up = true
        online.value = true
        eventually { archiver.refusal.value != null }
        assertEquals(ArchiveResult.TaskFailed(leave = true, TaskOpResult.Refused("Only members may leave")), archiver.refusal.value)
        assertEquals("its row is back", emptySet<String>(), archiver.archiving.value)
        eventually { storage.load().isEmpty() }
        assertTrue("delete:s2" in account.calls)
        archiver.heard()
        assertNull(archiver.refusal.value)
    }

    @Test
    fun aRefusalWhileTheAccountIsUpIsTheScreensToSay(): Unit = runBlocking {
        val account = Account().apply { up = true; refuseLeave = "No" }
        val archiver = launch(account, MemoryIntentStorage(), MutableStateFlow(true))
        assertEquals(ArchiveResult.TaskFailed(leave = true, TaskOpResult.Refused("No")), archiver.leave(session("t2")))
        assertEquals(emptySet<String>(), archiver.archiving.value)
        delay(100)
        assertNull("the screen said it already", archiver.refusal.value)
    }
}
