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

        return migrator
    }
}
