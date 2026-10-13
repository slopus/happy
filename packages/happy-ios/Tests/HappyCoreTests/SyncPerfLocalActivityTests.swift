import Foundation
import GRDB
import XCTest
import HappyCrypto
import HappyWire
@testable import HappyStore
@testable import HappyCore

final class SyncPerfLocalActivityTests: XCTestCase {
    private func text(_ id: String, at: Int64, sessionId: String = "s") -> OutboxRecord {
        .init(localId: id, kind: .message, sessionId: sessionId,
              payload: .object(["role": .string("user"), "content": .object(["type": .string("text"), "text": .string("hello")])]), createdAt: at)
    }

    func testV3MigrationAndOfflineAcceptedSendPersistAcrossReopenAndWireMerge() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("store.sqlite")
        do {
            let legacy = try DatabaseQueue(path: file.path)
            try Schema.migrator.migrate(legacy, upTo: "v3")
            try legacy.write { db in
                try db.execute(sql: "INSERT INTO session (id, seq, createdAt, updatedAt, active, activeAt, metadataVersion, metadataCipher, decryptable) VALUES ('s', 0, 17, 18, 1, 18, 1, '', 1)")
            }
        }
        do {
            let store = try LocalStore.open(at: file)
            XCTAssertNil(try store.session(id: "s")?.lastMessageSentAt)
            try store.enqueueAcceptedSend([text("local", at: 100)], attachments: [])
            XCTAssertEqual(try store.session(id: "s")?.lastActivityAt, 100)
        }
        let reopened = try LocalStore.open(at: file)
        XCTAssertEqual(try reopened.session(id: "s")?.lastMessageSentAt, 100)
        XCTAssertEqual(try reopened.pendingOutbox().map(\.localId), ["local"])
        var wire = ChatRecords.storeSession("s")
        wire.updatedAt = 9000
        wire.metadataVersion = 2
        wire.metadata = .object(["path": .string("/wire")])
        try reopened.upsertSessions([wire])
        XCTAssertEqual(try reopened.session(id: "s")?.lastMessageSentAt, 100, "a wire row has no authority over the device's timestamp")
        XCTAssertEqual(try reopened.session(id: "s")?.lastActivityAt, 100)
    }

    func testDuplicateAcceptanceAndDeliveredReplayDoNotAdvanceActivityOrResurrectOutbox() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        try store.enqueueAcceptedSend([text("local", at: 100)], attachments: [])
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        try store.enqueueAcceptedSend([text("local", at: 200)], attachments: [])
        XCTAssertEqual(commits.value, 0)
        XCTAssertEqual(try store.session(id: "s")?.lastMessageSentAt, 100)
        try store.applyMessagePage(sessionId: "s", messages: [.init(id: "echo", sessionId: "s", seq: 1, localId: "local",
            createdAt: 300, updatedAt: 300, contentCipher: "", content: nil)])
        XCTAssertNil(try store.outbox(localId: "local"))
        let afterEcho = commits.value
        try store.enqueueAcceptedSend([text("local", at: 400)], attachments: [])
        XCTAssertEqual(commits.value, afterEcho)
        XCTAssertNil(try store.outbox(localId: "local"))
        XCTAssertEqual(try store.session(id: "s")?.lastMessageSentAt, 100)
    }

    func testFirstOfflineAcceptanceStampsButRefusalRetryAndFileOnlyDoNot() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        let clock = SyncEngineTests.Clock()
        clock.now = 1000
        let http = FakeHTTP()
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, now: { clock.now })
        await engine.setBackgrounded(true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try store.applySessionUpdate(id: "s", metadata: .init(version: 2, cipher: "old-cli", value: .object(["version": .string("1.2.0")])), agentState: nil, projectId: nil)
        try store.saveComposerState(.init(sessionId: "s", values: .object(["permissionMode": .string("auto")])))
        do {
            _ = try await engine.accept(.init(text: "refused"), sessionId: "s", filesDirectory: directory)
            XCTFail("unsupported send must be refused before acceptance")
        } catch is UnsupportedPermissionModeError { }
        XCTAssertNil(try store.session(id: "s")?.lastMessageSentAt)
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        try store.saveComposerState(.init(sessionId: "s"))
        let id = try await engine.accept(.init(text: "accepted offline"), sessionId: "s", filesDirectory: directory)
        await engine.waitForIdle()
        XCTAssertEqual(try store.session(id: "s")?.lastMessageSentAt, 1000)
        XCTAssertTrue(http.requests.isEmpty)
        clock.now = 2000
        try await engine.retrySend(localId: id)
        await engine.waitForIdle()
        XCTAssertEqual(try store.session(id: "s")?.lastMessageSentAt, 1000)
        try store.enqueueAcceptedSend([.init(localId: "file-only", kind: .file, sessionId: "s", payload: .null, createdAt: 3000)], attachments: [])
        XCTAssertEqual(try store.session(id: "s")?.lastMessageSentAt, 1000)
        await engine.stop()
    }

    func testChooserOrderUsesMeaningfulThenLocalSendThenCreationWithoutWireTimestampFallback() async throws {
        let store = try LocalStore.inMemory()
        var a = ChatRecords.storeSession("a")
        a.createdAt = 1
        a.updatedAt = 9000
        a.metadata = .object(["machineId": .string("m"), "path": .string("/a")])
        var b = ChatRecords.storeSession("b")
        b.createdAt = 2
        b.updatedAt = 1
        b.metadata = .object(["machineId": .string("m"), "path": .string("/b")])
        try store.upsertSessions([a, b])
        try store.upsertMachine(.init(id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            metadataVersion: 1, metadataCipher: "", metadata: .object(["host": .string("host")]), daemonStateVersion: 0,
            daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: true))
        let actor = NewSessionChoiceDeriver()
        let draft = NewSessionDraft(selectedMachineId: "m")
        func paths(_ choices: NewSessionChoiceDeriver.DerivedChoices?) -> [String]? {
            choices?.value.projectOptions.filter { $0.key == "/a" || $0.key == "/b" }.map(\.key)
        }
        let initial = await actor.choices(snapshot: try store.homeSnapshot(), revision: 0, generation: 0, draft: draft, createsBot: false, worktrees: [])
        XCTAssertEqual(paths(initial), ["/b", "/a"])
        try store.enqueueAcceptedSend([text("accepted", at: 100, sessionId: "a")], attachments: [])
        let sent = await actor.choices(snapshot: try store.homeSnapshot(), revision: 1, generation: 1, draft: draft, createsBot: false, worktrees: [])
        XCTAssertEqual(paths(sent), ["/a", "/b"])
        _ = try store.applySessionUpdate(id: "a", metadata: .init(version: 2, cipher: "wire", value: .object([
            "machineId": .string("m"), "path": .string("/a"), "lastMeaningfulMessageAt": .number(1)])), agentState: nil, projectId: nil)
        let meaningful = await actor.choices(snapshot: try store.homeSnapshot(), revision: 2, generation: 2, draft: draft, createsBot: false, worktrees: [])
        XCTAssertEqual(paths(meaningful), ["/b", "/a"], "metadata's meaningful stamp wins even when local send is newer")
        XCTAssertEqual(try store.session(id: "a")?.lastMessageSentAt, 100)
    }

    func testAcceptedSendInvalidatesHomeAndTroubleOrderingButNotRenderedChatHeader() async throws {
        let store = try LocalStore.inMemory()
        var a = ChatRecords.storeSession("a")
        a.createdAt = 1
        a.updatedAt = 10
        a.metadata = .object(["machineId": .string("m"), "path": .string("/a")])
        var b = a
        b.id = "b"
        b.createdAt = 2
        b.metadata = .object(["machineId": .string("m"), "path": .string("/b")])
        try store.upsertSessions([a, b])
        try store.upsertMachine(.init(id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            metadataVersion: 1, metadataCipher: "", metadata: .object(["host": .string("host")]), daemonStateVersion: 0,
            daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: true))
        let home = HomeFeed(store: store)
        let homeStream = home.snapshots()
        let trouble = TroubleshootingFeed(store: store)
        let troubleStream = trouble.snapshots()
        let firstHome = try await syncPerfNext(homeStream)
        let before = try XCTUnwrap(firstHome)
        XCTAssertEqual(SessionList(before).items.compactMap(\.sessionId), ["b", "a"])
        let beforeTrouble = try await syncPerfNext(troubleStream)
        let beforeNarrow = try await store.writer.read { try LocalStore.fetchTroubleshootingSnapshot($0) }
        XCTAssertEqual(beforeNarrow.recentSession?.path, "/b")
        XCTAssertEqual(beforeTrouble?.aiPrompt, "In ~/.happy, diagnose why Happy cannot reach \"host\" for project \"b\".")

        try store.enqueueAcceptedSend([text("accepted", at: 100, sessionId: "a")], attachments: [])
        let changedHome = try await syncPerfNext(homeStream)
        let after = try XCTUnwrap(changedHome)
        XCTAssertEqual(SessionList(after).items.compactMap(\.sessionId), ["a", "b"])
        XCTAssertEqual(ChatSessionState(before, sessionId: "a"), ChatSessionState(after, sessionId: "a"))
        let afterTrouble = try await syncPerfNext(troubleStream)
        let afterNarrow = try await store.writer.read { try LocalStore.fetchTroubleshootingSnapshot($0) }
        XCTAssertEqual(afterNarrow.recentSession?.path, "/a", "the narrow SQL tie-break follows the local accepted timestamp")
        XCTAssertEqual(afterTrouble?.aiPrompt, "In ~/.happy, diagnose why Happy cannot reach \"host\" for project \"a\".")
        home.stop()
        await trouble.stop()
        await store.stopSnapshotProducers()
    }
}