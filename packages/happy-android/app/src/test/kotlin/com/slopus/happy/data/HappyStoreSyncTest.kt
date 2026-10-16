package com.slopus.happy.data

import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** The store's merge rules, change tracking and message runs, as live sync relies on them. */
@RunWith(AndroidJUnit4::class)
class HappyStoreSyncTest {
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore

    @Before
    fun setUp() {
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
    }

    @After
    fun tearDown() = database.close()

    private fun session(id: String = "s", metadataVersion: Long = 1, metadata: String = """{"v":$metadataVersion}""", updatedAt: Long = 100, activeAt: Long = 100, active: Boolean = true) =
        SessionRecord(id, seq = 0, createdAt = 1, updatedAt = updatedAt, active = active, activeAt = activeAt, metadataJson = metadata,
            metadataVersion = metadataVersion, agentStateJson = null, agentStateVersion = 0, wrappedDataKey = "key", projectId = null)

    private fun message(seq: Long, localId: String? = null) =
        MessageRecord("s", seq, "m$seq", localId, """{"n":$seq}""", createdAt = 1000 + seq, updatedAt = 1000 + seq)

    @Test
    fun anUnchangedWriteCommitsNothingAndWakesNoObserver() {
        store.upsertSessions(listOf(session()))
        store.insertMessages("s", listOf(message(1)))
        store.saveProfile(kotlinx.serialization.json.buildJsonObject { })
        val before = store.versions.value
        val ticks = store.changes.value

        store.upsertSessions(listOf(session()))
        store.insertMessages("s", listOf(message(1)))
        store.saveProfile(kotlinx.serialization.json.buildJsonObject { })
        store.markMessagesSynced("s", 1)
        store.setCursor("x", 1)

        assertEquals(before, store.versions.value)
        assertEquals(ticks, store.changes.value)
    }

    @Test
    fun anOlderPageDoesNotUndoANewerLiveUpdate() {
        store.upsertSessions(listOf(session(metadataVersion = 3, updatedAt = 500, activeAt = 500, active = false)))
        store.upsertSessions(listOf(session(metadataVersion = 2, updatedAt = 400, activeAt = 400, active = true)))
        val stored = store.session("s")!!
        assertEquals(3L, stored.metadataVersion)
        assertEquals("""{"v":3}""", stored.metadataJson)
        assertEquals(false, stored.active)
        assertEquals(500L, stored.updatedAt)
    }

    @Test
    fun changesAreTrackedPerArea() {
        store.upsertSessions(listOf(session("a"), session("b")))
        val before = store.versions.value
        store.insertMessages("a", listOf(message(1)))
        val after = store.versions.value
        assertEquals(before.sessions, after.sessions)
        assertEquals(before.messages["b"], after.messages["b"])
        assertNotEquals(before.messages["a"], after.messages["a"])

        // Moving updated_at is a session change but not an activity change.
        store.upsertSessions(listOf(session("a", updatedAt = 900)))
        assertEquals(after.sessionActivity, store.versions.value.sessionActivity)
        store.upsertSessions(listOf(session("a", updatedAt = 900, activeAt = 900, active = false)))
        assertNotEquals(after.sessionActivity, store.versions.value.sessionActivity)
    }

    @Test
    fun liveMessagesKeepTheStoredRunContiguous() {
        store.upsertSessions(listOf(session()))
        assertEquals(LiveMessageResult.APPENDED, store.insertLiveMessage("s", message(5)))
        assertEquals(MessageHistory(isLoaded = true, oldestSeq = 5, newestSeq = 5, hasOlder = true), store.messageHistory("s"))
        assertEquals(LiveMessageResult.APPENDED, store.insertLiveMessage("s", message(6)))
        assertEquals(LiveMessageResult.KNOWN, store.insertLiveMessage("s", message(6)))
        assertEquals(LiveMessageResult.GAP, store.insertLiveMessage("s", message(8)))
        assertEquals(listOf(5L, 6L), store.messages("s").map { it.seq })
        assertEquals(8L, store.session("s")!!.seq)
        assertEquals(LiveMessageResult.UNKNOWN_SESSION, store.insertLiveMessage("nope", message(1)))
    }

    @Test
    fun olderPagesExtendTheRunBackwards() {
        store.upsertSessions(listOf(session()))
        store.applyNewestPage("s", listOf(message(9), message(10)), hasOlder = true)
        assertTrue(store.applyOlderPage("s", beforeSeq = 9, messages = listOf(message(8), message(7)), hasMore = true))
        assertEquals(MessageHistory(true, 7, 10, true), store.messageHistory("s"))
        // A page for a cursor that moved meanwhile is not applied.
        assertFalse(store.applyOlderPage("s", beforeSeq = 9, messages = listOf(message(1)), hasMore = false))
        assertEquals(listOf(7L, 8L, 9L, 10L), store.messages("s").map { it.seq })
    }

    @Test
    fun anEmptyMachineListingKeepsKnownMachines() {
        val machine = MachineRecord("m", 1, 1, 1, true, 1, "{}", 1, null, 0, "key")
        store.replaceMachines(listOf(machine))
        store.replaceMachines(emptyList())
        assertEquals(listOf("m"), store.machines().map { it.id })
    }

    @Test
    fun anEchoRetiresItsOutboxRow() {
        store.upsertSessions(listOf(session()))
        store.enqueueOutbox(listOf(outbox("l1"), outbox("l2")))
        store.insertLiveMessage("s", message(1, localId = "l1"))
        assertEquals(listOf("l2"), store.outbox("s").map { it.localId })
    }

    @Test
    fun aSentRowWhoseEchoIsAlreadyStoredGoesAtOnce() {
        store.upsertSessions(listOf(session()))
        store.enqueueOutbox(listOf(outbox("l1"), outbox("l2")))
        store.insertLiveMessage("s", message(1, localId = "l1"))
        store.enqueueOutbox(listOf(outbox("l3")))
        store.markOutboxSent("s", mapOf("l2" to ("srv2" to 2L)))
        val l2 = store.outbox("s").single { it.localId == "l2" }
        assertEquals(OutboxState.SENT, l2.state)
        assertEquals("srv2", l2.serverId)
        store.insertLiveMessage("s", message(2, localId = "l2"))
        assertEquals(listOf("l3"), store.outbox("s").map { it.localId })
    }

    @Test
    fun anInterruptedSendIsQueuedAgain() {
        store.upsertSessions(listOf(session()))
        store.enqueueOutbox(listOf(outbox("l1")))
        store.setOutboxState("s", listOf("l1"), OutboxState.SENDING)
        store.requeueInterruptedSends()
        val row = store.outbox("s").single()
        assertEquals(OutboxState.QUEUED, row.state)
        assertEquals(1, row.attempts)
    }

    @Test
    fun version1DatabasesMigrateAndKeepTheirMessages() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val file = File(context.cacheDir, "v1-${System.nanoTime()}.db")
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            db.execSQL("CREATE TABLE sync_state (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)")
            db.execSQL(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, " +
                    "updated_at INTEGER NOT NULL, active INTEGER NOT NULL, active_at INTEGER NOT NULL, metadata TEXT, " +
                    "metadata_version INTEGER NOT NULL, agent_state TEXT, agent_state_version INTEGER NOT NULL, data_key TEXT NOT NULL, " +
                    "project_id TEXT, messages_seq INTEGER NOT NULL DEFAULT 0)",
            )
            db.execSQL(
                "CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, seq INTEGER NOT NULL, " +
                    "id TEXT NOT NULL, local_id TEXT, content TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
                    "PRIMARY KEY (session_id, seq)) WITHOUT ROWID",
            )
            db.execSQL("CREATE TABLE machines (id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL, active_at INTEGER NOT NULL, metadata TEXT, metadata_version INTEGER NOT NULL, daemon_state TEXT, daemon_state_version INTEGER NOT NULL, data_key TEXT NOT NULL)")
            db.execSQL("CREATE TABLE account (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, version INTEGER)")
            db.execSQL("INSERT INTO sessions VALUES ('s', 2, 1, 1, 1, 1, '{}', 1, NULL, 0, 'key', NULL, 2)")
            db.execSQL("INSERT INTO sessions VALUES ('empty', 0, 1, 1, 1, 1, '{}', 1, NULL, 0, 'key', NULL, 0)")
            db.execSQL("INSERT INTO messages VALUES ('s', 1, 'm1', NULL, '{}', 1, 1), ('s', 2, 'm2', NULL, '{}', 2, 2)")
            db.version = 1
        }
        val migrated = HappyDatabase(context, file.absolutePath)
        try {
            val store = HappyStore(migrated)
            assertEquals(MessageHistory(true, 1, 2, false), store.messageHistory("s"))
            assertEquals(false, store.messageHistory("empty")!!.isLoaded)
            assertEquals(2, store.messages("s").size)
            assertEquals(emptyList<OutboxRecord>(), store.outbox())
            // Through version 3 as well: the composer table is there and bound to sessions.
            store.saveComposer("s", "{}")
            store.saveComposer("missing", "{}")
            assertEquals(mapOf("s" to "{}"), store.composers())
        } finally {
            migrated.close()
            file.delete()
        }
    }

    @Test
    fun version3DatabasesGainTheAvatarColumnsAndKeepEverything() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val file = File(context.cacheDir, "v3-${System.nanoTime()}.db")
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            db.execSQL("CREATE TABLE sync_state (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)")
            db.execSQL(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, " +
                    "updated_at INTEGER NOT NULL, active INTEGER NOT NULL, active_at INTEGER NOT NULL, metadata TEXT, " +
                    "metadata_version INTEGER NOT NULL, agent_state TEXT, agent_state_version INTEGER NOT NULL, data_key TEXT NOT NULL, " +
                    "project_id TEXT, messages_seq INTEGER NOT NULL DEFAULT 0, messages_oldest_seq INTEGER, " +
                    "messages_has_older INTEGER NOT NULL DEFAULT 0, last_message_sent_at INTEGER)",
            )
            db.execSQL(
                "CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, seq INTEGER NOT NULL, " +
                    "id TEXT NOT NULL, local_id TEXT, content TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
                    "PRIMARY KEY (session_id, seq)) WITHOUT ROWID",
            )
            db.execSQL("CREATE TABLE machines (id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL, active_at INTEGER NOT NULL, metadata TEXT, metadata_version INTEGER NOT NULL, daemon_state TEXT, daemon_state_version INTEGER NOT NULL, data_key TEXT NOT NULL)")
            db.execSQL(
                "CREATE TABLE outbox (local_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, " +
                    "position INTEGER NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, " +
                    "state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, server_id TEXT, server_seq INTEGER)",
            )
            db.execSQL("CREATE INDEX outbox_by_session ON outbox (session_id, position)")
            db.execSQL("CREATE TABLE composer (session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, value TEXT NOT NULL)")
            db.execSQL("CREATE TABLE account (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, version INTEGER)")
            db.execSQL("INSERT INTO sessions VALUES ('s', 2, 1, 1, 1, 1, '{}', 1, NULL, 0, 'key', 'p1', 2, 1, 0, 77)")
            db.execSQL("INSERT INTO messages VALUES ('s', 1, 'm1', NULL, '{}', 1, 1), ('s', 2, 'm2', NULL, '{}', 2, 2)")
            db.execSQL("INSERT INTO outbox VALUES ('l1', 's', 0, 'user', '{}', 'c', 1, 'QUEUED', 0, NULL, NULL, NULL)")
            db.execSQL("INSERT INTO composer VALUES ('s', '{\"draft\":\"hi\"}')")
            db.version = 3
        }
        val migrated = HappyDatabase(context, file.absolutePath)
        try {
            val store = HappyStore(migrated)
            val row = store.session("s")!!
            assertEquals("p1", row.projectId)
            assertEquals(77L, row.lastMessageSentAt)
            assertEquals(null, row.avatarJson)
            assertEquals(2, store.messages("s").size)
            assertEquals(listOf("l1"), store.outbox("s").map { it.localId })
            assertEquals(mapOf("s" to "{\"draft\":\"hi\"}"), store.composers())
            store.upsertSessions(listOf(row.copy(avatarJson = "{}", avatarRevision = 3, updatedAt = 2)))
            assertEquals(3L, store.session("s")!!.avatarRevision)
        } finally {
            migrated.close()
            file.delete()
        }
    }

    @Test
    fun anOutOfOrderAvatarNeverReplacesANewerOne() {
        val base = session()
        store.upsertSessions(listOf(base))
        // A live update with revision 3, then a stale live one with revision 2.
        store.upsertSessions(listOf(base.copy(avatarJson = "a3", avatarRevision = 3, avatarUpdateSeq = 10)))
        store.upsertSessions(listOf(base.copy(avatarJson = "a2", avatarRevision = 2, avatarUpdateSeq = 11)))
        assertEquals("a3", store.session("s")!!.avatarJson)
        // A listing taken before revision 3 arrives late.
        store.upsertSessions(listOf(base.copy(avatarJson = "a1", avatarRevision = 1)))
        assertEquals("a3", store.session("s")!!.avatarJson)
        // A listing at the same or a newer revision is the server's word.
        store.upsertSessions(listOf(base.copy(avatarJson = "a4", avatarRevision = 4)))
        assertEquals("a4", store.session("s")!!.avatarJson)
        assertEquals("the last live seq is kept", 10L, store.session("s")!!.avatarUpdateSeq)
        // Without revisions to compare, live updates go by their seq.
        store.upsertSessions(listOf(base.copy(id = "t")))
        val t = base.copy(id = "t")
        store.upsertSessions(listOf(t.copy(avatarJson = "x", avatarUpdateSeq = 20)))
        store.upsertSessions(listOf(t.copy(avatarJson = "older", avatarUpdateSeq = 19)))
        assertEquals("x", store.session("t")!!.avatarJson)
        store.upsertSessions(listOf(t.copy(avatarJson = null, avatarUpdateSeq = 21)))
        assertEquals("a removal is an update too", null, store.session("t")!!.avatarJson)
        // And a listing older than the live change loses to it.
        store.upsertSessions(listOf(t.copy(avatarJson = "listed", updatedAt = 50)))
        assertEquals(null, store.session("t")!!.avatarJson)
    }

    private fun outbox(localId: String) = OutboxRecord(
        localId = localId, sessionId = "s", kind = OutboxKind.USER, recordJson = "{}", content = "c", createdAt = 1,
        state = OutboxState.QUEUED, attempts = 0, error = null, serverId = null, serverSeq = null,
    )
}
