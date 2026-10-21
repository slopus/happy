package com.slopus.happy.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The on-device copy of the account: framework SQLite, no ORM. See
 * AGENTS.md ("Local store") for why.
 *
 * Every record the server holds encrypted is stored here decrypted, as the
 * JSON the server's ciphertext contained; the app sandbox and file-based
 * encryption protect it at rest, as MMKV does for happy-app. Each record's
 * data key is kept wrapped, exactly as the server sent it, and unwrapped with
 * the account secret only when something must be encrypted again.
 *
 * Delta sync bookkeeping lives next to the data it describes: the
 * `sync_state` watermarks, `sessions.messages_seq`, and
 * `account.version` for settings, so a write and its cursor commit in one
 * transaction.
 *
 * A session's stored messages are always one contiguous run of seqs,
 * `messages_oldest_seq..messages_seq`: a chat opens on its newest page and
 * grows backwards on demand, forwards with every new message. A null
 * `messages_oldest_seq` means no page has been loaded yet.
 *
 * The outbox and the composer mirror are the only data here the server does
 * not have, so schema upgrades from version 2 on migrate instead of starting
 * over.
 */
class HappyDatabase(context: Context, name: String? = NAME) :
    SQLiteOpenHelper(context, name, null, VERSION) {

    init {
        setWriteAheadLoggingEnabled(true)
    }

    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        SCHEMA.forEach(db::execSQL)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion !in 1..3) return startOver(db)
        // Version 1 synced every message from seq 0, so what it stored is
        // complete history: the oldest stored seq is the floor.
        if (oldVersion == 1) MIGRATE_1_TO_2.forEach(db::execSQL)
        if (oldVersion <= 2) MIGRATE_2_TO_3.forEach(db::execSQL)
        MIGRATE_3_TO_4.forEach(db::execSQL)
    }

    // Nothing newer can be read safely; everything but the outbox can be fetched again.
    override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = startOver(db)

    private fun startOver(db: SQLiteDatabase) {
        DROP.forEach(db::execSQL)
        onCreate(db)
    }

    companion object {
        const val NAME = "happy.db"
        const val VERSION = 4

        // Messages accepted on this device and not yet echoed back by the
        // server. `content` is the ciphertext exactly as it is POSTed (so a
        // retry sends the same bytes), `record` the plaintext for display.
        private const val OUTBOX = """
            CREATE TABLE outbox (
                local_id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                kind TEXT NOT NULL,
                record TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                state TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                server_id TEXT,
                server_seq INTEGER
            )
        """
        private const val OUTBOX_INDEX = "CREATE INDEX outbox_by_session ON outbox (session_id, position)"

        // The device side of each session's composer (sync/SessionComposer.kt):
        // draft text and picker choices, one JSON document per session.
        private const val COMPOSER = """
            CREATE TABLE composer (
                session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
                value TEXT NOT NULL
            )
        """

        private val SCHEMA = listOf(
            // Watermarks: where the next delta sync of each stream starts.
            """
            CREATE TABLE sync_state (
                key TEXT PRIMARY KEY NOT NULL,
                value INTEGER NOT NULL
            )
            """,
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY NOT NULL,
                seq INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                active INTEGER NOT NULL,
                active_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER NOT NULL,
                agent_state TEXT,
                agent_state_version INTEGER NOT NULL,
                data_key TEXT NOT NULL,
                project_id TEXT,
                messages_seq INTEGER NOT NULL DEFAULT 0,
                messages_oldest_seq INTEGER,
                messages_has_older INTEGER NOT NULL DEFAULT 0,
                last_message_sent_at INTEGER,
                avatar TEXT,
                avatar_revision INTEGER,
                avatar_update_seq INTEGER
            )
            """,
            "CREATE INDEX sessions_by_updated ON sessions (updated_at DESC)",
            """
            CREATE TABLE messages (
                session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                id TEXT NOT NULL,
                local_id TEXT,
                content TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, seq)
            ) WITHOUT ROWID
            """,
            """
            CREATE TABLE machines (
                id TEXT PRIMARY KEY NOT NULL,
                seq INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                active INTEGER NOT NULL,
                active_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER NOT NULL,
                daemon_state TEXT,
                daemon_state_version INTEGER NOT NULL,
                data_key TEXT NOT NULL
            )
            """,
            OUTBOX,
            OUTBOX_INDEX,
            COMPOSER,
            // Account-level JSON documents: settings (with the server version),
            // settings changes not yet accepted by the server, and the profile.
            """
            CREATE TABLE account (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                version INTEGER
            )
            """,
        ).map(String::trimIndent)

        private val MIGRATE_1_TO_2
            get() = listOf(
                "ALTER TABLE sessions ADD COLUMN messages_oldest_seq INTEGER",
                "ALTER TABLE sessions ADD COLUMN messages_has_older INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE sessions ADD COLUMN last_message_sent_at INTEGER",
                "UPDATE sessions SET messages_oldest_seq = (SELECT MIN(seq) FROM messages WHERE session_id = sessions.id) " +
                    "WHERE messages_seq > 0",
                OUTBOX,
                OUTBOX_INDEX,
            ).map(String::trimIndent)

        private val MIGRATE_2_TO_3
            get() = listOf(COMPOSER).map(String::trimIndent)

        // Session avatars (sessionAvatarTypes.ts): the sealed descriptor and how new it is.
        private val MIGRATE_3_TO_4
            get() = listOf(
                "ALTER TABLE sessions ADD COLUMN avatar TEXT",
                "ALTER TABLE sessions ADD COLUMN avatar_revision INTEGER",
                "ALTER TABLE sessions ADD COLUMN avatar_update_seq INTEGER",
            )

        private val DROP = listOf(
            "DROP TABLE IF EXISTS composer",
            "DROP TABLE IF EXISTS outbox",
            "DROP TABLE IF EXISTS messages",
            "DROP TABLE IF EXISTS sessions",
            "DROP TABLE IF EXISTS machines",
            "DROP TABLE IF EXISTS account",
            "DROP TABLE IF EXISTS sync_state",
        )
    }
}
