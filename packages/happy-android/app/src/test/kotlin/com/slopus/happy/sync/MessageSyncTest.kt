package com.slopus.happy.sync

import com.slopus.happy.testing.cancelAndAwait
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HttpStatusException
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * sync.history.spec.ts against the real store: a chat opens on its newest
 * page, catches up forward, and pages back on demand within a background
 * budget. Message contents are irrelevant here; what is checked is which
 * pages are requested and what the stored run becomes.
 */
@RunWith(AndroidJUnit4::class)
class MessageSyncTest {
    private lateinit var server: FakeHappyServer
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private lateinit var scope: CoroutineScope
    private lateinit var sync: MessageSync

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val api = SyncApi(HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test"), server.token)
        sync = MessageSync(api, store, RecordDecoder(server.encryption), scope, Dispatchers.IO, prefetchPauseMs = 0)
    }

    @After
    fun tearDown() {
        scope.cancelAndAwait()
        database.close()
        server.close()
    }

    /** A session with [count] messages, synced as a listing would. */
    private fun session(count: Int) = runBlocking {
        server.addSession("s", updatedAt = 100)
        repeat(count) { server.appendMessage("s", buildJsonObject { put("n", it + 1) }) }
        store.upsertSessions(listOfNotNull(RecordDecoder(server.encryption).session(server.sessions.single())))
    }

    private fun messageRequests() = server.requestsTo("/v3/sessions/s/messages").filter { it.method == "GET" }

    private fun seqs() = store.messages("s").map { it.seq }

    @Test
    fun opensOnTheNewestPageAndReachesOlderRows() = runBlocking {
        session(102)
        sync.catchUp("s")
        assertEquals((3L..102L).toList(), seqs())
        assertEquals("2147483647", messageRequests().single().url.queryParameter("before_seq"))
        assertEquals(true, store.messageHistory("s")!!.hasOlder)

        sync.catchUp("s")
        assertEquals("102", messageRequests().last().url.queryParameter("after_seq"))

        assertTrue(sync.loadOlder("s"))
        assertEquals((1L..102L).toList(), seqs())
        assertFalse(store.messageHistory("s")!!.hasOlder)
        val calls = messageRequests().size
        assertFalse(sync.loadOlder("s"))
        assertEquals(calls, messageRequests().size)
    }

    @Test
    fun keepsTheFiveAttemptBackgroundBudgetWhileExplicitDemandGoesFurther() = runBlocking {
        session(702)
        sync.catchUp("s")
        sync.prefetchOlder("s")
        assertEquals(6, messageRequests().size)
        assertEquals(true, store.messageHistory("s")!!.hasOlder)
        sync.prefetchOlder("s")
        assertEquals(6, messageRequests().size)

        assertTrue(sync.loadOlder("s"))
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
        assertTrue(sync.loadOlder("s"))
        assertEquals(1L, store.messageHistory("s")!!.oldestSeq)
        assertFalse(store.messageHistory("s")!!.hasOlder)
    }

    @Test
    fun aFailedOlderPageClearsLoadingKeepsTheCursorAndCanBeRetried() = runBlocking {
        session(102)
        sync.catchUp("s")
        server.failPages += 503
        val error = runCatching { sync.loadOlder("s") }.exceptionOrNull()
        assertEquals(503, (error as HttpStatusException).status)
        assertEquals(emptySet<String>(), sync.loadingOlder.value)
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
        assertTrue(sync.loadOlder("s"))
        assertEquals(102, seqs().size)
    }

    @Test
    fun reportsCursorProgressTrueOnlyWhenThePageMovedBack() = runBlocking {
        session(202)
        assertFalse("no initial fetch yet", sync.loadOlder("s"))
        sync.catchUp("s")
        assertTrue(sync.loadOlder("s"))
        assertTrue(sync.loadOlder("s"))
        assertFalse(store.messageHistory("s")!!.hasOlder)
        assertFalse(sync.loadOlder("s"))
    }

    @Test
    fun aMissingSessionKeyFailsInsteadOfSilentlyDoingNothing() = runBlocking {
        session(102)
        sync.catchUp("s")
        store.upsertSessions(listOf(store.session("s")!!.copy(wrappedDataKey = "bm90IGEga2V5")))
        val calls = messageRequests().size
        val error = runCatching { sync.loadOlder("s") }.exceptionOrNull()
        assertTrue("$error", error?.message?.contains("encryption not ready") == true)
        assertEquals(true, store.messageHistory("s")!!.hasOlder)
        assertEquals(emptySet<String>(), sync.loadingOlder.value)
        assertEquals(calls, messageRequests().size)
    }

    @Test
    fun aBackwardPageThatDoesNotMoveTheCursorEndsHistory() = runBlocking {
        session(102)
        sync.catchUp("s")
        // A misbehaving server repeats the newest page for every cursor.
        val newest = server.messages.getValue("s").filter { it.seq == 102L || it.seq == 3L }.sortedByDescending { it.seq }
        server.pageOverride = { request -> if (request.url.queryParameter("before_seq") == "3") ApiMessagePage(newest, hasMore = true) else null }
        assertFalse(sync.loadOlder("s"))
        assertFalse(store.messageHistory("s")!!.hasOlder)
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
        val calls = messageRequests().size
        sync.loadOlder("s")
        assertEquals(calls, messageRequests().size)
    }

    @Test
    fun anEmptyBackwardPageEndsHistoryEvenIfItAdvertisesMore() = runBlocking {
        session(102)
        sync.catchUp("s")
        server.pageOverride = { ApiMessagePage(emptyList(), hasMore = true) }
        assertFalse(sync.loadOlder("s"))
        assertFalse(store.messageHistory("s")!!.hasOlder)
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
    }

    @Test
    fun aFailedFirstPageLeavesNothingLoadedAndAnEmptySessionLoads() = runBlocking {
        session(0)
        server.failPages += 503
        assertTrue(runCatching { sync.catchUp("s") }.isFailure)
        assertFalse(store.messageHistory("s")!!.isLoaded)

        sync.catchUp("s")
        val history = store.messageHistory("s")!!
        assertTrue(history.isLoaded)
        assertFalse(history.hasOlder)
        assertEquals(emptyList<Long>(), seqs())
    }

    @Test
    fun collectingMessagesOpensTheChatAndFillsInHistory() = runBlocking {
        session(250)
        val sizes = mutableListOf<Int>()
        withTimeout(10_000) {
            sync.messages("s").first { sizes += it.size; it.size == 250 }
        }
        // Observers may skip a page that landed while they were busy, never see a partial one.
        assertTrue("$sizes", sizes.all { it in setOf(0, 100, 200, 250) } && sizes == sizes.sorted())
        // The last page is stored a moment before its load clears the loading flag: wait for that, not the first value.
        val settled = MessagePaging(isLoaded = true, hasMoreOlder = false, isLoadingOlder = false)
        assertEquals(settled, withTimeout(5_000) { sync.paging("s").first { it == settled } })
    }
}
