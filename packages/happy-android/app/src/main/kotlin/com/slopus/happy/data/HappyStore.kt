package com.slopus.happy.data

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** A JSON document and the server version it was read at. */
data class VersionedJson(val value: JsonObject, val version: Long)

/**
 * Typed access to [HappyDatabase]. Calls block; run them off the main
 * thread. Every write runs in a transaction, and [transaction] groups several
 * into one. [changes] ticks once per committed outermost transaction, so a
 * screen can re-query whenever the data it shows may have changed.
 */
class HappyStore(private val helper: SQLiteOpenHelper) {
    private val db: SQLiteDatabase get() = helper.writableDatabase

    private val changeCount = MutableStateFlow(0L)
    val changes: StateFlow<Long> = changeCount.asStateFlow()

    fun <T> transaction(block: () -> T): T {
        val db = db
        val outermost = !db.inTransaction()
        db.beginTransactionNonExclusive()
        try {
            val result = block()
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
            if (outermost) changeCount.update { it + 1 }
        }
    }

    // Sync watermarks

    fun cursor(key: String): Long? =
        db.rawQuery("SELECT value FROM sync_state WHERE key = ?", arrayOf(key)).use { c ->
            if (c.moveToFirst()) c.getLong(0) else null
        }

    fun setCursor(key: String, value: Long) = transaction {
        db.insertWithOnConflict(
            "sync_state",
            null,
            ContentValues().apply {
                put("key", key)
                put("value", value)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    // Sessions

    /**
     * Inserts new sessions and updates known ones, unless the stored copy is
     * newer (a live update can land before a slower page). The local
     * message watermark is never touched here.
     */
    fun upsertSessions(records: List<SessionRecord>) = transaction {
        for (record in records) {
            val values = ContentValues().apply {
                put("id", record.id)
                put("seq", record.seq)
                put("created_at", record.createdAt)
                put("updated_at", record.updatedAt)
                put("active", record.active)
                put("active_at", record.activeAt)
                put("metadata", record.metadataJson)
                put("metadata_version", record.metadataVersion)
                put("agent_state", record.agentStateJson)
                put("agent_state_version", record.agentStateVersion)
                put("data_key", record.wrappedDataKey)
                put("project_id", record.projectId)
            }
            // No UPSERT: it needs SQLite 3.24 (API 30), and INSERT OR REPLACE
            // would delete the row and cascade to its messages.
            val updated = db.update("sessions", values, "id = ? AND updated_at <= ?", arrayOf(record.id, record.updatedAt.toString()))
            if (updated == 0) db.insertWithOnConflict("sessions", null, values, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    fun deleteSessions(ids: Collection<String>) = transaction {
        ids.forEach { db.delete("sessions", "id = ?", arrayOf(it)) }
    }

    /** Drops every session not in [ids]: what a full listing reveals was deleted elsewhere. */
    fun retainSessions(ids: Set<String>) = transaction {
        deleteSessions(sessionIds() - ids)
    }

    fun sessionIds(): Set<String> =
        db.rawQuery("SELECT id FROM sessions", null).use { c ->
            buildSet { while (c.moveToNext()) add(c.getString(0)) }
        }

    /** Most recently updated first. */
    fun sessions(): List<SessionRecord> =
        db.rawQuery("SELECT $SESSION_COLUMNS FROM sessions ORDER BY updated_at DESC", null).use { c ->
            buildList { while (c.moveToNext()) add(c.toSession()) }
        }

    fun session(id: String): SessionRecord? =
        db.rawQuery("SELECT $SESSION_COLUMNS FROM sessions WHERE id = ?", arrayOf(id)).use { c ->
            if (c.moveToFirst()) c.toSession() else null
        }

    /** Sessions the server has messages for that this device has not stored: id to the last seq it has. */
    fun sessionsBehind(): List<Pair<String, Long>> =
        db.rawQuery("SELECT id, messages_seq FROM sessions WHERE seq > messages_seq ORDER BY updated_at DESC", null).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0) to c.getLong(1)) }
        }

    // Messages

    fun messagesSeq(sessionId: String): Long =
        db.rawQuery("SELECT messages_seq FROM sessions WHERE id = ?", arrayOf(sessionId)).use { c ->
            if (c.moveToFirst()) c.getLong(0) else 0L
        }

    /**
     * Stores a page of messages and moves the session's watermark past them,
     * in one transaction. Messages of an unknown session are dropped.
     */
    fun insertMessages(sessionId: String, messages: List<MessageRecord>) = transaction {
        if (messages.isEmpty() || session(sessionId) == null) return@transaction
        for (message in messages) {
            db.insertWithOnConflict(
                "messages",
                null,
                ContentValues().apply {
                    put("session_id", sessionId)
                    put("seq", message.seq)
                    put("id", message.id)
                    put("local_id", message.localId)
                    put("content", message.contentJson)
                    put("created_at", message.createdAt)
                    put("updated_at", message.updatedAt)
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
        }
        markMessagesSynced(sessionId, messages.maxOf { it.seq })
    }

    /** Moves a session's message watermark forward (never back). */
    fun markMessagesSynced(sessionId: String, seq: Long) = transaction {
        db.execSQL("UPDATE sessions SET messages_seq = MAX(messages_seq, ?) WHERE id = ?", arrayOf<Any>(seq, sessionId))
    }

    /** The newest [limit] messages of a session, oldest first. */
    fun messages(sessionId: String, limit: Int = Int.MAX_VALUE): List<MessageRecord> =
        db.rawQuery(
            "SELECT * FROM (SELECT $MESSAGE_COLUMNS FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
            arrayOf(sessionId, limit.toString()),
        ).use { c -> buildList { while (c.moveToNext()) add(c.toMessage()) } }

    // Machines

    /** `/v1/machines` always returns the whole list, so the table is replaced with it. */
    fun replaceMachines(records: List<MachineRecord>) = transaction {
        db.delete("machines", null, null)
        for (record in records) {
            db.insert(
                "machines",
                null,
                ContentValues().apply {
                    put("id", record.id)
                    put("seq", record.seq)
                    put("created_at", record.createdAt)
                    put("updated_at", record.updatedAt)
                    put("active", record.active)
                    put("active_at", record.activeAt)
                    put("metadata", record.metadataJson)
                    put("metadata_version", record.metadataVersion)
                    put("daemon_state", record.daemonStateJson)
                    put("daemon_state_version", record.daemonStateVersion)
                    put("data_key", record.wrappedDataKey)
                },
            )
        }
    }

    fun machines(): List<MachineRecord> =
        db.rawQuery("SELECT $MACHINE_COLUMNS FROM machines ORDER BY active_at DESC", null).use { c ->
            buildList { while (c.moveToNext()) add(c.toMachine()) }
        }

    // Account documents

    /** Settings as the server last confirmed them, or null before the first sync. */
    fun settings(): VersionedJson? = document(KEY_SETTINGS)?.let { (value, version) -> VersionedJson(value, version ?: 0) }

    fun saveSettings(settings: JsonObject, version: Long) = putDocument(KEY_SETTINGS, settings, version)

    /** Local settings changes the server has not accepted yet. They win over [settings]. */
    fun pendingSettings(): JsonObject = document(KEY_PENDING_SETTINGS)?.first ?: EMPTY

    fun savePendingSettings(pending: JsonObject) = transaction {
        if (pending.isEmpty()) {
            db.delete("account", "key = ?", arrayOf(KEY_PENDING_SETTINGS))
        } else {
            putDocument(KEY_PENDING_SETTINGS, pending, null)
        }
    }

    /** What the app should act on: server settings with pending changes on top (applySettings). */
    fun effectiveSettings(): JsonObject = JsonObject((settings()?.value ?: EMPTY) + pendingSettings())

    /** Records a local settings change: it applies at once and is uploaded by the next sync. */
    fun changeSettings(delta: JsonObject) = transaction {
        savePendingSettings(JsonObject(pendingSettings() + delta))
    }

    fun profile(): JsonObject? = document(KEY_PROFILE)?.first

    fun saveProfile(profile: JsonObject) = putDocument(KEY_PROFILE, profile, null)

    /** Logout: everything goes, schema stays. */
    fun clearAll() = transaction {
        listOf("messages", "sessions", "machines", "account", "sync_state").forEach { db.delete(it, null, null) }
    }

    private fun document(key: String): Pair<JsonObject, Long?>? =
        db.rawQuery("SELECT value, version FROM account WHERE key = ?", arrayOf(key)).use { c ->
            if (!c.moveToFirst()) return null
            val value = try {
                HappyJson.parseToJsonElement(c.getString(0)).jsonObject
            } catch (_: SerializationException) {
                return null
            } catch (_: IllegalArgumentException) {
                return null
            }
            value to (if (c.isNull(1)) null else c.getLong(1))
        }

    private fun putDocument(key: String, value: JsonObject, version: Long?) = transaction {
        db.insertWithOnConflict(
            "account",
            null,
            ContentValues().apply {
                put("key", key)
                put("value", value.toString())
                put("version", version)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    private companion object {
        const val KEY_SETTINGS = "settings"
        const val KEY_PENDING_SETTINGS = "pending-settings"
        const val KEY_PROFILE = "profile"
        val EMPTY = JsonObject(emptyMap())

        const val SESSION_COLUMNS = "id, seq, created_at, updated_at, active, active_at, metadata, metadata_version, " +
            "agent_state, agent_state_version, data_key, project_id"
        const val MESSAGE_COLUMNS = "session_id, seq, id, local_id, content, created_at, updated_at"
        const val MACHINE_COLUMNS = "id, seq, created_at, updated_at, active, active_at, metadata, metadata_version, " +
            "daemon_state, daemon_state_version, data_key"

        fun Cursor.stringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)

        fun Cursor.toSession() = SessionRecord(
            id = getString(0),
            seq = getLong(1),
            createdAt = getLong(2),
            updatedAt = getLong(3),
            active = getInt(4) != 0,
            activeAt = getLong(5),
            metadataJson = stringOrNull(6),
            metadataVersion = getLong(7),
            agentStateJson = stringOrNull(8),
            agentStateVersion = getLong(9),
            wrappedDataKey = getString(10),
            projectId = stringOrNull(11),
        )

        fun Cursor.toMessage() = MessageRecord(
            sessionId = getString(0),
            seq = getLong(1),
            id = getString(2),
            localId = stringOrNull(3),
            contentJson = stringOrNull(4),
            createdAt = getLong(5),
            updatedAt = getLong(6),
        )

        fun Cursor.toMachine() = MachineRecord(
            id = getString(0),
            seq = getLong(1),
            createdAt = getLong(2),
            updatedAt = getLong(3),
            active = getInt(4) != 0,
            activeAt = getLong(5),
            metadataJson = stringOrNull(6),
            metadataVersion = getLong(7),
            daemonStateJson = stringOrNull(8),
            daemonStateVersion = getLong(9),
            wrappedDataKey = getString(10),
        )
    }
}
