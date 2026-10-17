import Foundation
import GRDB
import HappyWire
import XCTest
@testable import HappyStore

final class ComposerSchemaMigrationTests: XCTestCase {
    func testHistoricalV3CacheRepairsDetailsWithoutLosingStoredData() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("legacy-composer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("store.sqlite")
        let before: [String: [Row]]
        let originalColumns: [String: [String]]
        do {
            let writer = try DatabaseQueue(path: url.path)
            try await writer.write { db in try db.execute(sql: Self.originalV3) }
            // v4 and v5 did not repair the table omitted by the original v3.
            try Schema.migrator.migrate(writer, upTo: "v5")
            try await writer.write { db in try db.execute(sql: Self.cachedData) }
            before = try Self.contents(writer)
            originalColumns = try await writer.read { db in
                try Dictionary(uniqueKeysWithValues: Self.preservedTables.map { ($0, try db.columns(in: $0).map(\.name)) })
            }
            try await writer.read { db in
                XCTAssertFalse(try db.tableExists("composerState"))
                XCTAssertFalse(try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM grdb_migrations WHERE identifier = 'v6')") ?? true)
                XCTAssertEqual(try LocalStore.fetchHomeSnapshot(db).sessions.first?.id, "session")
                XCTAssertEqual(try MessageRecord.fetchCount(db), 1)
                XCTAssertThrowsError(try LocalStore.fetchSessionDetail(db, sessionId: "session")) { error in
                    XCTAssertEqual(SessionDetailFailure(error), SessionDetailFailure(kind: .database, code: 1))
                    XCTAssertEqual((error as? DatabaseError)?.message, "no such table: composerState")
                }
            }
        }

        do {
            let store = try LocalStore.open(at: url)
            XCTAssertEqual(try Self.contents(store.writer, columns: originalColumns), before)
            XCTAssertNil(try store.session(id: "session")?.avatar)
            XCTAssertNil(try store.session(id: "session")?.avatarVersion)
            XCTAssertNil(try store.projects().first?.avatar)
            let repaired = try await store.writer.read { db in
                try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM grdb_migrations WHERE identifier = 'v6')") ?? false
            }
            XCTAssertTrue(repaired)
            let detail = try store.sessionDetail(sessionId: "session")
            XCTAssertEqual(detail.session?.id, "session")
            XCTAssertEqual(detail.machine?.id, "machine")
            XCTAssertTrue(detail.dataReady)
            XCTAssertEqual(detail.composer, .object([:]))
            let observed = expectation(description: "repaired disk cache yields its first Details snapshot")
            let consume = Task {
                for await value in store.sessionDetailSnapshots(sessionId: "session", onError: { _ in
                    XCTFail("repaired Details observation failed")
                }) {
                    XCTAssertEqual(value, detail)
                    observed.fulfill()
                    break
                }
            }
            await fulfillment(of: [observed], timeout: 3)
            consume.cancel()
            try store.saveComposerState(ComposerStateRecord(sessionId: "session", values: .object(["model": .string("kept-model")])))
        }
        let reopened = try LocalStore.open(at: url)
        XCTAssertEqual(try Self.contents(reopened.writer, columns: originalColumns), before)
        XCTAssertEqual(try reopened.sessionDetail(sessionId: "session").composer, .object(["model": .string("kept-model")]))
    }

    func testExistingV5ComposerPicksSurviveMigrationAndReopen() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("current-composer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("store.sqlite")
        let values: JSONValue = .object(["model": .string("kept-model"), "serviceTier": .null])
        do {
            let writer = try DatabaseQueue(path: url.path)
            try Schema.migrator.migrate(writer, upTo: "v5")
            try await writer.write { db in
                try db.execute(sql: Self.cachedData)
                try ComposerStateRecord(sessionId: "session", values: values).insert(db)
            }
        }
        for _ in 0..<2 {
            let store = try LocalStore.open(at: url)
            XCTAssertEqual(try store.sessionDetail(sessionId: "session").composer, values)
            let count = try await store.writer.read { db in try ComposerStateRecord.fetchCount(db) }
            XCTAssertEqual(count, 1)
        }
    }

    func testAvatarBackfillPreservesOfflineDataAndOnlyInvalidatesFullListingMarker() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("avatar-backfill-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("store.sqlite")
        do {
            let writer = try DatabaseQueue(path: url.path)
            try Schema.migrator.migrate(writer, upTo: "v6")
            try await writer.write { db in
                try db.execute(sql: Self.cachedData)
                try db.execute(sql: "INSERT INTO syncState VALUES ('sessions.lastFullSync', 999)")
            }
        }
        let store = try LocalStore.open(at: url)
        XCTAssertNil(try store.cursor(.sessionsLastFullSync))
        XCTAssertEqual(try store.cursor(.sessionsChangedSince), 1234)
        XCTAssertEqual(try store.session(id: "session")?.metadata?["machineId"]?.stringValue, "machine")
        XCTAssertEqual(try store.messages(sessionId: "session").count, 1)
        XCTAssertEqual(try store.sessionDetail(sessionId: "session").composer, .object([:]))
    }

    private static let preservedTables = [
        "session", "machine", "message", "outbox", "attachment", "draft", "project",
        "accountSettings", "pendingSettings", "accountProfile", "syncState", "chatHistory",
    ]

    private static func contents(_ writer: any DatabaseWriter, columns: [String: [String]] = [:]) throws -> [String: [Row]] {
        try writer.read { db in
            try Dictionary(uniqueKeysWithValues: preservedTables.map { table in
                let projection = columns[table]?.map { "\"\($0)\"" }.joined(separator: ", ") ?? "*"
                return (table, try Row.fetchAll(db, sql: "SELECT \(projection) FROM \(table) ORDER BY rowid"))
            })
        }
    }

    private static let cachedData = """
        INSERT INTO session (id, seq, createdAt, updatedAt, activeAt, metadataVersion, metadataCipher, metadata, decryptable, syncedMessageSeq, unread)
            VALUES ('session', 7, 1, 2, 1, 3, 'session-cipher', '{"machineId":"machine"}', 1, 6, 1);
        INSERT INTO machine (id, createdAt, updatedAt, activeAt, metadataVersion, metadataCipher, metadata, decryptable)
            VALUES ('machine', 1, 2, 1, 4, 'machine-cipher', '{"host":"cached-host"}', 1);
        INSERT INTO message (id, sessionId, seq, localId, createdAt, updatedAt, contentCipher, content)
            VALUES ('message', 'session', 6, 'sent-local', 1, 2, 'message-cipher', '{"text":"cached text"}');
        INSERT INTO outbox (localId, kind, sessionId, payload, createdAt, attempts, state, nextAttemptAt)
            VALUES ('pending-send', 'message', 'session', '{"text":"unsent text"}', 3, 2, 'failed', 9);
        INSERT INTO attachment (localId, sessionId, outboxLocalId, path, name, mimeType, size, createdAt)
            VALUES ('pending-file', 'session', 'pending-send', 'files/cached.txt', 'cached.txt', 'text/plain', 12, 3);
        INSERT INTO draft VALUES ('session', 'unsent draft', 4);
        INSERT INTO project (id, externalId, createdAt, updatedAt, metadataVersion, metadataCipher, metadata)
            VALUES ('project', 'external', 1, 2, 3, 'project-cipher', '{}');
        INSERT INTO accountSettings VALUES (1, 5, 'settings-cipher', '{"themeMode":"dark"}');
        INSERT INTO pendingSettings VALUES (1, '{"viewInline":true}');
        INSERT INTO accountProfile VALUES (1, 6, '{"id":"account","timestamp":6,"firstName":"Cached"}');
        INSERT INTO syncState VALUES ('sessions.changedSince', 1234);
        INSERT INTO syncState VALUES ('machines.lastSync', 5678);
        INSERT INTO chatHistory VALUES ('session', 1, 6, 7, 1, 7);
        """

    // Schema at 94144601 (2026-10-13): v3 was registered without
    // composerState. 45666e0c added that table inside the same migration.
    // Keep this fixture independent of the current migration definitions.
    private static let originalV3 = """
        CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);
        INSERT INTO grdb_migrations VALUES ('v1'), ('v2'), ('v3');
        CREATE TABLE session (
            id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            active BOOLEAN NOT NULL DEFAULT 0, activeAt INTEGER NOT NULL, projectId TEXT,
            metadataVersion INTEGER NOT NULL, metadataCipher TEXT NOT NULL, metadata TEXT,
            agentStateVersion INTEGER NOT NULL DEFAULT 0, agentStateCipher TEXT, agentState TEXT,
            dataKeyCipher TEXT, decryptable BOOLEAN NOT NULL, syncedMessageSeq INTEGER NOT NULL DEFAULT 0,
            thinking BOOLEAN NOT NULL DEFAULT 0, thinkingAt INTEGER NOT NULL DEFAULT 0,
            unread BOOLEAN NOT NULL DEFAULT 0, archiving BOOLEAN NOT NULL DEFAULT 0);
        CREATE INDEX session_updatedAt ON session(updatedAt);
        CREATE TABLE machine (
            id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            active BOOLEAN NOT NULL DEFAULT 0, activeAt INTEGER NOT NULL, metadataVersion INTEGER NOT NULL,
            metadataCipher TEXT NOT NULL, metadata TEXT, daemonStateVersion INTEGER NOT NULL DEFAULT 0,
            daemonStateCipher TEXT, daemonState TEXT, dataKeyCipher TEXT, decryptable BOOLEAN NOT NULL);
        CREATE TABLE message (
            id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES session ON DELETE CASCADE, seq INTEGER NOT NULL,
            localId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, contentCipher TEXT NOT NULL,
            content TEXT, UNIQUE(sessionId, seq));
        CREATE INDEX message_localId ON message(sessionId, localId);
        CREATE TABLE outbox (
            localId TEXT PRIMARY KEY, kind TEXT NOT NULL, sessionId TEXT NOT NULL, payload TEXT NOT NULL,
            createdAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lastError TEXT,
            state TEXT NOT NULL DEFAULT 'queued', nextAttemptAt INTEGER NOT NULL DEFAULT 0, dependsOn TEXT);
        CREATE INDEX outbox_session ON outbox(sessionId, createdAt);
        CREATE TABLE accountSettings (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, cipher TEXT, settings TEXT);
        CREATE TABLE syncState (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE project (
            id TEXT PRIMARY KEY, externalId TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            metadataVersion INTEGER NOT NULL, metadataCipher TEXT NOT NULL, metadata TEXT, dataKeyCipher TEXT);
        CREATE TABLE accountProfile (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, profile TEXT NOT NULL);
        CREATE TABLE pendingSettings (id INTEGER PRIMARY KEY, delta TEXT NOT NULL);
        CREATE TABLE attachment (
            localId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, outboxLocalId TEXT, path TEXT NOT NULL,
            name TEXT NOT NULL, mimeType TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER,
            thumbhash TEXT, ref TEXT, createdAt INTEGER NOT NULL);
        CREATE TABLE draft (sessionId TEXT PRIMARY KEY, text TEXT NOT NULL, updatedAt INTEGER NOT NULL);
        """
}
