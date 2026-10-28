@testable import HappyCore
import HappyWire
import XCTest

final class DirectSyncStorageTests: XCTestCase {
    func testSettingTimestampUsesDaemonIntegerMilliseconds() async throws {
        let storage = try DirectSyncStorage()
        let pending = try await storage.enqueueSetting("key", value: .bool(true))
        XCTAssertEqual(pending.updatedAt, pending.updatedAt.rounded(.down))
        XCTAssertLessThan(abs(pending.updatedAt - Date().timeIntervalSince1970 * 1000), 1_000)
    }

    func testOldBootstrapCannotOverwriteNewerAcknowledgementOrBootstrap() async throws {
        let storage = try DirectSyncStorage()
        let revision = await storage.confirmedSettingsRevision()
        let pending = try await storage.enqueueSetting("key", value: .bool(true))
        let winner = DirectUserSetting(key: "key", value: .bool(true), updatedAt: 2, version: "v2")
        try await storage.acknowledge(pending, authoritative: winner)
        do {
            try await storage.commit(.init(value: .null, cursor: "old"), named: "desktop", settings: [], expectedSettingsRevision: revision)
            XCTFail("Old bootstrap erased the PUT winner")
        } catch is DirectSyncStorage.ChangedDuringRead { }
        let next = await storage.confirmedSettingsRevision()
        try await storage.commit(.init(value: .null, cursor: "new"), named: "desktop", settings: [winner], expectedSettingsRevision: next)
        do {
            try await storage.commit(.init(value: .null, cursor: "old"), named: "desktop", settings: [], expectedSettingsRevision: next)
            XCTFail("Old bootstrap erased the newer checkpoint")
        } catch is DirectSyncStorage.ChangedDuringRead { }
        let checkpoint = try await storage.checkpoint("desktop")
        let settings = try await storage.settings()
        XCTAssertEqual(checkpoint?.cursor, "new")
        XCTAssertEqual(settings["key"], .bool(true))
    }

    func testSettingVersionsAndAuthoritativeStaleWriteWinner() async throws {
        let storage = try DirectSyncStorage()
        try await storage.receiveSetting("key", value: .bool(true), version: "0002")
        try await storage.receiveSetting("key", value: .bool(false), version: "0001")
        let pending = try await storage.enqueueSetting("key", value: .bool(false), updatedAt: 1)
        try await storage.acknowledge(pending, authoritative: .init(key: "key", value: .bool(true), updatedAt: 2, version: "0002"))
        let values = try await storage.settings()
        XCTAssertEqual(values["key"], .bool(true))
        let queued = try await storage.pendingSettings()
        XCTAssertTrue(queued.isEmpty)
    }

    func testCheckpointAndPendingSettingsSurviveRelaunch() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("direct.sqlite")
        let storage = try DirectSyncStorage(url: url)
        let checkpoint = DirectSyncStorage.Checkpoint(value: .object(["rows": .array([.string("one")])]), cursor: "cursor-2")
        try await storage.commit(checkpoint, named: "home")
        let original = try await storage.enqueueSetting("visibility", value: .array([.string("project")]))
        try await storage.close()
        let reopened = try DirectSyncStorage(url: url)
        let saved = try await reopened.checkpoint("home")
        let settings = try await reopened.settings()
        let pending = try await reopened.pendingSettings()
        XCTAssertEqual(saved, checkpoint)
        XCTAssertEqual(settings["visibility"], .array([.string("project")]))
        XCTAssertEqual(pending, [original], "Relaunch must retain the original timestamp and mutation ID")
    }

    func testOldAcknowledgementDoesNotEraseNewIntentOrRemoteOverwriteIt() async throws {
        let storage = try DirectSyncStorage()
        let old = try await storage.enqueueSetting("key", value: .bool(false))
        let new = try await storage.enqueueSetting("key", value: .bool(true))
        try await storage.receiveSetting("key", value: .bool(false))
        try await storage.acknowledge(old)
        let settings = try await storage.settings()
        let pending = try await storage.pendingSettings()
        XCTAssertEqual(settings["key"], .bool(true))
        XCTAssertEqual(pending, [new])
        try await storage.acknowledge(new)
        let remaining = try await storage.pendingSettings()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testAccountIsolationAndClosedStoreRejectsLateResponse() async throws {
        let first = try DirectSyncStorage()
        let second = try DirectSyncStorage()
        try await first.enqueueSetting("key", value: .bool(true))
        let settings = try await second.settings()
        XCTAssertTrue(settings.isEmpty)
        try await first.close()
        do {
            try await first.receiveSetting("key", value: .bool(false))
            XCTFail("A closed account accepted a late write")
        } catch is CancellationError { }
    }
}