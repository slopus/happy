import Foundation
import GRDB
import XCTest
import HappyCrypto
import HappyStore
import HappyWire
@testable import HappyCore

private struct SessionBatchRandom: RandomSource {
    func bytes(_ count: Int) -> Data { Data(repeating: 7, count: count) }
}

private struct HoldingSessionHTTP: HTTPTransport {
    let base: FakeHTTP
    let held: Gate
    let requested: Gate
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if request.query("cursor") == "100" {
            await requested.open()
            await held.wait()
            try Task.checkCancellation()
        }
        return try await base.send(request)
    }
}

private final class SessionCommitBytes: TransactionObserver, @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [Int64] = []
    private var batches: [(count: Int, bytes: Int)] = []
    var values: [(count: Int, bytes: Int)] { lock.withLock { batches } }
    func observes(eventsOfKind eventKind: DatabaseEventKind) -> Bool { eventKind.tableName == "session" }
    func databaseDidChange(with event: DatabaseEvent) { if event.kind != .delete { ids.append(event.rowID) } }
    func databaseDidCommit(_ db: Database) {
        if !ids.isEmpty {
            let size = Set(ids).reduce(0) { total, id in
                guard let row = try? Row.fetchOne(db, sql: "SELECT metadataCipher, agentStateCipher, dataKeyCipher FROM session WHERE rowid = ?", arguments: [id]) else { return total }
                return total + ["metadataCipher", "agentStateCipher", "dataKeyCipher"].reduce(0) { sum, column in
                    let value: String? = row[column]
                    return sum + (value?.utf8.count ?? 0)
                }
            }
            lock.withLock { batches.append((Set(ids).count, size)) }
        }
        ids.removeAll()
    }
    func databaseDidRollback(_ db: Database) { ids.removeAll() }
}

final class SyncPerfSessionBatchTests: XCTestCase {
    private func fixture(count: Int, options: SyncEngine.Options = .init(),
                         transportFactory: (@Sendable (FakeHTTP) -> any HTTPTransport)? = nil) throws -> (LocalStore, FakeHTTP, SyncEngine, Int) {
        let store = try LocalStore.inMemory()
        let http = FakeHTTP()
        let keys = try AccountKeys(secret: Data(repeating: 3, count: 32))
        let key = Data(repeating: 5, count: 32)
        let wrapped = Base64.encode(try keys.wrapDataKey(key, random: SessionBatchRandom()))
        let encrypted = try RecordCipher(key: key).encrypt(.object(["title": .string("fixed"), "path": .string("/work/fixed")]), random: SessionBatchRandom())
        let rows = (0..<count).map { index in
            APISession(id: "s\(index)", seq: 0, createdAt: 1, updatedAt: 1_000_000 + Int64(index),
                       active: true, activeAt: 1_000_000, metadata: encrypted, metadataVersion: 1,
                       agentState: nil, agentStateVersion: 0, dataEncryptionKey: wrapped, projectId: nil)
        }
        http.on("GET /v2/sessions") { request in
            let offset = Int(request.query("cursor") ?? "0") ?? 0
            let end = min(count, offset + 100)
            return (200, try JSONEncoder().encode(SessionsPage(sessions: Array(rows[offset..<end]), nextCursor: end < count ? "\(end)" : nil, hasNext: end < count)))
        }
        let transport: any HTTPTransport = transportFactory?(http) ?? http
        let api = HappyAPI(serverURL: testServer, clientID: "test", transport: transport, token: "token")
        let engine = SyncEngine(api: api, store: store, keys: keys, options: options, now: { 1_000_000 })
        return (store, http, engine, encrypted.utf8.count + wrapped.utf8.count)
    }

    func test500SessionRowsAndReadinessPublishOneValueInOneCommit() async throws {
        let deadline = Gate()
        var options = SyncEngine.Options()
        options.writeBatchSleep = { _ in await deadline.wait() }
        let (store, http, engine, _) = try fixture(count: 500, options: options)
        let initial = expectation(description: "initial home")
        let ready = expectation(description: "one completed list value")
        let values = PageCounter()
        let watching = Task {
            for await value in HomeFeed(store: store).snapshots() {
                values.count += 1
                if values.count == 1 { XCTAssertFalse(value.sessionsSynced); initial.fulfill() }
                else { XCTAssertEqual(value.sessions.count, 500); XCTAssertTrue(value.sessionsSynced); ready.fulfill() }
            }
        }
        defer { watching.cancel() }
        await fulfillment(of: [initial], timeout: 5)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        let start = ContinuousClock.now
        try await engine.pullSessions()
        await fulfillment(of: [ready], timeout: 5)
        XCTAssertEqual(values.count, 2, "initial plus one production HomeFeed publication")
        XCTAssertEqual(commits.value, 1)
        XCTAssertEqual(http.requests.count, 5)
        print("SYNC_PERF 500-session-catchup: modifying_commits=1 home_values=1 duration=\(start.duration(to: .now))")
        await deadline.open()
        await engine.stop()
    }

    func testSessionDeadlinePublishesWhileNextListPageIsHeld() async throws {
        let held = Gate(), requested = Gate()
        let (store, _, engine, _) = try fixture(count: 200, transportFactory: { HoldingSessionHTTP(base: $0, held: held, requested: requested) })
        let home = HomeFeed(store: store).snapshots()
        _ = try await syncPerfNext(home)
        let pulling = Task { try await engine.pullSessions() }
        defer { pulling.cancel(); Task { await held.open() } }
        try await syncPerfWait(requested)
        let partial = try await syncPerfNext(home)
        XCTAssertEqual(partial?.sessions.count, 100)
        XCTAssertEqual(partial?.sessionsSynced, false)
        XCTAssertNil(try store.cursor(.sessionsChangedSince))
        await held.open()
        try await pulling.value
        let complete = try await syncPerfNext(home)
        XCTAssertEqual(complete?.sessions.count, 200)
        XCTAssertEqual(complete?.sessionsSynced, true)
        await engine.stop()
    }

    func testSessionByteLimitAndFailureKeepRowsWithoutAdvancingCursorOrDeleting() async throws {
        var options = SyncEngine.Options()
        options.writeBatchMaximumBytes = 512
        let (store, http, engine, rowBytes) = try fixture(count: 200, options: options)
        try store.upsertSessions([ChatRecords.storeSession("not-in-partial-list")])
        let first = try await testAPI(http).sessions(changedSince: nil, cursor: nil, limit: 100)
        http.on("GET /v2/sessions") { request in
            if request.query("cursor") != nil { return (503, Data()) }
            return (200, try JSONEncoder().encode(first))
        }
        let sizes = SessionCommitBytes()
        store.writer.add(transactionObserver: sizes)
        do { try await engine.pullSessions(); XCTFail("expected failed second page") } catch { }
        XCTAssertEqual(try store.sessions().count, 101)
        XCTAssertNotNil(try store.session(id: "not-in-partial-list"))
        XCTAssertNil(try store.cursor(.sessionsChangedSince))
        XCTAssertNil(try store.cursor(.sessionsLastFullSync))
        XCTAssertGreaterThan(sizes.values.count, 1)
        XCTAssertTrue(sizes.values.allSatisfy { $0.bytes <= max(512, rowBytes) })
        XCTAssertEqual(sizes.values.map(\.count).reduce(0, +), 100)
        await engine.stop()
    }
}