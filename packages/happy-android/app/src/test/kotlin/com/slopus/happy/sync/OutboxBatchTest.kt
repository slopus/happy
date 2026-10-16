package com.slopus.happy.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.data.SessionRecord
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The outbox posts at most 100 messages at a time (v3SessionRoutes.ts sendMessagesBodySchema), in order. */
@RunWith(AndroidJUnit4::class)
class OutboxBatchTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server
    private val store get() = h.store

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addSession("s1", updatedAt = 100)
    }

    @After
    fun tearDown() = h.close()

    @Test
    fun twoHundredAndFiftyQueuedGoOutInThreePostsInOrder() {
        store.upsertSessions(listOf(SessionRecord(
            id = "s1", seq = 0, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
            metadataJson = """{"path":"/repo","host":"mac"}""", metadataVersion = 1, agentStateJson = null, agentStateVersion = 0,
            wrappedDataKey = "unused", projectId = null,
        )))
        val cipher = server.encryption.dataKeyCipher(server.dataKey("s1"))
        val ids = (1..250).map { "m%03d".format(it) }
        store.enqueueOutbox(ids.map { id ->
            OutboxRecord(
                localId = id, sessionId = "s1", kind = OutboxKind.USER, recordJson = "{}",
                content = cipher.encryptToBase64(MessageSender.userRecord(id, "android", SendOptions())),
                createdAt = 1, state = OutboxState.QUEUED, attempts = 0, error = null, serverId = null, serverSeq = null,
            )
        })

        h.startAndSync()
        eventually(timeoutMs = 10_000, message = "all sent") { server.sentRecords("s1").size == 250 }
        assertEquals(ids, server.sentRecords("s1").map { it.first })
        val posts = server.requestsTo("/v3/sessions/s1/messages").filter { it.method == "POST" }
        assertEquals(3, posts.size)
        eventually(message = "none failed") { store.outbox("s1").none { it.state == OutboxState.FAILED } }
    }
}
