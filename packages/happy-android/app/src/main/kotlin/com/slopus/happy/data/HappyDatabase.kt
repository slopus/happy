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
        // Everything here can be fetched again. Until there is local-only
        // data worth migrating, an upgrade starts over and resyncs.
        DROP.forEach(db::execSQL)
        onCreate(db)
    }

    override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) =
        onUpgrade(db, oldVersion, newVersion)

    companion object {
        const val NAME = "happy.db"
        const val VERSION = 1

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
                messages_seq INTEGER NOT NULL DEFAULT 0
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

        private val DROP = listOf(
            "DROP TABLE IF EXISTS messages",
            "DROP TABLE IF EXISTS sessions",
            "DROP TABLE IF EXISTS machines",
            "DROP TABLE IF EXISTS account",
            "DROP TABLE IF EXISTS sync_state",
        )
    }
}
