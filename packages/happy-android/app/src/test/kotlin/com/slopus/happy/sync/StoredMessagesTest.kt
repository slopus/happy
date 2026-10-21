package com.slopus.happy.sync

import com.slopus.happy.testing.cancelAndAwait
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

/**
 * The batches sync.ts hands to applyMessages with source 'sync': the newest
 * page and each forward page are reported, older history is not.
 */
@RunWith(AndroidJUnit4::class)
class StoredMessagesTest {
    private lateinit var server: FakeHappyServer
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private lateinit var scope: CoroutineScope
    private lateinit var sync: MessageSync
    private val batches = Collections.synchronizedList(mutableListOf<List<Long>>())

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val api = SyncApi(HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test"), server.token)
        sync = MessageSync(api, store, RecordDecoder(server.encryption), scope, Dispatchers.IO, prefetchPauseMs = 0)
        scope.launch(Dispatchers.Unconfined) { sync.stored.collect { batches += it.messages.map { m -> m.seq } } }
    }

    @After
    fun tearDown() {
        scope.cancelAndAwait()
        database.close()
        server.close()
    }

    private fun append(count: Int) = runBlocking {
        repeat(count) { server.appendMessage("s", buildJsonObject { put("n", it) }) }
        store.upsertSessions(listOfNotNull(RecordDecoder(server.encryption).session(server.sessions.single())))
    }

    @Test
    fun reportsTheNewestAndForwardPagesButNotOlderHistory() = runBlocking {
        server.addSession("s", updatedAt = 100)
        append(102)
        sync.catchUp("s")
        yield()
        assertEquals(listOf((3L..102L).toList()), batches.toList())

        append(2)
        sync.catchUp("s")
        sync.loadOlder("s")
        yield()
        assertEquals(listOf((3L..102L).toList(), listOf(103L, 104L)), batches.toList())
    }

    @Test
    fun anEmptyBatchIsNotReported() = runBlocking {
        sync.noteStored("s", emptyList())
        yield()
        assertEquals(emptyList<List<Long>>(), batches.toList())
    }
}
