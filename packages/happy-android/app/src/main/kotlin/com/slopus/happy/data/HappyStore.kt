package com.slopus.happy.data

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.slopus.happy.model.StoredSessionAvatar
import com.slopus.happy.model.mergeSessionAvatar
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** A JSON document and the server version it was read at. */
data class VersionedJson(val value: JsonObject, val version: Long)

/**
 * A change counter per area of the store, and per session for its messages
 * and outbox. A counter moves only when a committed transaction actually
 * changed rows in that area, so an observer re-reads exactly when what it
 * shows may differ.
 */
data class StoreVersions(
    val sessions: Long = 0,
    /** Moves only when a session's `active`/`activeAt` changed, or one came or went. */
    val sessionActivity: Long = 0,
    val machines: Long = 0,
    val machineActivity: Long = 0,
    val account: Long = 0,
    val messages: Map<String, Long> = emptyMap(),
    val outbox: Map<String, Long> = emptyMap(),
)

/** What a live `new-message` did to the stored run of a session's messages. */
enum class LiveMessageResult {
    /** Stored, and the run now ends at it. */
    APPENDED,

    /** Already within the stored run (an echo or a replay). */
    KNOWN,

    /** Newer than the next seq: messages in between are missing and must be fetched. */
    GAP,

    /** No such session here. */
    UNKNOWN_SESSION,
}

/**
 * Typed access to [HappyDatabase]. Calls block; run them off the main
 * thread. Every write runs in a transaction, and [transaction] groups several
 * into one.
 *
 * Writes merge instead of overwrite: a session or machine keeps the newer of
 * each versioned field, so a slow page cannot undo a live update, and a write
 * that would change nothing touches no row and wakes no observer. [versions]
 * says what changed; [changes] ticks once per transaction that changed
 * anything.
 */
class HappyStore(private val helper: SQLiteOpenHelper) {
    private val db: SQLiteDatabase get() = helper.writableDatabase

    private val versionState = MutableStateFlow(StoreVersions())
    val versions: StateFlow<StoreVersions> = versionState.asStateFlow()

    private val changeCount = MutableStateFlow(0L)
    val changes: StateFlow<Long> = changeCount.asStateFlow()

    /** Emits whenever a session's stored messages change (and once at start). */
    fun messageChanges(sessionId: String): Flow<Long> =
        versions.map { it.messages[sessionId] ?: 0 }.distinctUntilChanged()

    /** Emits whenever a session's outbox rows change (and once at start). */
    fun outboxChanges(sessionId: String): Flow<Long> =
        versions.map { it.outbox[sessionId] ?: 0 }.distinctUntilChanged()

    private class Dirty {
        var sessions = false
        var sessionActivity = false
        var machines = false
        var machineActivity = false
        var account = false
        val messages = HashSet<String>()
        val outbox = HashSet<String>()
        val isEmpty get() = !sessions && !sessionActivity && !machines && !machineActivity && !account &&
            messages.isEmpty() && outbox.isEmpty()
    }

    private val dirty = ThreadLocal<Dirty?>()

    private fun dirty(): Dirty = checkNotNull(dirty.get()) { "write outside a transaction" }

    fun <T> transaction(block: () -> T): T {
        val db = db
        val outermost = dirty.get() == null
        if (outermost) dirty.set(Dirty())
        db.beginTransactionNonExclusive()
        var committed = false
        try {
            val result = block()
            db.setTransactionSuccessful()
            committed = true
            return result
        } finally {
            db.endTransaction()
            if (outermost) {
                val changed = dirty.get()!!
                dirty.set(null)
                if (committed && !changed.isEmpty) publish(changed)
            }
        }
    }

    private fun publish(changed: Dirty) {
        while (true) {
            val before = versionState.value
            val after = before.copy(
                sessions = before.sessions + if (changed.sessions) 1 else 0,
                sessionActivity = before.sessionActivity + if (changed.sessionActivity) 1 else 0,
                machines = before.machines + if (changed.machines) 1 else 0,
                machineActivity = before.machineActivity + if (changed.machineActivity) 1 else 0,
                account = before.account + if (changed.account) 1 else 0,
                messages = bump(before.messages, changed.messages),
                outbox = bump(before.outbox, changed.outbox),
            )
            if (versionState.compareAndSet(before, after)) break
        }
        changeCount.value = changeCount.value + 1
    }

    private fun bump(counters: Map<String, Long>, keys: Set<String>): Map<String, Long> =
        if (keys.isEmpty()) counters else counters.toMutableMap().apply { keys.forEach { put(it, (get(it) ?: 0) + 1) } }

    // Sync watermarks: bookkeeping, not data anyone displays.

    fun cursor(key: String): Long? =
        db.rawQuery("SELECT value FROM sync_state WHERE key = ?", arrayOf(key)).use { c ->
            if (c.moveToFirst()) c.getLong(0) else null
        }

    fun setCursor(key: String, value: Long) = transaction {
        if (cursor(key) == value) return@transaction
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
     * Inserts new sessions and merges known ones field by field (see
     * [mergeSession]). The local message watermarks are never touched here.
     */
    fun upsertSessions(records: List<SessionRecord>) = transaction {
        for (record in records) {
            val existing = session(record.id)
            val merged = if (existing == null) record.copy(lastMessageSentAt = null) else mergeSession(existing, record)
            if (merged == existing) continue
            val values = ContentValues().apply {
                put("id", merged.id)
                put("seq", merged.seq)
                put("created_at", merged.createdAt)
                put("updated_at", merged.updatedAt)
                put("active", merged.active)
                put("active_at", merged.activeAt)
                put("metadata", merged.metadataJson)
                put("metadata_version", merged.metadataVersion)
                put("agent_state", merged.agentStateJson)
                put("agent_state_version", merged.agentStateVersion)
                put("data_key", merged.wrappedDataKey)
                put("project_id", merged.projectId)
                put("avatar", merged.avatarJson)
                put("avatar_revision", merged.avatarRevision)
                put("avatar_update_seq", merged.avatarUpdateSeq)
            }
            // No UPSERT: it needs SQLite 3.24 (API 30), and INSERT OR REPLACE
            // would delete the row and cascade to its messages.
            if (existing != null) {
                db.update("sessions", values, "id = ?", arrayOf(record.id))
            } else {
                db.insert("sessions", null, values)
            }
            dirty().sessions = true
            if (existing == null || existing.active != merged.active || existing.activeAt != merged.activeAt) dirty().sessionActivity = true
        }
    }

    fun deleteSessions(ids: Collection<String>) = transaction {
        for (id in ids) {
            if (db.delete("sessions", "id = ?", arrayOf(id)) > 0) {
                dirty().sessions = true
                dirty().sessionActivity = true
                dirty().messages += id
                dirty().outbox += id
            }
        }
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

    fun sessionActivity(): List<ActivityRow> =
        db.rawQuery("SELECT id, active, active_at FROM sessions", null).use { c ->
            buildList { while (c.moveToNext()) add(ActivityRow(c.getString(0), c.getInt(1) != 0, c.getLong(2))) }
        }

    fun machineActivity(): List<ActivityRow> =
        db.rawQuery("SELECT id, active, active_at FROM machines", null).use { c ->
            buildList { while (c.moveToNext()) add(ActivityRow(c.getString(0), c.getInt(1) != 0, c.getLong(2))) }
        }

    /** Sessions the server has messages for that this device has not stored: id to the last seq it has. */
    fun sessionsBehind(): List<Pair<String, Long>> =
        db.rawQuery("SELECT id, messages_seq FROM sessions WHERE seq > messages_seq ORDER BY updated_at DESC", null).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0) to c.getLong(1)) }
        }

    /** A message from this device was accepted for the session (storage.ts markSessionMessageSent). */
    fun markMessageSent(sessionId: String, at: Long) = transaction {
        val values = ContentValues().apply { put("last_message_sent_at", at) }
        if (db.update("sessions", values, "id = ?", arrayOf(sessionId)) > 0) dirty().sessions = true
    }

    // Messages

    fun messagesSeq(sessionId: String): Long =
        db.rawQuery("SELECT messages_seq FROM sessions WHERE id = ?", arrayOf(sessionId)).use { c ->
            if (c.moveToFirst()) c.getLong(0) else 0L
        }

    /** The stored run of a session's messages, or null for an unknown session. */
    fun messageHistory(sessionId: String): MessageHistory? =
        db.rawQuery(
            "SELECT messages_oldest_seq, messages_seq, messages_has_older FROM sessions WHERE id = ?",
            arrayOf(sessionId),
        ).use { c ->
            if (!c.moveToFirst()) return null
            if (c.isNull(0)) {
                MessageHistory(isLoaded = false, oldestSeq = 0, newestSeq = c.getLong(1), hasOlder = false)
            } else {
                MessageHistory(isLoaded = true, oldestSeq = c.getLong(0), newestSeq = c.getLong(1), hasOlder = c.getInt(2) != 0)
            }
        }

    /**
     * Stores a forward page (seqs after the stored run) and moves the
     * session's watermark past it, in one transaction. Messages of an unknown
     * session are dropped.
     */
    fun insertMessages(sessionId: String, messages: List<MessageRecord>) = transaction {
        if (messages.isEmpty() || session(sessionId) == null) return@transaction
        writeMessages(sessionId, messages)
        val history = messageHistory(sessionId)!!
        updateHistory(
            sessionId,
            oldest = if (history.isLoaded) history.oldestSeq else messages.minOf { it.seq },
            newest = maxOf(history.newestSeq, messages.maxOf { it.seq }),
            hasOlder = if (history.isLoaded) history.hasOlder else messages.minOf { it.seq } > 1,
        )
    }

    /**
     * Stores a session's newest page, the first one a chat loads. The stored
     * run becomes exactly this page; [hasOlder] says whether the server has
     * more before it.
     */
    fun applyNewestPage(sessionId: String, messages: List<MessageRecord>, hasOlder: Boolean) = transaction {
        val history = messageHistory(sessionId) ?: return@transaction
        writeMessages(sessionId, messages)
        val newest = maxOf(history.newestSeq, messages.maxOfOrNull { it.seq } ?: 0)
        val oldest = messages.minOfOrNull { it.seq } ?: (newest + 1)
        updateHistory(sessionId, oldest = oldest, newest = newest, hasOlder = hasOlder && messages.isNotEmpty())
    }

    /**
     * Stores a page of messages before [beforeSeq], the stored run's oldest.
     * Returns whether the run moved back. A page that does not move it is
     * the end of history, whatever the server says.
     */
    fun applyOlderPage(sessionId: String, beforeSeq: Long, messages: List<MessageRecord>, hasMore: Boolean): Boolean = transaction {
        val history = messageHistory(sessionId) ?: return@transaction false
        if (!history.isLoaded || history.oldestSeq != beforeSeq) return@transaction false
        val older = messages.filter { it.seq < beforeSeq }
        writeMessages(sessionId, older)
        val oldest = older.minOfOrNull { it.seq } ?: beforeSeq
        val advanced = oldest < beforeSeq
        updateHistory(sessionId, oldest = oldest, newest = history.newestSeq, hasOlder = hasMore && advanced)
        advanced
    }

    /**
     * A message from the socket. It is stored only where it keeps the run
     * contiguous: right after the newest stored seq, or as the first message
     * of a session with nothing loaded yet.
     */
    fun insertLiveMessage(sessionId: String, message: MessageRecord): LiveMessageResult = transaction {
        val history = messageHistory(sessionId) ?: return@transaction LiveMessageResult.UNKNOWN_SESSION
        val result = when {
            !history.isLoaded -> {
                writeMessages(sessionId, listOf(message))
                updateHistory(sessionId, oldest = message.seq, newest = message.seq, hasOlder = message.seq > 1)
                LiveMessageResult.APPENDED
            }
            message.seq == history.newestSeq + 1 -> {
                writeMessages(sessionId, listOf(message))
                updateHistory(sessionId, oldest = minOf(history.oldestSeq, message.seq), newest = message.seq, hasOlder = history.hasOlder)
                LiveMessageResult.APPENDED
            }
            message.seq <= history.newestSeq -> {
                if (message.seq >= history.oldestSeq) writeMessages(sessionId, listOf(message))
                LiveMessageResult.KNOWN
            }
            else -> LiveMessageResult.GAP
        }
        // The session row moves with its newest message either way.
        db.rawQuery("SELECT seq, updated_at FROM sessions WHERE id = ?", arrayOf(sessionId)).use { c ->
            c.moveToFirst()
            if (c.getLong(0) < message.seq || c.getLong(1) < message.createdAt) {
                db.execSQL(
                    "UPDATE sessions SET seq = MAX(seq, ?), updated_at = MAX(updated_at, ?) WHERE id = ?",
                    arrayOf<Any>(message.seq, message.createdAt, sessionId),
                )
                dirty().sessions = true
            }
        }
        result
    }

    /** Moves a session's message watermark forward (never back). */
    fun markMessagesSynced(sessionId: String, seq: Long) = transaction {
        val history = messageHistory(sessionId) ?: return@transaction
        if (seq <= history.newestSeq) return@transaction
        updateHistory(
            sessionId,
            oldest = if (history.isLoaded) history.oldestSeq else seq + 1,
            newest = seq,
            hasOlder = if (history.isLoaded) history.hasOlder else seq > 0,
        )
    }

    /** The newest [limit] messages of a session, oldest first. */
    fun messages(sessionId: String, limit: Int = Int.MAX_VALUE): List<MessageRecord> =
        db.rawQuery(
            "SELECT * FROM (SELECT $MESSAGE_COLUMNS FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
            arrayOf(sessionId, limit.toString()),
        ).use { c -> buildList { while (c.moveToNext()) add(c.toMessage()) } }

    private fun updateHistory(sessionId: String, oldest: Long, newest: Long, hasOlder: Boolean) {
        val values = ContentValues().apply {
            put("messages_oldest_seq", oldest)
            put("messages_seq", newest)
            put("messages_has_older", hasOlder)
        }
        val changed = db.update(
            "sessions",
            values,
            "id = ? AND (messages_oldest_seq IS NULL OR messages_oldest_seq != ? OR messages_seq != ? OR messages_has_older != ?)",
            arrayOf(sessionId, oldest.toString(), newest.toString(), if (hasOlder) "1" else "0"),
        )
        if (changed > 0) dirty().messages += sessionId
    }

    /** Writes rows that differ from what is stored, and retires outbox rows their echoes settle. */
    private fun writeMessages(sessionId: String, messages: List<MessageRecord>) {
        if (messages.isEmpty()) return
        val stored = HashMap<Long, MessageRecord>()
        db.rawQuery(
            "SELECT $MESSAGE_COLUMNS FROM messages WHERE session_id = ? AND seq BETWEEN ? AND ?",
            arrayOf(sessionId, messages.minOf { it.seq }.toString(), messages.maxOf { it.seq }.toString()),
        ).use { c -> while (c.moveToNext()) c.toMessage().let { stored[it.seq] = it } }
        for (message in messages) {
            val row = message.copy(sessionId = sessionId)
            if (stored[row.seq] == row) continue
            db.insertWithOnConflict(
                "messages",
                null,
                ContentValues().apply {
                    put("session_id", sessionId)
                    put("seq", row.seq)
                    put("id", row.id)
                    put("local_id", row.localId)
                    put("content", row.contentJson)
                    put("created_at", row.createdAt)
                    put("updated_at", row.updatedAt)
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
            dirty().messages += sessionId
        }
        val echoed = messages.mapNotNull { it.localId }
        for (chunk in echoed.chunked(SQL_PARAMETERS)) {
            val placeholders = chunk.joinToString(",") { "?" }
            val removed = db.delete("outbox", "session_id = ? AND local_id IN ($placeholders)", arrayOf(sessionId) + chunk)
            if (removed > 0) dirty().outbox += sessionId
        }
    }

    // Machines

    /**
     * `/v1/machines` always returns the whole list: machines not in it go,
     * the rest merge. An empty list never wipes known machines; it is almost
     * always a transient problem, not an account without computers (sync.ts
     * fetchMachines).
     */
    fun replaceMachines(records: List<MachineRecord>) = transaction {
        if (records.isEmpty()) return@transaction
        val keep = records.mapTo(HashSet()) { it.id }
        machines().filter { it.id !in keep }.forEach { deleteMachine(it.id) }
        upsertMachines(records)
    }

    fun upsertMachines(records: List<MachineRecord>) = transaction {
        for (record in records) {
            val existing = machine(record.id)
            val merged = if (existing == null) record else mergeMachine(existing, record)
            if (merged == existing) continue
            val values = ContentValues().apply {
                put("id", merged.id)
                put("seq", merged.seq)
                put("created_at", merged.createdAt)
                put("updated_at", merged.updatedAt)
                put("active", merged.active)
                put("active_at", merged.activeAt)
                put("metadata", merged.metadataJson)
                put("metadata_version", merged.metadataVersion)
                put("daemon_state", merged.daemonStateJson)
                put("daemon_state_version", merged.daemonStateVersion)
                put("data_key", merged.wrappedDataKey)
            }
            if (existing != null) db.update("machines", values, "id = ?", arrayOf(record.id)) else db.insert("machines", null, values)
            dirty().machines = true
            if (existing == null || existing.active != merged.active || existing.activeAt != merged.activeAt) dirty().machineActivity = true
        }
    }

    fun deleteMachine(id: String) = transaction {
        if (db.delete("machines", "id = ?", arrayOf(id)) > 0) {
            dirty().machines = true
            dirty().machineActivity = true
        }
    }

    fun machines(): List<MachineRecord> =
        db.rawQuery("SELECT $MACHINE_COLUMNS FROM machines ORDER BY active_at DESC", null).use { c ->
            buildList { while (c.moveToNext()) add(c.toMachine()) }
        }

    fun machine(id: String): MachineRecord? =
        db.rawQuery("SELECT $MACHINE_COLUMNS FROM machines WHERE id = ?", arrayOf(id)).use { c ->
            if (c.moveToFirst()) c.toMachine() else null
        }

    // Outbox

    /** Accepts messages for delivery, after any already waiting for the session. */
    fun enqueueOutbox(records: List<OutboxRecord>) = transaction {
        for (record in records) {
            val position = db.rawQuery("SELECT COALESCE(MAX(position), 0) + 1 FROM outbox", null).use { c ->
                c.moveToFirst()
                c.getLong(0)
            }
            db.insertOrThrow(
                "outbox",
                null,
                ContentValues().apply {
                    put("local_id", record.localId)
                    put("session_id", record.sessionId)
                    put("position", position)
                    put("kind", record.kind.wire)
                    put("record", record.recordJson)
                    put("content", record.content)
                    put("created_at", record.createdAt)
                    put("state", record.state.name)
                    put("attempts", record.attempts)
                    put("error", record.error)
                    put("server_id", record.serverId)
                    put("server_seq", record.serverSeq)
                },
            )
            dirty().outbox += record.sessionId
        }
    }

    /** A session's outbox in acceptance order; every session's when [sessionId] is null. */
    fun outbox(sessionId: String? = null): List<OutboxRecord> =
        db.rawQuery(
            "SELECT $OUTBOX_COLUMNS FROM outbox" + (if (sessionId != null) " WHERE session_id = ?" else "") + " ORDER BY position",
            sessionId?.let { arrayOf(it) },
        ).use { c -> buildList { while (c.moveToNext()) add(c.toOutbox()) } }

    /** Moves rows to [state], counting an attempt when they start sending. */
    fun setOutboxState(sessionId: String, localIds: Collection<String>, state: OutboxState, error: String? = null) = transaction {
        val rows = outbox(sessionId).associateBy { it.localId }
        for (localId in localIds) {
            val row = rows[localId] ?: continue
            if (state != OutboxState.SENDING && row.state == state && row.error == error) continue
            val values = ContentValues().apply {
                put("state", state.name)
                put("error", error)
                if (state == OutboxState.SENDING) put("attempts", row.attempts + 1)
            }
            db.update("outbox", values, "local_id = ? AND session_id = ?", arrayOf(localId, sessionId))
            dirty().outbox += sessionId
        }
    }

    /**
     * The server stored these (POST answer: localId to server id and seq).
     * Rows whose echo is already stored go; the rest wait for it as `SENT`.
     */
    fun markOutboxSent(sessionId: String, accepted: Map<String, Pair<String, Long>>) = transaction {
        for ((localId, server) in accepted) {
            val echoed = db.rawQuery(
                "SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1",
                arrayOf(sessionId, localId),
            ).use { it.moveToFirst() }
            val changed = if (echoed) {
                db.delete("outbox", "local_id = ? AND session_id = ?", arrayOf(localId, sessionId))
            } else {
                db.update(
                    "outbox",
                    ContentValues().apply {
                        put("state", OutboxState.SENT.name)
                        put("error", null as String?)
                        put("server_id", server.first)
                        put("server_seq", server.second)
                    },
                    "local_id = ? AND session_id = ?",
                    arrayOf(localId, sessionId),
                )
            }
            if (changed > 0) dirty().outbox += sessionId
        }
    }

    fun deleteOutbox(sessionId: String, localId: String) = transaction {
        if (db.delete("outbox", "local_id = ? AND session_id = ?", arrayOf(localId, sessionId)) > 0) dirty().outbox += sessionId
    }

    /** At startup: a send interrupted by the process dying is queued again (the server dedupes on localId). */
    fun requeueInterruptedSends() = transaction {
        val sessions = db.rawQuery("SELECT DISTINCT session_id FROM outbox WHERE state = ?", arrayOf(OutboxState.SENDING.name)).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }
        if (sessions.isEmpty()) return@transaction
        db.execSQL("UPDATE outbox SET state = ? WHERE state = ?", arrayOf<Any>(OutboxState.QUEUED.name, OutboxState.SENDING.name))
        dirty().outbox += sessions
    }

    // Account documents

    /** Settings as the server last confirmed them, or null before the first sync. */
    fun settings(): VersionedJson? = document(KEY_SETTINGS)?.let { (value, version) -> VersionedJson(value, version ?: 0) }

    fun saveSettings(settings: JsonObject, version: Long) = putDocument(KEY_SETTINGS, settings, version)

    /** Local settings changes the server has not accepted yet. They win over [settings]. */
    fun pendingSettings(): JsonObject = document(KEY_PENDING_SETTINGS)?.first ?: EMPTY

    fun savePendingSettings(pending: JsonObject) = transaction {
        if (pending.isEmpty()) {
            if (db.delete("account", "key = ?", arrayOf(KEY_PENDING_SETTINGS)) > 0) dirty().account = true
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
    /** Every session's stored composer document (sync/SessionComposer.kt), by session id. */
    fun composers(): Map<String, String> = db.rawQuery("SELECT session_id, value FROM composer", null).use { c ->
        buildMap { while (c.moveToNext()) put(c.getString(0), c.getString(1)) }
    }

    /** Stores a session's composer document, or removes it when [value] is null. A session not stored is ignored. */
    fun saveComposer(sessionId: String, value: String?) {
        if (value == null) {
            db.delete("composer", "session_id = ?", arrayOf(sessionId))
            return
        }
        db.execSQL(
            "INSERT OR REPLACE INTO composer (session_id, value) SELECT id, ? FROM sessions WHERE id = ?",
            arrayOf(value, sessionId),
        )
    }

    fun clearAll() = transaction {
        listOf("composer", "outbox", "messages", "sessions", "machines", "account", "sync_state").forEach { db.delete(it, null, null) }
        dirty().sessions = true
        dirty().sessionActivity = true
        dirty().machines = true
        dirty().machineActivity = true
        dirty().account = true
        dirty().messages += versionState.value.messages.keys
        dirty().outbox += versionState.value.outbox.keys
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
        if (document(key) == (value to version)) return@transaction
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
        dirty().account = true
    }

    companion object {
        private const val KEY_SETTINGS = "settings"
        private const val KEY_PENDING_SETTINGS = "pending-settings"
        private const val KEY_PROFILE = "profile"
        private val EMPTY = JsonObject(emptyMap())
        private const val SQL_PARAMETERS = 500

        /**
         * One session from two sources (a page and a live update, in either
         * order): each versioned document from whichever has the higher
         * version (the newer record on a tie), counters and timestamps as the maximum, presence from the
         * newer `activeAt`, the project link from the newer record.
         */
        fun mergeSession(existing: SessionRecord, incoming: SessionRecord): SessionRecord {
            val newerRecord = incoming.updatedAt >= existing.updatedAt
            val newerMetadata = incoming.metadataVersion > existing.metadataVersion ||
                (incoming.metadataVersion == existing.metadataVersion && newerRecord)
            val newerState = incoming.agentStateVersion > existing.agentStateVersion ||
                (incoming.agentStateVersion == existing.agentStateVersion && newerRecord)
            val newerPresence = incoming.activeAt >= existing.activeAt
            return existing.copy(
                seq = maxOf(existing.seq, incoming.seq),
                createdAt = incoming.createdAt,
                updatedAt = maxOf(existing.updatedAt, incoming.updatedAt),
                active = if (newerPresence) incoming.active else existing.active,
                activeAt = maxOf(existing.activeAt, incoming.activeAt),
                metadataJson = if (newerMetadata) incoming.metadataJson else existing.metadataJson,
                metadataVersion = maxOf(existing.metadataVersion, incoming.metadataVersion),
                agentStateJson = if (newerState) incoming.agentStateJson else existing.agentStateJson,
                agentStateVersion = maxOf(existing.agentStateVersion, incoming.agentStateVersion),
                wrappedDataKey = incoming.wrappedDataKey,
                projectId = if (newerRecord) incoming.projectId else existing.projectId,
            ).withAvatar(
                mergeSessionAvatar(existing.storedAvatar, incoming.storedAvatar, listingIsNewer = incoming.updatedAt >= existing.updatedAt),
            )
        }

        private val SessionRecord.storedAvatar get() = StoredSessionAvatar(avatarJson, avatarRevision, avatarUpdateSeq)

        private fun SessionRecord.withAvatar(avatar: StoredSessionAvatar) =
            copy(avatarJson = avatar.descriptorJson, avatarRevision = avatar.revision, avatarUpdateSeq = avatar.updateSeq)

        fun mergeMachine(existing: MachineRecord, incoming: MachineRecord): MachineRecord {
            val newerPresence = incoming.activeAt >= existing.activeAt
            val newerRecord = incoming.updatedAt >= existing.updatedAt
            return existing.copy(
                seq = maxOf(existing.seq, incoming.seq),
                createdAt = minOf(existing.createdAt, incoming.createdAt),
                updatedAt = maxOf(existing.updatedAt, incoming.updatedAt),
                active = if (newerPresence) incoming.active else existing.active,
                activeAt = maxOf(existing.activeAt, incoming.activeAt),
                metadataJson = if (incoming.metadataVersion > existing.metadataVersion ||
                    (incoming.metadataVersion == existing.metadataVersion && newerRecord)) incoming.metadataJson else existing.metadataJson,
                metadataVersion = maxOf(existing.metadataVersion, incoming.metadataVersion),
                daemonStateJson = if (incoming.daemonStateVersion > existing.daemonStateVersion ||
                    (incoming.daemonStateVersion == existing.daemonStateVersion && newerRecord)) incoming.daemonStateJson else existing.daemonStateJson,
                daemonStateVersion = maxOf(existing.daemonStateVersion, incoming.daemonStateVersion),
                wrappedDataKey = incoming.wrappedDataKey,
            )
        }

        private const val SESSION_COLUMNS = "id, seq, created_at, updated_at, active, active_at, metadata, metadata_version, " +
            "agent_state, agent_state_version, data_key, project_id, last_message_sent_at, avatar, avatar_revision, avatar_update_seq"
        private const val MESSAGE_COLUMNS = "session_id, seq, id, local_id, content, created_at, updated_at"
        private const val MACHINE_COLUMNS = "id, seq, created_at, updated_at, active, active_at, metadata, metadata_version, " +
            "daemon_state, daemon_state_version, data_key"
        private const val OUTBOX_COLUMNS = "local_id, session_id, kind, record, content, created_at, state, attempts, error, " +
            "server_id, server_seq"

        private fun Cursor.stringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)

        private fun Cursor.longOrNull(index: Int): Long? = if (isNull(index)) null else getLong(index)

        private fun Cursor.toSession() = SessionRecord(
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
            lastMessageSentAt = longOrNull(12),
            avatarJson = stringOrNull(13),
            avatarRevision = longOrNull(14),
            avatarUpdateSeq = longOrNull(15),
        )

        private fun Cursor.toMessage() = MessageRecord(
            sessionId = getString(0),
            seq = getLong(1),
            id = getString(2),
            localId = stringOrNull(3),
            contentJson = stringOrNull(4),
            createdAt = getLong(5),
            updatedAt = getLong(6),
        )

        private fun Cursor.toMachine() = MachineRecord(
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

        private fun Cursor.toOutbox() = OutboxRecord(
            localId = getString(0),
            sessionId = getString(1),
            kind = OutboxKind.entries.first { it.wire == getString(2) },
            recordJson = getString(3),
            content = getString(4),
            createdAt = getLong(5),
            state = OutboxState.valueOf(getString(6)),
            attempts = getInt(7),
            error = stringOrNull(8),
            serverId = stringOrNull(9),
            serverSeq = longOrNull(10),
        )
    }
}
