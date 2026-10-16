import Foundation
import GRDB
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

/// sync.ts's `hasPendingUserMessage` at acceptance: the outbox's text, and
/// a delivered message the reducer still holds (`pending`) because no
/// receipt has settled it. Each send's bytes are messageMeta.ts's, from the
/// fixture its own generator wrote (`rig-idle`, `rig-idle-pending`).
final class SendingDeliveryMetaTests: XCTestCase, @unchecked Sendable {
    private static let receipts: JSONValue = .object([
        "client": .object(["id": .string("rig")]),
        "rigMetadataVersion": .number(1),
        "capabilities": .object(["messageReceipts": .bool(true)]),
    ])

    /// The keys of the last `setup()`, to read what was posted.
    private var fixture = ServerFixture()

    private func setup() throws -> (LocalStore, SyncEngine, FakeHTTP) {
        fixture = ServerFixture()
        let fixture = fixture
        let http = FakeHTTP()
        let store = try LocalStore.inMemory()
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        try store.upsertSessions([decoder.session(fixture.session("s", updatedAt: 1)), decoder.session(fixture.session("other", updatedAt: 1))])
        for id in ["s", "other"] {
            var session = try XCTUnwrap(store.session(id: id))
            session.metadata = Self.receipts
            session.metadataVersion += 1
            try store.upsertSessions([session])
        }
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, now: { 1_000 })
        return (store, engine, http)
    }

    private func wire(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "sending", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try XCTUnwrap(JSONValue.decode(Data(contentsOf: url)).arrayValue)
        let test = try XCTUnwrap(cases.first { $0["name"]?.stringValue == name })
        return Data(try XCTUnwrap(test["wire"]?.stringValue).utf8)
    }

    /// Accepts "idle" without delivering it and returns its wire bytes.
    private func acceptIdle(_ store: LocalStore, _ engine: SyncEngine, source: OutgoingMessage.Source = .chat) async throws -> Data {
        await engine.setBackgrounded(true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await engine.accept(OutgoingMessage(text: "idle", source: source), sessionId: "s", filesDirectory: directory)
        let payload = try XCTUnwrap(store.outbox(localId: id)?.payload)
        _ = try store.discardOutbox(localId: id)
        return try UserMessageEncoder.wireBytes(payload)
    }

    private static func user(_ id: String, localId: String? = nil, expects: Bool = true) -> NormalizedChatRecord {
        ChatRecords.user(id, localId: localId, expects: expects)
    }

    /// The agent-event receipt shape (typesRaw.ts:37).
    private static func rejected(_ id: String, ref: String) -> NormalizedChatRecord {
        ChatRecords.agentEvent(id, event: .object([
            "type": .string("user-message-rejected"), "ref": .string(ref), "reason": .string("busy"),
        ]))
    }

    private func store(_ records: [(NormalizedChatRecord, Int)], in store: LocalStore, session: String = "s") throws {
        for (record, seq) in records {
            try store.applyMessagePage(sessionId: session, messages: [ChatRecords.stored(record, seq: seq, sessionId: session)])
        }
    }

    func testAnIdleSessionWithNothingWaitingIsNotQueued() async throws {
        let (store, engine, _) = try setup()
        let bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle"))
        await engine.stop()
    }

    func testADeliveredMessageWithoutAReceiptQueuesTheNext() async throws {
        let (store, engine, _) = try setup()
        try self.store([(Self.user("m1", localId: "l1"), 1)], in: store)
        let bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle-pending"))
        await engine.stop()
    }

    func testAnAcceptedOrRejectedMessageNoLongerQueues() async throws {
        for receipt in [ChatRecords.receipt("r", ref: "m1"), Self.rejected("r", ref: "m1")] {
            let (store, engine, _) = try setup()
            try self.store([(Self.user("m1", localId: "l1"), 1), (receipt, 2)], in: store)
            let bytes = try await acceptIdle(store, engine)
            XCTAssertEqual(bytes, try wire("rig-idle"))
            await engine.stop()
        }
    }

    /// The reducer keeps a receipt that arrives first for the row it names.
    func testAReceiptStoredBeforeItsMessageSettlesIt() async throws {
        let (store, engine, _) = try setup()
        try self.store([(ChatRecords.receipt("r", ref: "m1"), 2), (Self.user("m1", localId: "l1"), 1)], in: store)
        let bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle"))
        await engine.stop()
    }

    /// Only a message sent asking for acceptance is held: one replayed from
    /// before receipts never is (pendingUserMessages.spec.ts).
    func testAMessageThatAskedForNoAcceptanceIsNotWaiting() async throws {
        let (store, engine, _) = try setup()
        try self.store([(Self.user("m1", localId: "l1", expects: false), 1)], in: store)
        let bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle"))
        await engine.stop()
    }

    func testAnotherSessionsWaitingMessageDoesNotCount() async throws {
        let (store, engine, _) = try setup()
        try self.store([(Self.user("m1", localId: "l1"), 1)], in: store, session: "other")
        let bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle"))
        await engine.stop()
    }

    /// The chat's reducer folds only its window: an older island a newest
    /// page left out is not something it holds.
    func testAMessageOutsideTheChatsWindowDoesNotCount() async throws {
        let (store, engine, _) = try setup()
        try self.store([(Self.user("old", localId: "l0"), 3), (ChatRecords.text("a"), 20)], in: store)
        try await store.writer.write { db in
            try db.execute(sql: """
                INSERT INTO chatHistory (sessionId, newestLoaded, oldestRawSeq, newestRawSeq, serverHasMore, checkedThroughSeq)
                VALUES ('s', 1, 20, 20, 1, 20)
                """)
            try db.execute(sql: "UPDATE session SET syncedMessageSeq = 0 WHERE id = 's'")
        }
        var bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle"))
        // The same message inside the window is waiting.
        try self.store([(Self.user("new", localId: "l1"), 21)], in: store)
        bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle-pending"))
        await engine.stop()
    }

    /// Startup is not a previous turn to wait for (messageMeta.ts).
    func testANewSessionsFirstMessageIsNeverQueued() async throws {
        let (store, engine, _) = try setup()
        try self.store([(Self.user("m1", localId: "l1"), 1)], in: store)
        let bytes = try await acceptIdle(store, engine, source: .newSession)
        let meta = try JSONValue.decode(bytes)["meta"]
        XCTAssertEqual(meta?["expectsAcceptance"], .bool(true))
        XCTAssertEqual(meta?["queuedWhileBusy"], .bool(false))
        await engine.stop()
    }

    /// The window the outbox alone missed: the first send is delivered and
    /// out of the outbox, the daemon hasn't accepted it, and `thinking`
    /// hasn't moved. The next send is queued until the receipt arrives.
    func testTheNextSendIsQueuedBetweenDeliveryAndAcceptance() async throws {
        let (store, engine, http) = try setup()
        // Read from what was posted: delivery starts at acceptance and may
        // empty the outbox before the test could look there.
        let posted = PostedMeta()
        let cipher = RecordCipher(key: fixture.dataKey)
        http.on("POST /v3/sessions/s/messages") { request in
            let item = try request.jsonBody(SendMessagesRequest.self).messages[0]
            posted.record(try XCTUnwrap(cipher.decrypt(base64: item.content))["meta"])
            return (200, Data(#"{"messages":[{"id":"m1","seq":1,"localId":"\#(item.localId)","createdAt":1,"updatedAt":1}]}"#.utf8))
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try await engine.accept(OutgoingMessage(text: "first"), sessionId: "s", filesDirectory: directory)
        await engine.waitForIdle()
        XCTAssertEqual(posted.metas.map { $0?["queuedWhileBusy"] }, [.bool(false)], "delivered once, not queued")
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        XCTAssertEqual(try store.acceptanceRecords(sessionId: "s").map(\.id), ["m1"])

        var bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle-pending"))

        try self.store([(ChatRecords.receipt("r", ref: "m1"), 2)], in: store)
        bytes = try await acceptIdle(store, engine)
        XCTAssertEqual(bytes, try wire("rig-idle"))
        await engine.stop()
    }

    /// The prefilter reads only what can hold or settle a user row.
    func testAcceptanceRecordsLeaveAgentOutputOut() throws {
        let (store, _, _) = try setup()
        try self.store([
            (Self.user("m1", localId: "l1"), 1), (ChatRecords.text("a"), 2),
            (ChatRecords.receipt("r", ref: "m1"), 3), (Self.rejected("x", ref: "m9"), 4),
        ], in: store)
        XCTAssertEqual(try store.acceptanceRecords(sessionId: "s").map(\.id), ["m1", "r", "x"])
        XCTAssertTrue(try store.acceptanceRecords(sessionId: "missing").isEmpty)
    }
}

/// The meta of each message the fake server received.
private final class PostedMeta: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [JSONValue?] = []
    var metas: [JSONValue?] { lock.withLock { values } }
    func record(_ meta: JSONValue?) { lock.withLock { values.append(meta) } }
}
