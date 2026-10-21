import Foundation
import XCTest
import GRDB
import HappyCrypto
@testable import HappyStore
import HappyWire
@testable import HappyCore

private struct BatchRandom: RandomSource {
    func bytes(_ count: Int) -> Data { Data(repeating: 7, count: count) }
}

private struct HoldingBatchHTTP: HTTPTransport {
    let base: FakeHTTP
    let held: Gate
    let requested: Gate
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if request.query("after_seq") == "25" {
            await requested.open()
            await held.wait()
            try Task.checkCancellation()
        }
        return try await base.send(request)
    }
}

private final class MessageCommitBytes: TransactionObserver, @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [Int64] = []
    private var batches: [[Int]] = []
    var values: [[Int]] { lock.withLock { batches } }
    func observes(eventsOfKind eventKind: DatabaseEventKind) -> Bool { eventKind.tableName == "message" }
    func databaseDidChange(with event: DatabaseEvent) { if event.kind == .insert { ids.append(event.rowID) } }
    func databaseDidCommit(_ db: Database) {
        if !ids.isEmpty {
            let sizes = ids.compactMap { id in
                (try? String.fetchOne(db, sql: "SELECT contentCipher FROM message WHERE rowid = ?", arguments: [id]))?.utf8.count
            }
            lock.withLock { batches.append(sizes) }
        }
        ids.removeAll()
    }
    func databaseDidRollback(_ db: Database) { ids.removeAll() }
}

final class SyncPerfBatchTests: XCTestCase {
    private func setup(sessionCount: Int = 10, recordsPerSession: Int = 50, options supplied: SyncEngine.Options = .init(),
                       transportFactory: (@Sendable (FakeHTTP) -> any HTTPTransport)? = nil) throws -> (LocalStore, FakeHTTP, SyncEngine) {
        let store = try LocalStore.inMemory()
        let http = FakeHTTP()
        let keys = try AccountKeys(secret: Data(repeating: 3, count: 32))
        let key = Data(repeating: 5, count: 32)
        let wrapped = Base64.encode(try keys.wrapDataKey(key, random: BatchRandom()))
        let cipher = RecordCipher(key: key)
        for index in 0..<sessionCount {
            let id = "s\(index)"
            var session = ChatRecords.storeSession(id, seq: recordsPerSession)
            session.updatedAt = Int64(sessionCount - index) // Deterministic fetch order.
            session.dataKeyCipher = wrapped
            try store.upsertSessions([session])
            let records = try (1...recordsPerSession).map { seq in
                SessionMessage(id: "\(id)-m\(seq)", seq: seq, localId: nil,
                               content: SessionMessageContent(c: try cipher.encrypt(ChatRecords.text("m\(seq)", at: Int64(seq)).raw, random: BatchRandom())),
                               createdAt: Int64(seq), updatedAt: Int64(seq))
            }
            http.on("GET /v3/sessions/\(id)/messages") { request in
                let after = Int(request.query("after_seq") ?? "0") ?? 0
                let remaining = records.filter { $0.seq > after }
                return (200, try JSONEncoder().encode(MessagesPage(messages: Array(remaining.prefix(25)), hasMore: remaining.count > 25)))
            }
        }
        var options = supplied
        options.messagesPageSize = 25
        let transport: any HTTPTransport = transportFactory?(http) ?? http
        let api = HappyAPI(serverURL: testServer, clientID: "test", transport: transport, token: "token")
        return (store, http, SyncEngine(api: api, store: store, keys: keys, options: options))
    }

    func test500RecordCatchupAcrossTenSessionsCommitsOneBatch() async throws {
        var times: [Double] = []
        for _ in 0..<5 {
            let deadline = Gate()
            var options = SyncEngine.Options()
            options.writeBatchSleep = { _ in await deadline.wait() }
            let (store, http, engine) = try setup(options: options)
            let initialHome = expectation(description: "initial home")
            let sentinelHome = expectation(description: "home sentinel")
            let homeValues = PageCounter()
            let home = store.homeObservation.start(onError: { XCTFail("\($0)") }, onChange: { value in
                homeValues.count += 1
                if homeValues.count == 1 { initialHome.fulfill() }
                if value.settings.pending["sentinel"] == .bool(true) { sentinelHome.fulfill() }
            })
            await fulfillment(of: [initialHome], timeout: 5)
            let chat = LocalChatFeed(store: store).snapshots(sessionId: "s0")
            let first = try await syncPerfNext(chat)
            XCTAssertEqual(first?.messages.count, 0)
            let commits = SyncPerfCommits()
            store.writer.add(transactionObserver: commits)
            let start = ContinuousClock.now
            try await engine.pullPendingMessages()
            let next = try await syncPerfNext(chat)
            let elapsed = start.duration(to: .now).components
            times.append(Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15)
            XCTAssertEqual(next?.messages.count, 50)
            XCTAssertEqual(commits.value, 1)
            XCTAssertEqual(http.requests.count, 20)
            for index in 0..<10 {
                XCTAssertEqual(try store.messages(sessionId: "s\(index)").count, 50)
                XCTAssertEqual(try store.session(id: "s\(index)")?.syncedMessageSeq, 50)
            }
            try store.addPendingSettings(["sentinel": .bool(true)])
            await fulfillment(of: [sentinelHome], timeout: 5)
            XCTAssertEqual(homeValues.count, 2, "initial plus sentinel; catch-up has no home-visible changes")
            home.cancel()
            await deadline.open()
            await engine.stop()
        }
        let median = times.sorted()[2]
        print("SYNC_PERF 500-record-catchup: modifying_commits=1 home_values=0 chat_values_per_session=1 median=\(median)ms runs=5")
        XCTAssertLessThan(median, 5000)
    }

    func testRequestFailureKeepsSuccessfulPagesAndTheirCursors() async throws {
        let (store, http, engine) = try setup(sessionCount: 2)
        http.on("GET /v3/sessions/s1/messages") { request in
            // The first session completes, then this request fails before
            // the batch limit. Its successful predecessor must reach disk.
            (503, Data())
        }
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        do {
            try await engine.pullPendingMessages()
            XCTFail("expected the fake request failure")
        } catch { }
        XCTAssertEqual(try store.messages(sessionId: "s0").count, 50)
        XCTAssertEqual(try store.session(id: "s0")?.syncedMessageSeq, 50)
        XCTAssertEqual(try store.session(id: "s1")?.syncedMessageSeq, 0)
        XCTAssertEqual(commits.value, 1)
        await engine.stop()
    }

    func testBatchKeepsBurnedSequenceGapsAndSkipsDeletedSessions() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession("s", seq: 10), ChatRecords.storeSession("deleted", seq: 3)])
        try store.deleteSession(id: "deleted")
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        try store.applyMessagePages([
            MessagePageWrite(sessionId: "s", messages: [ChatRecords.stored(ChatRecords.text("m3"), seq: 3)], syncedThrough: 10),
            MessagePageWrite(sessionId: "deleted", messages: [ChatRecords.stored(ChatRecords.text("gone"), seq: 1, sessionId: "deleted")], syncedThrough: 3),
        ])
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 10)
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.seq), [3])
        XCTAssertTrue(try store.messages(sessionId: "deleted").isEmpty)
        XCTAssertEqual(commits.value, 1)
    }

    func testDeadlinePublishesFirstPageWhileNextHTTPResponseIsStillHeld() async throws {
        let held = Gate(), requested = Gate()
        let (store, _, engine) = try setup(sessionCount: 1, transportFactory: { HoldingBatchHTTP(base: $0, held: held, requested: requested) })
        let chat = LocalChatFeed(store: store).snapshots(sessionId: "s0")
        _ = try await syncPerfNext(chat)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        let pulling = Task { try await engine.pullPendingMessages() }
        defer { pulling.cancel(); Task { await held.open() } }
        try await syncPerfWait(requested)
        let visible = try await syncPerfNext(chat)
        XCTAssertEqual(visible?.messages.count, 25, "deadline commits before the held response returns")
        XCTAssertEqual(try store.session(id: "s0")?.syncedMessageSeq, 25)
        XCTAssertEqual(commits.value, 1)
        await held.open()
        try await pulling.value
        XCTAssertEqual(try store.messages(sessionId: "s0").count, 50)
        XCTAssertEqual(commits.value, 2)
        await engine.stop()
    }

    func testByteLimitSplitsOneServerPageWithoutOveradvancingCursor() async throws {
        var options = SyncEngine.Options()
        // Every ciphertext is longer than 128 and shorter than 256 bytes:
        // this admits one record per transaction regardless of page size.
        options.writeBatchMaximumBytes = 256
        let (store, _, engine) = try setup(sessionCount: 1, options: options)
        let sizes = MessageCommitBytes()
        store.writer.add(transactionObserver: sizes)
        try await engine.pullPendingMessages()
        XCTAssertEqual(try store.messages(sessionId: "s0").count, 50)
        XCTAssertEqual(try store.session(id: "s0")?.syncedMessageSeq, 50)
        XCTAssertTrue(sizes.values.allSatisfy { $0.reduce(0, +) <= 256 || $0.count == 1 })
        XCTAssertGreaterThan(sizes.values.count, 1)
        XCTAssertEqual(sizes.values.flatMap { $0 }.count, 50)
        await engine.stop()
    }

    func testTinyCountLimitThenMidSessionFailureKeepsExactlyTheCompletedPage() async throws {
        var options = SyncEngine.Options()
        options.messageWriteBatchSize = 10
        let (store, http, engine) = try setup(sessionCount: 1, options: options)
        let firstPage = try await testAPI(http).messages(sessionId: "s0", afterSeq: 0, limit: 25)
        http.on("GET /v3/sessions/s0/messages") { request in
            let after = Int(request.query("after_seq") ?? "0") ?? 0
            if after == 25 { return (503, Data()) }
            return (200, try JSONEncoder().encode(firstPage))
        }
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        do { try await engine.pullPendingMessages(); XCTFail("expected mid-session failure") } catch { }
        XCTAssertEqual(try store.messages(sessionId: "s0").count, 25)
        XCTAssertEqual(try store.session(id: "s0")?.syncedMessageSeq, 25)
        XCTAssertEqual(commits.value, 3, "10, 10, then 5 downloaded records")
        await engine.stop()
    }

    func testCancellationFlushesCompletedPageBeforeHeldRequestReturns() async throws {
        let held = Gate(), requested = Gate()
        let (store, _, engine) = try setup(sessionCount: 1, transportFactory: { HoldingBatchHTTP(base: $0, held: held, requested: requested) })
        let pulling = Task { try await engine.pullPendingMessages() }
        defer { pulling.cancel(); Task { await held.open() } }
        try await syncPerfWait(requested)
        pulling.cancel()
        await held.open()
        do { try await pulling.value; XCTFail("expected cancellation") } catch { }
        XCTAssertEqual(try store.messages(sessionId: "s0").count, 25)
        XCTAssertEqual(try store.session(id: "s0")?.syncedMessageSeq, 25)
        await engine.stop()
    }
}