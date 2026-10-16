package com.slopus.happy.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Every schema version this app has shipped, upgraded to the current one:
 * the data in it survives, and the result is the same schema a fresh
 * install creates (columns, their order and types, and the indexes).
 * HappyStoreSyncTest checks the 1→4 and 3→4 data in more detail.
 */
@RunWith(AndroidJUnit4::class)
class DatabaseMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val files = mutableListOf<File>()

    @After
    fun tearDown() = files.forEach { it.delete() }

    private fun file(name: String) = File(context.cacheDir, "$name-${System.nanoTime()}.db").also { files += it }

    /** The tables as version [version] created them, with one of everything in them. */
    private fun shipped(version: Int): File {
        val file = file("v$version")
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            db.execSQL("CREATE TABLE sync_state (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)")
            val v2Columns = if (version >= 2) ", messages_oldest_seq INTEGER, messages_has_older INTEGER NOT NULL DEFAULT 0, last_message_sent_at INTEGER" else ""
            db.execSQL(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, " +
                    "updated_at INTEGER NOT NULL, active INTEGER NOT NULL, active_at INTEGER NOT NULL, metadata TEXT, " +
                    "metadata_version INTEGER NOT NULL, agent_state TEXT, agent_state_version INTEGER NOT NULL, data_key TEXT NOT NULL, " +
                    "project_id TEXT, messages_seq INTEGER NOT NULL DEFAULT 0$v2Columns)",
            )
            db.execSQL("CREATE INDEX sessions_by_updated ON sessions (updated_at DESC)")
            db.execSQL(
                "CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, seq INTEGER NOT NULL, " +
                    "id TEXT NOT NULL, local_id TEXT, content TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
                    "PRIMARY KEY (session_id, seq)) WITHOUT ROWID",
            )
            db.execSQL(
                "CREATE TABLE machines (id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, " +
                    "updated_at INTEGER NOT NULL, active INTEGER NOT NULL, active_at INTEGER NOT NULL, metadata TEXT, " +
                    "metadata_version INTEGER NOT NULL, daemon_state TEXT, daemon_state_version INTEGER NOT NULL, data_key TEXT NOT NULL)",
            )
            db.execSQL("CREATE TABLE account (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, version INTEGER)")
            if (version >= 2) {
                db.execSQL(
                    "CREATE TABLE outbox (local_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, " +
                        "position INTEGER NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, " +
                        "state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, server_id TEXT, server_seq INTEGER)",
                )
                db.execSQL("CREATE INDEX outbox_by_session ON outbox (session_id, position)")
            }
            if (version >= 3) {
                db.execSQL("CREATE TABLE composer (session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, value TEXT NOT NULL)")
            }

            db.execSQL("INSERT INTO sync_state VALUES ('sessions', 42)")
            val v2Values = if (version >= 2) ", 1, 1, 77" else ""
            db.execSQL("INSERT INTO sessions VALUES ('s', 2, 1, 5, 1, 1, '{\"path\":\"/r\"}', 3, '{\"requests\":{}}', 2, 'key', 'p1', 2$v2Values)")
            db.execSQL("INSERT INTO messages VALUES ('s', 1, 'm1', NULL, '{\"a\":1}', 1, 1), ('s', 2, 'm2', 'l0', '{\"a\":2}', 2, 2)")
            db.execSQL("INSERT INTO machines VALUES ('m', 1, 1, 1, 1, 1, '{\"host\":\"h\"}', 1, NULL, 0, 'mkey')")
            db.execSQL("INSERT INTO account VALUES ('settings', '{\"viewInline\":true}', 9)")
            if (version >= 2) db.execSQL("INSERT INTO outbox VALUES ('l1', 's', 0, 'user', '{}', 'c', 1, 'QUEUED', 0, NULL, NULL, NULL)")
            if (version >= 3) db.execSQL("INSERT INTO composer VALUES ('s', '{\"draft\":\"hi\"}')")
            db.version = version
        }
        return file
    }

    private fun schema(db: SQLiteDatabase): Map<String, List<String>> {
        val tables = db.rawQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'android_%' AND name NOT LIKE 'sqlite_%' ORDER BY name", null)
            .use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
        val columns = tables.associateWith { table ->
            db.rawQuery("PRAGMA table_info($table)", null).use { c ->
                buildList { while (c.moveToNext()) add("${c.getString(1)} ${c.getString(2)} notnull=${c.getInt(3)} default=${c.getString(4)} pk=${c.getInt(5)}") }
            }
        }
        val indexes = db.rawQuery("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name", null)
            .use { c -> buildList { while (c.moveToNext()) add("${c.getString(0)} on ${c.getString(1)}") } }
        return columns + ("indexes" to indexes)
    }

    private fun freshSchema(): Map<String, List<String>> {
        val db = HappyDatabase(context, file("fresh").absolutePath)
        try {
            return schema(db.readableDatabase)
        } finally {
            db.close()
        }
    }

    private fun upgrade(version: Int, check: (HappyStore) -> Unit) {
        val migrated = HappyDatabase(context, shipped(version).absolutePath)
        try {
            assertEquals("schema after $version → ${HappyDatabase.VERSION}", freshSchema(), schema(migrated.readableDatabase))
            val store = HappyStore(migrated)
            val session = store.session("s")!!
            assertEquals("""{"path":"/r"}""", session.metadataJson)
            assertEquals(3L, session.metadataVersion)
            assertEquals("p1", session.projectId)
            assertEquals(listOf(1L, 2L), store.messages("s").map { it.seq })
            assertEquals("l0", store.messages("s").last().localId)
            assertEquals(MessageHistory(true, 1, 2, version >= 2), store.messageHistory("s"))
            assertEquals("mkey", store.machines().single().wrappedDataKey)
            assertEquals(42L, store.cursor("sessions"))
            check(store)
        } finally {
            migrated.close()
        }
    }

    @Test
    fun version1To4KeepsSessionsMessagesMachinesAndCursors() = upgrade(1) { store ->
        assertEquals(emptyList<OutboxRecord>(), store.outbox())
        assertEquals(emptyMap<String, String>(), store.composers())
    }

    @Test
    fun version2To4KeepsTheOutbox() = upgrade(2) { store ->
        assertEquals(77L, store.session("s")!!.lastMessageSentAt)
        assertEquals(listOf("l1" to OutboxState.QUEUED), store.outbox("s").map { it.localId to it.state })
        assertEquals(emptyMap<String, String>(), store.composers())
    }

    @Test
    fun version3To4KeepsTheComposer() = upgrade(3) { store ->
        assertEquals(listOf("l1"), store.outbox("s").map { it.localId })
        assertEquals(mapOf("s" to """{"draft":"hi"}"""), store.composers())
        assertEquals(null, store.session("s")!!.avatarJson)
    }
}
