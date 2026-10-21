package com.slopus.happy.sync

import com.slopus.happy.testing.cancelAndAwait
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * sync.preload.test.ts and sessionMessagePreloader.test.ts: a finger on a
 * session's row loads its newest page, once, before the chat opens.
 */
@RunWith(AndroidJUnit4::class)
class MessagePreloadTest {
    private lateinit var server: FakeHappyServer
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private lateinit var scope: CoroutineScope
    private lateinit var sync: MessageSync
    private val events = Collections.synchronizedList(mutableListOf<StoredMessages>())

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val api = SyncApi(HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test"), server.token)
        sync = MessageSync(api, store, RecordDecoder(server.encryption), scope, Dispatchers.IO, prefetchPauseMs = 0)
        // UNDISPATCHED: subscribed before setUp returns, so no batch can beat the collector.
        scope.launch(start = CoroutineStart.UNDISPATCHED) { sync.stored.collect { events += it } }
    }

    @After
    fun tearDown() {
        scope.cancelAndAwait()
        database.close()
        server.close()
    }

    private fun sessions(vararg ids: String, count: Int = 150) = runBlocking {
        for (id in ids) {
            server.addSession(id, updatedAt = 100)
            repeat(count) { server.appendMessage(id, buildJsonObject { put("n", it + 1) }) }
        }
        val decoder = RecordDecoder(server.encryption)
        store.upsertSessions(server.sessions.mapNotNull(decoder::session))
    }

    private fun gets(id: String) = server.requestsTo("/v3/sessions/$id/messages").filter { it.method == "GET" }

    private fun newestPages(id: String) =
        gets(id).count { it.url.queryParameter("before_seq") == MessageSync.SEQ_BACKWARD_INITIAL_SENTINEL.toString() }

    private fun loaded(id: String) = store.messageHistory(id)?.isLoaded == true

    /** Holds the first newest-page GET of [id] until the returned latch opens. */
    private fun holdNewestPage(id: String): Pair<CountDownLatch, CountDownLatch> {
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.pageOverride = { request ->
            if (request.url.encodedPath == "/v3/sessions/$id/messages" &&
                request.url.queryParameter("before_seq") == MessageSync.SEQ_BACKWARD_INITIAL_SENTINEL.toString() &&
                arrived.count > 0
            ) {
                arrived.countDown()
                release.await(5, TimeUnit.SECONDS)
            }
            null
        }
        return arrived to release
    }

    @Test
    fun aTouchLoadsOneNewestPageWithoutOpeningTheChat() {
        sessions("s")
        sync.preload("s")
        eventually { loaded("s") }
        val get = gets("s").single()
        assertEquals(MessageSync.SEQ_BACKWARD_INITIAL_SENTINEL.toString(), get.url.queryParameter("before_seq"))
        assertEquals("100", get.url.queryParameter("limit"))
        assertEquals((51L..150L).toList(), store.messages("s").map { it.seq })
        assertEquals(emptySet<String>(), sync.viewingSessionIds())
        eventually { events.isNotEmpty() }
        assertEquals(StoredSource.PRELOAD, events.single().source)

        // Stored now: further touches fetch nothing, and no older history was asked for.
        sync.preload("s")
        Thread.sleep(100)
        assertEquals(1, gets("s").size)
    }

    @Test
    fun touchesWhileThePageIsInFlightShareIt() {
        sessions("s")
        val (arrived, release) = holdNewestPage("s")
        sync.preload("s")
        assertTrue(arrived.await(5, TimeUnit.SECONDS))
        sync.preload("s")
        sync.preload("s")
        release.countDown()
        eventually { loaded("s") }
        Thread.sleep(100)
        assertEquals(1, gets("s").size)
    }

    @Test
    fun openingTheChatTakesOverThePageAndAnotherTouchCannotCancelIt() = runBlocking {
        sessions("s", "t")
        val (arrived, release) = holdNewestPage("s")
        sync.preload("s")
        assertTrue(arrived.await(5, TimeUnit.SECONDS))
        val chat = scope.launch { sync.messages("s").collect {} }
        eventually { "s" in sync.viewingSessionIds() }
        sync.preload("t")
        release.countDown()
        eventually { events.any { it.sessionId == "s" && it.source == StoredSource.OPENED } }
        // One newest page, then the chat's catch-up continues forward from it.
        val seqs = gets("s").map { it.url.queryParameter("before_seq") to it.url.queryParameter("after_seq") }
        assertEquals(MessageSync.SEQ_BACKWARD_INITIAL_SENTINEL.toString() to null, seqs.first())
        assertEquals(1, seqs.count { it.second == null && it.first == MessageSync.SEQ_BACKWARD_INITIAL_SENTINEL.toString() })
        assertEquals("150", seqs[1].second)
        eventually { loaded("t") }
        chat.cancel()
    }

    @Test
    fun aTouchOnAnotherRowDropsThePendingPage() {
        sessions("s", "t")
        val (arrived, release) = holdNewestPage("s")
        sync.preload("s")
        assertTrue(arrived.await(5, TimeUnit.SECONDS))
        sync.preload("t")
        release.countDown()
        eventually { loaded("t") }
        Thread.sleep(200)
        assertFalse("an abandoned page is not stored, even if the request finished", loaded("s"))
        assertEquals(emptyList<Long>(), store.messages("s").map { it.seq })
    }

    @Test
    fun anOpenOrStoredChatIsNotPreloaded() = runBlocking {
        sessions("s", "t")
        sync.catchUp("s")
        val chat = scope.launch { sync.messages("t").collect {} }
        eventually { loaded("t") }
        // The open chat keeps paging on its own; a preload would ask for the newest page again.
        sync.preload("s")
        sync.preload("t")
        Thread.sleep(100)
        assertEquals(1, newestPages("s"))
        assertEquals(1, newestPages("t"))
        chat.cancel()
    }

    @Test
    fun aSessionDeletedWhileItsPageLoadsStaysGone() {
        sessions("s")
        val (arrived, release) = holdNewestPage("s")
        sync.preload("s")
        assertTrue(arrived.await(5, TimeUnit.SECONDS))
        store.deleteSessions(listOf("s"))
        release.countDown()
        Thread.sleep(200)
        assertEquals(null, store.session("s"))
        assertEquals(emptyList<Long>(), store.messages("s").map { it.seq })
        assertTrue(events.none { it.sessionId == "s" })
    }

    @Test
    fun aDeletedSessionCancelsItsPreload() {
        sessions("s")
        val (arrived, release) = holdNewestPage("s")
        sync.preload("s")
        assertTrue(arrived.await(5, TimeUnit.SECONDS))
        sync.forget("s")
        release.countDown()
        Thread.sleep(200)
        assertFalse(loaded("s"))
    }

    @Test
    fun aFailedPageIsNotRetried() {
        sessions("s")
        server.failPages += 503
        sync.preload("s")
        eventually { gets("s").size == 1 }
        Thread.sleep(100)
        assertEquals(1, gets("s").size)
        assertFalse(loaded("s"))
        // The next touch tries again; the chat's own catch-up would too.
        sync.preload("s")
        eventually { loaded("s") }
    }
}
