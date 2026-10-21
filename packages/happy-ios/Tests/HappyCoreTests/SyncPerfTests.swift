import Foundation
import GRDB
import XCTest
import HappyCrypto
import HappyStore
import HappyWire
@testable import HappyCore

/// Fixed keys, nonce source, IDs and payloads: no network or random fixtures.
private struct PerfRandom: RandomSource {
    func bytes(_ count: Int) -> Data { Data(repeating: 7, count: count) }
}

final class SyncPerfCommits: TransactionObserver, @unchecked Sendable {
    private let lock = NSLock()
    private var dirty = false
    private var count = 0
    var value: Int { lock.withLock { count } }
    func observes(eventsOfKind eventKind: DatabaseEventKind) -> Bool { true }
    func databaseDidChange(with event: DatabaseEvent) { dirty = true }
    func databaseDidCommit(_ db: Database) {
        if dirty { lock.withLock { count += 1 } }
        dirty = false
    }
    func databaseDidRollback(_ db: Database) { dirty = false }
}

final class SyncPerfTests: XCTestCase {
    private func median(_ name: String, runs: Int = 7, ceiling: Double = 10_000,
                        operation: () throws -> Void) rethrows -> Double {
        var times: [Double] = []
        for _ in 0..<runs {
            let start = ContinuousClock.now
            try operation()
            let duration = start.duration(to: .now).components
            times.append(Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15)
        }
        let result = times.sorted()[times.count / 2]
        print("SYNC_PERF \(name): median=\(result)ms runs=\(runs)")
        XCTAssertLessThan(result, ceiling)
        return result
    }

    func testDecodeDecryptDeltaAndListPage() throws {
        let keys = try AccountKeys(secret: Data(repeating: 3, count: 32))
        let key = Data(repeating: 5, count: 32)
        let wrapped = Base64.encode(try keys.wrapDataKey(key, random: PerfRandom()))
        let encrypted = try RecordCipher(key: key).encrypt(.object(["title": .string("fixed title")]), random: PerfRandom())
        let row = APISession(id: "s", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                             metadata: encrypted, metadataVersion: 1, agentState: nil, agentStateVersion: 0,
                             dataEncryptionKey: wrapped, projectId: nil)
        let decoder = RecordDecoder(keyRing: KeyRing(keys: keys))
        _ = decoder.session(row) // Key unwrap is cached in real sync.
        let delta = try JSONValue.object([
            "id": .string("u"), "seq": .number(1), "createdAt": .number(1),
            "body": .object(["t": .string("update-session"), "id": .string("s"),
                             "metadata": .object(["version": .number(2), "value": .string(encrypted)])]),
        ]).encoded()
        let page = try JSONEncoder().encode(SessionsPage(sessions: Array(repeating: row, count: 50), nextCursor: nil, hasNext: false))
        _ = try median("decode-decrypt-update") {
            let update = try JSONDecoder().decode(UpdateContainer.self, from: delta)
            guard case .updateSession(let body) = update.body else { return XCTFail() }
            XCTAssertEqual(decoder.versioned(body.metadata, cipher: RecordCipher(key: key))?.value?["title"], .string("fixed title"))
        }
        _ = try median("decode-decrypt-50-sessions") {
            let rows = try JSONDecoder().decode(SessionsPage.self, from: page).sessions.map { decoder.session($0) }
            XCTAssertEqual(rows.count, 50)
            XCTAssertTrue(rows.allSatisfy { $0.metadata?["title"] == .string("fixed title") })
        }
    }

    func testMergeBenchmarks() throws {
        let store = try LocalStore.inMemory()
        let rows = (0..<1000).map { index -> SessionRecord in
            var row = ChatRecords.storeSession()
            row.id = "s\(index)"
            return row
        }
        try store.upsertSessions(rows)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        _ = try median("unchanged-1000-sessions") { try store.upsertSessions(rows) }
        XCTAssertEqual(commits.value, 0)
        _ = try median("unchanged-50-sessions") { try store.upsertSessions(Array(rows.prefix(50))) }
        _ = try median("unchanged-update-session") {
            _ = try store.applySessionUpdate(id: "s0", metadata: nil, agentState: nil, projectId: nil)
        }
        print("SYNC_PERF merges: modifying_commits=\(commits.value)")
        XCTAssertEqual(commits.value, 0)
    }

    func testOneReducerAppendInto2000Messages() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        try store.applyMessagePage(sessionId: "s", messages: (1...2000).map {
            ChatRecords.stored(ChatRecords.text("m\($0)", at: Int64($0)), seq: $0)
        })
        var initial = FeedState(sessionId: "s")
        _ = initial.apply(try store.chatPage(sessionId: "s"))
        try store.applyMessagePage(sessionId: "s", messages: [ChatRecords.stored(ChatRecords.text("new", at: 2001), seq: 2001)])
        let page = try store.chatPage(sessionId: "s", afterRowId: initial.lastRowId)
        _ = median("reducer-one-append-into-2000") {
            var state = initial
            XCTAssertEqual(state.apply(page).messages.count, 2001)
            XCTAssertEqual(state.normalizedRecordCount - initial.normalizedRecordCount, 1)
            XCTAssertEqual(state.reducer.processedRecordCount - initial.reducer.processedRecordCount, 1)
        }
    }

    func testStoreToChatSnapshotLatency() async throws {
        var times: [Double] = []
        for _ in 0..<5 {
            let store = try LocalStore.inMemory()
            try store.upsertSessions([ChatRecords.storeSession()])
            try store.applyMessagePage(sessionId: "s", messages: (1...2000).map {
                ChatRecords.stored(ChatRecords.text("m\($0)", at: Int64($0)), seq: $0)
            })
            let stream = LocalChatFeed(store: store).snapshots(sessionId: "s")
            let first = try await syncPerfNext(stream)
            XCTAssertEqual(first?.messages.count, 2000)
            let start = ContinuousClock.now
            try store.applyMessagePage(sessionId: "s", messages: [ChatRecords.stored(ChatRecords.text("new", at: 2001), seq: 2001)])
            let next = try await syncPerfNext(stream)
            let duration = start.duration(to: .now).components
            times.append(Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15)
            XCTAssertEqual(next?.messages.count, 2001)
        }
        let median = times.sorted()[2]
        print("SYNC_PERF store-to-chat-2000: median=\(median)ms runs=5")
        XCTAssertLessThan(median, 2000)
    }

    @MainActor
    func testHeartbeatsPublishNothingAndCheckpointOnceOnStop() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions((0..<10).map { index in
            var row = ChatRecords.storeSession()
            row.id = "s\(index)"
            row.active = true
            row.activeAt = 1_000_000
            return row
        })
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        let clock = SyncEngineTests.Clock()
        let engine = SyncEngine(api: testAPI(FakeHTTP()), store: store,
                                keys: try AccountKeys(secret: Data(repeating: 3, count: 32)), now: { clock.now })
        let before = try store.chatPage(sessionId: "s0").change
        var deliveries = 0
        let initial = expectation(description: "first home")
        let churn = expectation(description: "no heartbeat home value")
        churn.isInverted = true
        let observation = store.observeHome { _ in
            deliveries += 1
            if deliveries == 1 { initial.fulfill() }
            else { churn.fulfill() }
        }
        await fulfillment(of: [initial], timeout: 2)
        defer { observation.cancel() }
        let firstChat = expectation(description: "first chat")
        let chatChurn = expectation(description: "no heartbeat chat value")
        chatChurn.isInverted = true
        var chatValues = 0
        let chatTask = Task {
            for await _ in LocalChatFeed(store: store).snapshots(sessionId: "s0") {
                chatValues += 1
                if chatValues == 1 { firstChat.fulfill() }
                else { chatChurn.fulfill() }
            }
        }
        await fulfillment(of: [firstChat], timeout: 2)
        defer { chatTask.cancel() }
        let start = ContinuousClock.now
        for tick in 1...15 {
            clock.now = 1_000_000 + Int64(tick * 2000)
            for index in 0..<10 {
                await engine.handle(.activity(sessionId: "s\(index)", active: true, activeAt: clock.now, thinking: false))
            }
        }
        await fulfillment(of: [churn, chatChurn], timeout: 0.05)
        XCTAssertEqual(commits.value, 0)
        XCTAssertEqual(deliveries - 1, 0)
        XCTAssertEqual(chatValues - 1, 0)
        XCTAssertEqual(try store.chatPage(sessionId: "s0").change, before)
        print("SYNC_PERF 10x30s-heartbeats: modifying_commits=\(commits.value) home_values=\(deliveries - 1) duration=\(start.duration(to: .now))")
        await engine.stop()
        XCTAssertEqual(commits.value, 1, "stop flushes all ten dirty rows in one transaction, outside the 30s scenario")
    }
}