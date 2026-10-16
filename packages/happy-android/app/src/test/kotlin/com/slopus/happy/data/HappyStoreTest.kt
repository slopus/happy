package com.slopus.happy.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HappyStoreTest {
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore

    @Before
    fun setUp() {
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
    }

    @After
    fun tearDown() = database.close()

    @Test
    fun upsertKeepsTheNewerCopyAndTheMessageWatermark() {
        store.upsertSessions(listOf(session("a", updatedAt = 10, seq = 3, metadata = """{"v":1}""")))
        store.insertMessages("a", listOf(message("a", 1), message("a", 2)))
        store.upsertSessions(listOf(session("a", updatedAt = 20, seq = 5, metadata = """{"v":2}""")))
        store.upsertSessions(listOf(session("a", updatedAt = 15, seq = 4, metadata = """{"v":stale}""")))

        val stored = store.session("a")!!
        assertEquals(20L, stored.updatedAt)
        assertEquals("""{"v":2}""", stored.metadataJson)
        assertEquals(2L, store.messagesSeq("a"))
        assertEquals(listOf("a" to 2L), store.sessionsBehind())
    }

    @Test
    fun messagesMoveTheWatermarkForwardOnly() {
        store.upsertSessions(listOf(session("a", seq = 10)))
        store.insertMessages("a", listOf(message("a", 4), message("a", 7)))
        assertEquals(7L, store.messagesSeq("a"))
        store.markMessagesSynced("a", 5)
        assertEquals(7L, store.messagesSeq("a"))
        store.markMessagesSynced("a", 10)
        assertEquals(emptyList<Pair<String, Long>>(), store.sessionsBehind())
        assertEquals(listOf(4L, 7L), store.messages("a").map { it.seq })
        assertEquals(listOf(7L), store.messages("a", limit = 1).map { it.seq })
    }

    @Test
    fun messagesOfUnknownSessionsAreDropped() {
        store.insertMessages("ghost", listOf(message("ghost", 1)))
        assertEquals(emptyList<MessageRecord>(), store.messages("ghost"))
    }

    @Test
    fun deletingASessionDeletesItsMessages() {
        store.upsertSessions(listOf(session("a"), session("b")))
        store.insertMessages("a", listOf(message("a", 1)))
        store.retainSessions(setOf("b"))
        assertEquals(setOf("b"), store.sessionIds())
        assertEquals(emptyList<MessageRecord>(), store.messages("a"))
    }

    @Test
    fun sessionsAreListedNewestFirst() {
        store.upsertSessions(listOf(session("old", updatedAt = 1), session("new", updatedAt = 2)))
        assertEquals(listOf("new", "old"), store.sessions().map { it.id })
    }

    @Test
    fun pendingSettingsWinOverServerSettings() {
        assertNull(store.settings())
        store.saveSettings(obj("analyticsOptOut" to false, "viewInline" to true), version = 4)
        store.changeSettings(obj("analyticsOptOut" to true))
        assertEquals(obj("analyticsOptOut" to true), store.pendingSettings())
        assertEquals(obj("analyticsOptOut" to true, "viewInline" to true), store.effectiveSettings())
        assertEquals(4L, store.settings()!!.version)
        store.savePendingSettings(JsonObject(emptyMap()))
        assertEquals(obj("analyticsOptOut" to false, "viewInline" to true), store.effectiveSettings())
    }

    @Test
    fun changesTickOncePerOutermostTransaction() {
        val before = store.changes.value
        store.transaction {
            store.upsertSessions(listOf(session("a")))
            store.setCursor("x", 1)
        }
        assertEquals(before + 1, store.changes.value)
        // Watermarks are bookkeeping nothing displays: writing one wakes no observer.
        store.setCursor("x", 2)
        assertEquals(before + 1, store.changes.value)
        assertEquals(2L, store.cursor("x"))
    }

    @Test
    fun failedTransactionRollsBack() {
        runCatching {
            store.transaction {
                store.upsertSessions(listOf(session("a")))
                error("boom")
            }
        }
        assertEquals(emptySet<String>(), store.sessionIds())
    }

    @Test
    fun clearAllEmptiesEverything() {
        store.upsertSessions(listOf(session("a")))
        store.replaceMachines(listOf(machine("m")))
        store.saveSettings(obj("a" to true), 1)
        store.saveProfile(obj("id" to true))
        store.setCursor("x", 1)
        store.clearAll()
        assertEquals(emptyList<SessionRecord>(), store.sessions())
        assertEquals(emptyList<MachineRecord>(), store.machines())
        assertNull(store.settings())
        assertNull(store.profile())
        assertNull(store.cursor("x"))
    }

    private fun obj(vararg pairs: Pair<String, Boolean>) = JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) })

    private fun session(id: String, updatedAt: Long = 1, seq: Long = 0, metadata: String = "{}") = SessionRecord(
        id = id, seq = seq, createdAt = 1, updatedAt = updatedAt, active = false, activeAt = 1,
        metadataJson = metadata, metadataVersion = 1, agentStateJson = null, agentStateVersion = 0,
        wrappedDataKey = "key", projectId = null,
    )

    private fun message(sessionId: String, seq: Long) = MessageRecord(
        sessionId = sessionId, seq = seq, id = "m$seq", localId = null, contentJson = "{}", createdAt = seq, updatedAt = seq,
    )

    private fun machine(id: String) = MachineRecord(
        id = id, seq = 1, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
        metadataJson = "{}", metadataVersion = 1, daemonStateJson = null, daemonStateVersion = 0, wrappedDataKey = "key",
    )
}
