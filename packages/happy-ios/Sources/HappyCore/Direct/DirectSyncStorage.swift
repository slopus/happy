import Foundation
import GRDB
import HappyStore
import HappyWire

/// A direct account's durable state. This database never contains relay
/// credentials or relay records. Snapshot data and its cursor commit together;
/// a process can never resume beyond changes that made it to disk.
public actor DirectSyncStorage {
    public struct Checkpoint: Codable, Equatable, Sendable {
        public var value: JSONValue
        public var cursor: String?
        public init(value: JSONValue, cursor: String?) { self.value = value; self.cursor = cursor }
    }

    public struct PendingSetting: Equatable, Sendable {
        public let key: String
        public let value: JSONValue
        public let mutationID: String
        public let updatedAt: Double
    }

    private let database: DatabaseQueue
    private var closed = false
    private var settingRevision = 0
    public struct ChangedDuringRead: Error, Sendable {}

    public func confirmedSettingsRevision() -> Int { settingRevision }

    public init(url: URL? = nil) throws {
        ThreadRules.assertOffMain()
        if let url {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            database = try DatabaseQueue(path: url.path)
        } else {
            database = try DatabaseQueue()
        }
        var migrator = DatabaseMigrator()
        migrator.registerMigration("direct-v1") { db in
            try db.execute(sql: """
                CREATE TABLE checkpoint (name TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL, cursor TEXT);
                CREATE TABLE setting (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL, version TEXT);
                CREATE TABLE pendingSetting (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL, mutationID TEXT NOT NULL, updatedAt DOUBLE NOT NULL);
                """)
        }
        migrator.registerMigration("direct-v2-outbox") { db in
            try db.execute(sql: "CREATE TABLE outbox (id TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL)")
        }
        try migrator.migrate(database)
    }

    /// Late work from an account that was removed cannot recreate its cache.
    public func close() throws {
        closed = true
        try database.close()
    }

    private func checkOpen() throws {
        ThreadRules.assertOffMain()
        if closed { throw CancellationError() }
    }

    public func checkpoint(_ name: String) throws -> Checkpoint? {
        try checkOpen()
        return try database.read { db in
            guard let row = try Row.fetchOne(db, sql: "SELECT value, cursor FROM checkpoint WHERE name = ?", arguments: [name]) else { return nil }
            return Checkpoint(value: try JSONDecoder().decode(JSONValue.self, from: row["value"] as Data), cursor: row["cursor"])
        }
    }

    public func commit(_ checkpoint: Checkpoint, named name: String, settings: [DirectUserSetting]? = nil, expectedSettingsRevision: Int? = nil) throws {
        try checkOpen()
        if let expectedSettingsRevision, settingRevision != expectedSettingsRevision { throw ChangedDuringRead() }
        let data = try JSONEncoder().encode(checkpoint.value)
        try database.write { db in
            if let settings {
                try db.execute(sql: "DELETE FROM setting")
                for setting in settings {
                    try Self.saveSetting(setting.key, data: JSONEncoder().encode(setting.value), version: setting.version, db: db)
                }
            }
            try db.execute(sql: """
                INSERT INTO checkpoint(name, value, cursor) VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value = excluded.value, cursor = excluded.cursor
                WHERE value != excluded.value OR cursor IS NOT excluded.cursor
                """, arguments: [name, data, checkpoint.cursor])
        }
        if settings != nil { settingRevision += 1 }
    }

    /// The user's intent is durable before it is shown or sent. One row per
    /// key coalesces offline edits without growing an unbounded queue.
    @discardableResult
    public func enqueueSetting(_ key: String, value: JSONValue, updatedAt: Double = (Date().timeIntervalSince1970 * 1000).rounded(.down)) throws -> PendingSetting {
        try checkOpen()
        let pending = PendingSetting(key: key, value: value, mutationID: ClientID.make(), updatedAt: updatedAt)
        let data = try JSONEncoder().encode(value)
        try database.write { db in
            try db.execute(sql: """
                INSERT INTO pendingSetting(key, value, mutationID, updatedAt) VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, mutationID = excluded.mutationID, updatedAt = excluded.updatedAt
                """, arguments: [key, data, pending.mutationID, updatedAt])
        }
        return pending
    }

    public func pendingSettings() throws -> [PendingSetting] {
        try checkOpen()
        return try database.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM pendingSetting ORDER BY key").map {
                PendingSetting(key: $0["key"], value: try JSONDecoder().decode(JSONValue.self, from: $0["value"] as Data), mutationID: $0["mutationID"], updatedAt: $0["updatedAt"])
            }
        }
    }

    /// A late acknowledgement may update the confirmed copy, but must never
    /// delete a newer local intent for the same key.
    public func acknowledge(_ pending: PendingSetting, authoritative: DirectUserSetting? = nil) throws {
        try checkOpen()
        settingRevision += 1
        let data = try JSONEncoder().encode(authoritative?.value ?? pending.value)
        try database.write { db in
            try Self.saveSetting(pending.key, data: data, version: authoritative?.version, db: db)
            try db.execute(sql: "DELETE FROM pendingSetting WHERE key = ? AND mutationID = ?", arguments: [pending.key, pending.mutationID])
        }
    }

    public func receiveSetting(_ key: String, value: JSONValue, version: String? = nil) throws {
        try checkOpen()
        settingRevision += 1
        let data = try JSONEncoder().encode(value)
        try database.write { try Self.saveSetting(key, data: data, version: version, db: $0) }
    }

    /// Local pending values overlay the remote copy until acknowledged.
    public func settings() throws -> [String: JSONValue] {
        try checkOpen()
        return try database.read { db in
            var result: [String: JSONValue] = [:]
            for table in ["setting", "pendingSetting"] {
                for row in try Row.fetchAll(db, sql: "SELECT key, value FROM \(table)") {
                    result[row["key"] as String] = try JSONDecoder().decode(JSONValue.self, from: row["value"] as Data)
                }
            }
            return result
        }
    }

    private static func saveSetting(_ key: String, data: Data, version: String?, db: Database) throws {
        try db.execute(sql: """
            INSERT INTO setting(key, value, version) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version
            WHERE setting.version IS NULL OR excluded.version > setting.version
            """, arguments: [key, data, version])
    }

    public func enqueueMessage(_ message: DirectQueuedMessage) throws {
        try checkOpen()
        let data = try JSONEncoder().encode(message)
        try database.write { db in
            // A duplicate enqueue never changes an already accepted payload.
            try db.execute(sql: "INSERT OR IGNORE INTO outbox(id, value) VALUES (?, ?)", arguments: [message.id, data])
        }
    }

    public func queuedMessages() throws -> [DirectQueuedMessage] {
        try checkOpen()
        return try database.read { db in
            try Row.fetchAll(db, sql: "SELECT value FROM outbox ORDER BY rowid").map {
                try JSONDecoder().decode(DirectQueuedMessage.self, from: $0["value"] as Data)
            }
        }
    }

    public func updateMessage(_ message: DirectQueuedMessage) throws {
        try checkOpen()
        let data = try JSONEncoder().encode(message)
        try database.write { try $0.execute(sql: "UPDATE outbox SET value = ? WHERE id = ?", arguments: [data, message.id]) }
    }

    public func acknowledgeMessage(_ id: String) throws {
        try checkOpen()
        try database.write { try $0.execute(sql: "DELETE FROM outbox WHERE id = ?", arguments: [id]) }
    }
}