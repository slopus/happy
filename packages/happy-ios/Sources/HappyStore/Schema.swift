import Foundation
import GRDB

/// The store schema. Migrations are append-only: never edit a registered
/// migration once it has shipped, add a new one.
enum Schema {
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()

        migrator.registerMigration("v1") { db in
            try db.create(table: "session") { t in
                t.primaryKey("id", .text)
                t.column("seq", .integer).notNull().defaults(to: 0)
                t.column("createdAt", .integer).notNull()
                t.column("updatedAt", .integer).notNull()
                t.column("active", .boolean).notNull().defaults(to: false)
                t.column("activeAt", .integer).notNull()
                t.column("projectId", .text)
                t.column("metadataVersion", .integer).notNull()
                t.column("metadataCipher", .text).notNull()
                t.column("metadata", .text)
                t.column("agentStateVersion", .integer).notNull().defaults(to: 0)
                t.column("agentStateCipher", .text)
                t.column("agentState", .text)
                t.column("dataKeyCipher", .text)
                t.column("decryptable", .boolean).notNull()
                t.column("syncedMessageSeq", .integer).notNull().defaults(to: 0)
            }
            try db.create(index: "session_updatedAt", on: "session", columns: ["updatedAt"])

            try db.create(table: "machine") { t in
                t.primaryKey("id", .text)
                t.column("seq", .integer).notNull().defaults(to: 0)
                t.column("createdAt", .integer).notNull()
                t.column("updatedAt", .integer).notNull()
                t.column("active", .boolean).notNull().defaults(to: false)
                t.column("activeAt", .integer).notNull()
                t.column("metadataVersion", .integer).notNull()
                t.column("metadataCipher", .text).notNull()
                t.column("metadata", .text)
                t.column("daemonStateVersion", .integer).notNull().defaults(to: 0)
                t.column("daemonStateCipher", .text)
                t.column("daemonState", .text)
                t.column("dataKeyCipher", .text)
                t.column("decryptable", .boolean).notNull()
            }

            try db.create(table: "message") { t in
                t.primaryKey("id", .text)
                t.column("sessionId", .text).notNull()
                    .references("session", onDelete: .cascade)
                t.column("seq", .integer).notNull()
                t.column("localId", .text)
                t.column("createdAt", .integer).notNull()
                t.column("updatedAt", .integer).notNull()
                t.column("contentCipher", .text).notNull()
                t.column("content", .text)
                t.uniqueKey(["sessionId", "seq"])
            }
            try db.create(index: "message_localId", on: "message", columns: ["sessionId", "localId"])

            try db.create(table: "outbox") { t in
                t.primaryKey("localId", .text)
                t.column("kind", .text).notNull()
                t.column("sessionId", .text).notNull()
                t.column("payload", .text).notNull()
                t.column("createdAt", .integer).notNull()
                t.column("attempts", .integer).notNull().defaults(to: 0)
                t.column("lastError", .text)
            }

            try db.create(table: "accountSettings") { t in
                t.primaryKey("id", .integer)
                t.column("version", .integer).notNull()
                t.column("cipher", .text)
                t.column("settings", .text)
            }

            try db.create(table: "syncState") { t in
                t.primaryKey("key", .text)
                t.column("value", .integer).notNull()
            }
        }

        migrator.registerMigration("v2") { db in
            // Live state the server only sends as ephemerals, and local
            // read state. `thinking` and `archiving` are cleared on every
            // open (see LocalStore.open); `unread` is kept.
            try db.alter(table: "session") { t in
                t.add(column: "thinking", .boolean).notNull().defaults(to: false)
                t.add(column: "thinkingAt", .integer).notNull().defaults(to: 0)
                t.add(column: "unread", .boolean).notNull().defaults(to: false)
                t.add(column: "archiving", .boolean).notNull().defaults(to: false)
            }

            try db.create(table: "project") { t in
                t.primaryKey("id", .text)
                t.column("externalId", .text).notNull()
                t.column("createdAt", .integer).notNull()
                t.column("updatedAt", .integer).notNull()
                t.column("metadataVersion", .integer).notNull()
                t.column("metadataCipher", .text).notNull()
                t.column("metadata", .text)
                t.column("dataKeyCipher", .text)
            }

            try db.create(table: "accountProfile") { t in
                t.primaryKey("id", .integer)
                t.column("timestamp", .integer).notNull()
                t.column("profile", .text).notNull()
            }

            // Settings changed on this device and not yet accepted by the
            // server: a partial settings object layered over the synced one.
            try db.create(table: "pendingSettings") { t in
                t.primaryKey("id", .integer)
                t.column("delta", .text).notNull()
            }
        }

        migrator.registerMigration("v3") { db in
            // The outbox carries every write the chat makes, in order per
            // session: file events before the text they belong to, retried
            // with backoff, failed items kept until retried or discarded.
            try db.alter(table: "outbox") { t in
                t.add(column: "state", .text).notNull().defaults(to: "queued")
                t.add(column: "nextAttemptAt", .integer).notNull().defaults(to: 0)
                // The localId that has to be delivered before this one.
                t.add(column: "dependsOn", .text)
            }
            try db.create(index: "outbox_session", on: "outbox", columns: ["sessionId", "createdAt"])

            // A picked file, copied into the account's files directory until
            // its blob is uploaded and the file event that names it is sent.
            try db.create(table: "attachment") { t in
                t.primaryKey("localId", .text)
                t.column("sessionId", .text).notNull()
                // The outbox item (a file event) that carries it.
                t.column("outboxLocalId", .text)
                // Relative to the account's files directory.
                t.column("path", .text).notNull()
                t.column("name", .text).notNull()
                t.column("mimeType", .text).notNull()
                t.column("size", .integer).notNull()
                t.column("width", .integer)
                t.column("height", .integer)
                t.column("thumbhash", .text)
                // The server's blob ref once uploaded.
                t.column("ref", .text)
                t.column("createdAt", .integer).notNull()
            }

            // Unsent composer text per session (happy-app keeps it in MMKV).
            try db.create(table: "draft") { t in
                t.primaryKey("sessionId", .text)
                t.column("text", .text).notNull()
                t.column("updatedAt", .integer).notNull()
            }
            try db.create(table: "composerState") { t in
                t.primaryKey("sessionId", .text)
                t.column("values", .text).notNull()
            }
        }

        migrator.registerMigration("v4") { db in
            // This device's accepted user sends, never a wire metadata field.
            try db.alter(table: "session") { t in
                t.add(column: "lastMessageSentAt", .integer)
            }
        }

        migrator.registerMigration("v5") { db in
            // A backward-downloaded tail is not the synchronized prefix.
            try db.create(table: "chatHistory") { t in
                t.primaryKey("sessionId", .text).references("session", onDelete: .cascade)
                t.column("newestLoaded", .boolean).notNull()
                t.column("oldestRawSeq", .integer)
                t.column("newestRawSeq", .integer)
                t.column("serverHasMore", .boolean).notNull()
                t.column("checkedThroughSeq", .integer).notNull()
            }
        }

        migrator.registerMigration("v6") { db in
            // The first v3 caches predate composerState: it was added to
            // that migration after they had already recorded v3 as applied.
            // Add the missing table without replacing existing selections.
            try db.create(table: "composerState", ifNotExists: true) { t in
                t.primaryKey("sessionId", .text)
                t.column("values", .text).notNull()
            }
        }

        migrator.registerMigration("v7-private-avatars") { db in
            try db.alter(table: "session") { t in
                t.add(column: "avatar", .text)
                t.add(column: "avatarVersion", .integer)
                t.add(column: "avatarUpdateSeq", .integer)
            }
            try db.alter(table: "project") { t in t.add(column: "avatar", .text) }
            // Existing rows predate descriptor storage. Backfill once while
            // keeping their offline content and the first-sync marker.
            try db.execute(sql: "DELETE FROM syncState WHERE key = 'sessions.lastFullSync'")
        }

        return migrator
    }
}
