import Foundation
import GRDB
import XCTest
import HappyCrypto
@testable import HappyStore
import HappyWire
@testable import HappyCore

private struct HistoryRandom: RandomSource {
    func bytes(_ count: Int) -> Data { Data(repeating: 7, count: count) }
}

private struct HistoryFixture: Sendable {
    let store: LocalStore
    let http: FakeHTTP
    let keys: AccountKeys
    let cipher: RecordCipher

    init(seq: Int = 10, configuration: Configuration? = nil) throws {
        let keys = try AccountKeys(secret: Data(repeating: 3, count: 32))
        let key = Data(repeating: 5, count: 32)
        let cipher = RecordCipher(key: key)
        let wrapped = Base64.encode(try keys.wrapDataKey(key, random: HistoryRandom()))
        let metadata = try cipher.encrypt(.object(["path": .string("/work/project")]), random: HistoryRandom())
        let store: LocalStore
        if let configuration { store = try LocalStore(writer: DatabaseQueue(configuration: configuration)) }
        else { store = try LocalStore.inMemory() }
        let decoder = RecordDecoder(keyRing: KeyRing(keys: keys))
        try store.upsertSessions([decoder.session(APISession(
            id: "s", seq: seq, createdAt: 1, updatedAt: 1000, active: false, activeAt: 1,
            metadata: metadata, metadataVersion: 1, agentState: nil, agentStateVersion: 0,
            dataEncryptionKey: wrapped, projectId: nil
        ))])
        self.store = store; self.http = FakeHTTP(); self.keys = keys; self.cipher = cipher
    }

    func message(_ seq: Int, hidden: Bool = false) throws -> SessionMessage {
        let event: JSONValue = hidden ? .object(["t": .string("turn-start")])
            : .object(["t": .string("text"), "text": .string("token \(seq)")])
        let value = JSONValue.object([
            "role": .string("session"), "content": .object([
                "id": .string("e\(seq)"), "time": .number(Double(seq * 1000)),
                "role": .string("agent"), "turn": .string("t\(seq)"), "ev": event,
            ]),
        ])
        return SessionMessage(id: "m\(seq)", seq: seq, localId: nil,
                              content: SessionMessageContent(c: try cipher.encrypt(value, random: HistoryRandom())),
                              createdAt: Int64(seq) * 1000, updatedAt: Int64(seq) * 1000)
    }

    func history(transport: (any HTTPTransport)? = nil) -> ChatHistory {
        let api = HappyAPI(serverURL: testServer, clientID: "test", transport: transport ?? http, token: "test")
        return ChatHistory(api: api, store: store, keys: keys, pageSize: 2)
    }
}

private struct HeldHistoryHTTP: HTTPTransport {
    let base: FakeHTTP
    let before: String
    let requested: Gate
    let release: Gate
    var ignoresCancellation = false
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if request.query("before_seq") == before {
            await requested.open()
            await release.wait()
            if !ignoresCancellation { try Task.checkCancellation() }
        }
        return try await base.send(request)
    }
}

private final class HistoryOverlapCounts: @unchecked Sendable {
    private let lock = NSLock()
    private var fetches = 0, pages = 0, raw = 0, publications = 0, derivations = 0
    private var pageFence: Int?
    let registered = Gate(), drained = Gate()
    var values: [Int] { lock.withLock { [fetches, pages, raw, publications, derivations] } }
    func trace(_ event: Database.TraceEvent) {
        let sql = event.description.lowercased()
        if sql.contains("select count(*) as count, coalesce(max(rowid)") {
            let ready = lock.withLock { fetches += 1; return fetches == 3 }
            if ready { Task { await registered.open() } }
        }
        if sql.contains("select * from message where sessionid") {
            let done = lock.withLock { pages += 1; return pages == pageFence }
            if done { Task { await drained.open() } }
        }
    }
    func delivered() { lock.withLock { raw += 1 } }
    func derived() { lock.withLock { publications += 1; derivations += 1 } }
    func armFence() { lock.withLock { pageFence = pages + 1 } }
}

final class ChatHistoryTests: XCTestCase {
    private let newest = "2147483647"
    private let route = "GET /v3/sessions/s/messages"

    private func texts(_ snapshot: ChatSnapshot?) -> [String] {
        snapshot?.messages.compactMap { if case .agentText(let message) = $0 { return message.text }; return nil } ?? []
    }

    func testNewestRequestReversesDescendingPageAndLoadsChatWithoutAdvancingPrefix() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        let request = try XCTUnwrap(fixture.http.requests.first)
        XCTAssertEqual(request.query("before_seq"), newest)
        XCTAssertNil(request.query("after_seq"))
        XCTAssertEqual(request.query("limit"), "2")
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").map(\.seq), [9, 10])
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 0)
        let chat = try await syncPerfNext(LocalChatFeed(store: fixture.store).snapshots(sessionId: "s"))
        XCTAssertEqual(chat?.isLoaded, true)
        XCTAssertEqual(texts(chat), ["token 9", "token 10"])
        let state = await history.current(sessionId: "s")
        XCTAssertTrue(state.initialLoaded); XCTAssertTrue(state.hasMore)
        XCTAssertEqual(state.oldestSeq, 9)
        await history.stop()
        // A new account scope can use the downloaded tail offline, including
        // its loaded marker, even while the forward prefix is still zero.
        let offline = FakeHTTP()
        let reopened = fixture.history(transport: offline)
        await reopened.ensureNewest(sessionId: "s")
        XCTAssertTrue(offline.requests.isEmpty)
        await reopened.stop()
    }

    func testConcurrentNewestAndOlderCallsShareTheirRequests() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route) { request in
            let rows = request.query("before_seq") == "9" ? [8, 7] : [10, 9]
            return (200, try JSONEncoder().encode(MessagesPage(messages: try rows.map { try fixture.message($0) }, hasMore: true)))
        }
        let newestRequested = Gate(), newestRelease = Gate()
        let first = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: newest,
                                                              requested: newestRequested, release: newestRelease))
        let a = Task { await first.ensureNewest(sessionId: "s") }
        try await syncPerfWait(newestRequested)
        let newestJoined = expectation(description: "second newest caller joined held request")
        await first.observeCoalescing { kind in
            if kind == .newest { newestJoined.fulfill() }
        }
        let b = Task { await first.ensureNewest(sessionId: "s") }
        await fulfillment(of: [newestJoined], timeout: 5)
        await newestRelease.open()
        await a.value; await b.value
        XCTAssertEqual(fixture.http.requests.count, 1)
        await first.stop()
        let liveChat = LocalChatFeed(store: fixture.store).snapshots(sessionId: "s")
        _ = try await syncPerfNext(liveChat)
        let olderRequested = Gate(), olderRelease = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: "9",
                                                                requested: olderRequested, release: olderRelease))
        let c = Task { await history.loadOlder(sessionId: "s") }
        try await syncPerfWait(olderRequested)
        let olderJoined = expectation(description: "second older caller joined held intent")
        await history.observeCoalescing { kind in
            if kind == .older { olderJoined.fulfill() }
        }
        let d = Task { await history.loadOlder(sessionId: "s") }
        await fulfillment(of: [olderJoined], timeout: 5)
        await olderRelease.open()
        let result = await c.value
        let shared = await d.value
        XCTAssertEqual(result, shared)
        XCTAssertTrue(result.advanced)
        XCTAssertFalse(result.failed)
        XCTAssertEqual(result.oldestSeq, 7)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, "9"])
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 0)
        let chat = try await syncPerfNext(liveChat)
        XCTAssertEqual(texts(chat), ["token 7", "token 8", "token 9", "token 10"])
        await history.stop()
    }

    func testOlderIntentsCoalesceWhileWaitingForInitialNewest() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route) { request in
            let rows = request.query("before_seq") == "9" ? [8, 7] : [10, 9]
            return (200, try JSONEncoder().encode(MessagesPage(messages: try rows.map { try fixture.message($0) }, hasMore: true)))
        }
        let requested = Gate(), release = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: newest,
                                                                requested: requested, release: release))
        let a = Task { await history.loadOlder(sessionId: "s") }
        try await syncPerfWait(requested)
        let joined = expectation(description: "older callers share intent while newest is held")
        await history.observeCoalescing { kind in
            if kind == .older { joined.fulfill() }
        }
        let b = Task { await history.loadOlder(sessionId: "s") }
        await fulfillment(of: [joined], timeout: 5)
        await release.open()
        let first = await a.value, second = await b.value
        XCTAssertEqual(first, second)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, "9"])
        await history.stop()
    }

    func testInvisibleEventsAndBurnedSeqsAdvanceTheRawOlderCursor() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route) { request in
            let latest = request.query("before_seq") == "2147483647"
            let rows = latest ? [10, 9] : [7, 5]
            return (200, try JSONEncoder().encode(MessagesPage(messages: try rows.map { try fixture.message($0, hidden: true) }, hasMore: latest)))
        }
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        let empty = try await syncPerfNext(LocalChatFeed(store: fixture.store).snapshots(sessionId: "s"))
        XCTAssertEqual(empty?.isLoaded, true)
        XCTAssertTrue(empty?.messages.isEmpty == true)
        let older = await history.loadOlder(sessionId: "s")
        XCTAssertTrue(older.advanced)
        XCTAssertFalse(older.hasMore)
        let state = await history.current(sessionId: "s")
        XCTAssertEqual(state.oldestSeq, 5)
        XCTAssertFalse(state.hasMore)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, "9"])
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").map(\.seq), [5, 7, 9, 10])
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 0)
        await history.stop()
    }

    func testLoadingAndFailureDoNotPublishChatOrDiscardRowsAndRetryRecovers() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        var session = try XCTUnwrap(fixture.store.session(id: "s"))
        session.seq = 12
        try fixture.store.upsertSessions([session])
        let chat = LocalChatFeed(store: fixture.store).snapshots(sessionId: "s")
        _ = try await syncPerfNext(chat)
        let unexpected = expectation(description: "status-only error changes do not publish chat")
        unexpected.isInverted = true
        let watching = Task { for await _ in chat { unexpected.fulfill() } }
        let commits = SyncPerfCommits()
        fixture.store.writer.add(transactionObserver: commits)
        fixture.http.onRaw(route, "offline", status: 503)
        await history.ensureNewest(sessionId: "s")
        let failed = await history.current(sessionId: "s")
        XCTAssertEqual(failed.error?.operation, .newest)
        XCTAssertTrue(failed.initialLoaded)
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").map(\.seq), [9, 10])
        XCTAssertEqual(commits.value, 0)
        await fulfillment(of: [unexpected], timeout: 0.05)
        watching.cancel()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(12), try fixture.message(11)], hasMore: true))
        await history.retry(sessionId: "s", operation: .newest)
        let recovered = await history.current(sessionId: "s")
        XCTAssertNil(recovered.error)
        XCTAssertEqual(commits.value, 1)
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").map(\.seq), [9, 10, 11, 12])
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 0)
        await history.stop()
    }

    func testOlderFailureRetriesTheSameRawCursor() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        fixture.http.onRaw(route, "offline", status: 503)
        let failed = await history.loadOlder(sessionId: "s")
        XCTAssertFalse(failed.advanced)
        XCTAssertTrue(failed.failed)
        XCTAssertEqual(failed.oldestSeq, 9)
        let state = await history.current(sessionId: "s")
        XCTAssertEqual(state.oldestSeq, 9)
        XCTAssertEqual(state.error?.operation, .older)
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(8), try fixture.message(7)], hasMore: true))
        await history.retry(sessionId: "s", operation: .older)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, "9", "9"])
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").map(\.seq), [7, 8, 9, 10])
        let recovered = await history.current(sessionId: "s")
        XCTAssertNil(recovered.error)
        await history.stop()
    }

    func testCoalescedOlderFailuresShareExplicitFailureAndRetrySameCursor() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let newestHistory = fixture.history()
        await newestHistory.ensureNewest(sessionId: "s")
        await newestHistory.stop()
        fixture.http.onRaw(route, "offline", status: 503)
        let requested = Gate(), release = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: "9",
                                                                requested: requested, release: release))
        let a = Task { await history.loadOlder(sessionId: "s") }
        try await syncPerfWait(requested)
        let joined = expectation(description: "second caller shares failed request")
        await history.observeCoalescing { kind in if kind == .older { joined.fulfill() } }
        let b = Task { await history.loadOlder(sessionId: "s") }
        await fulfillment(of: [joined], timeout: 5)
        await release.open()
        let first = await a.value, second = await b.value
        XCTAssertEqual(first, second)
        XCTAssertTrue(first.failed)
        XCTAssertFalse(first.advanced)
        XCTAssertEqual(first.oldestSeq, 9)
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(8), try fixture.message(7)], hasMore: true))
        await history.retry(sessionId: "s", operation: .older)
        let recovered = await history.current(sessionId: "s")
        XCTAssertNil(recovered.error)
        XCTAssertEqual(recovered.oldestSeq, 7)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, "9", "9"])
        await history.stop()
    }

    func testOlderFailureResultSurvivesConcurrentNewestClearingErrorAndCanRetry() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let initial = fixture.history()
        await initial.ensureNewest(sessionId: "s")
        await initial.stop()
        fixture.http.on(route) { request in
            if request.query("before_seq") == "9" { return (503, Data("offline".utf8)) }
            return (200, try JSONEncoder().encode(MessagesPage(messages: [try fixture.message(12), try fixture.message(11)], hasMore: true)))
        }
        let requested = Gate(), release = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: "9",
                                                                requested: requested, release: release))
        let older = Task { await history.loadOlder(sessionId: "s") }
        try await syncPerfWait(requested)
        var session = try XCTUnwrap(fixture.store.session(id: "s"))
        session.seq = 12
        try fixture.store.upsertSessions([session])
        let joined = expectation(description: "newest waits on the held older request")
        await history.observeCoalescing { kind in if kind == .newest { joined.fulfill() } }
        let newest = Task { await history.ensureNewest(sessionId: "s") }
        await fulfillment(of: [joined], timeout: 5)
        await release.open()
        let result = await older.value
        await newest.value
        let current = await history.current(sessionId: "s")
        XCTAssertNil(current.error, "newest success cleared the scalar error")
        XCTAssertTrue(result.failed, "the exact older request remains failed for the paging policy")
        XCTAssertFalse(result.advanced)
        XCTAssertEqual(result.oldestSeq, 9)
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(8), try fixture.message(7)], hasMore: true))
        let operation = try XCTUnwrap(result.failureOperation)
        XCTAssertEqual(operation, .older)
        let retried = await history.retry(sessionId: "s", operation: operation)
        XCTAssertFalse(retried.failed)
        XCTAssertTrue(retried.advanced)
        XCTAssertEqual(retried.oldestSeq, 7)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, ["2147483647", "9", "2147483647", "9"])
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 0)
        await history.stop()
    }

    func testCachedPrefixWithoutMarkerRetriesNewestThroughOlderEndOutcome() async throws {
        let fixture = try HistoryFixture()
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        let prefix = try (1...5).map { decoder.message(try fixture.message($0), sessionId: "s", cipher: fixture.cipher) }
        try fixture.store.applyMessagePage(sessionId: "s", messages: prefix)
        let stream = LocalChatFeed(store: fixture.store).snapshots(sessionId: "s")
        let cached = try await syncPerfNext(stream)
        XCTAssertEqual(texts(cached), (1...5).map { "token \($0)" })
        XCTAssertEqual(cached?.isLoaded, true)
        XCTAssertEqual(cached?.hasMoreOlder, true, "no marker means coverage is still unknown")
        fixture.http.onRaw(route, "offline", status: 503)
        let history = fixture.history()
        let partial = await history.current(sessionId: "s")
        XCTAssertTrue(partial.hasMore)
        let failed = await history.loadOlder(sessionId: "s")
        XCTAssertTrue(failed.failed)
        XCTAssertEqual(failed.failureOperation, .newest)
        XCTAssertTrue(failed.hasMore)
        XCTAssertNil(failed.oldestSeq)
        XCTAssertEqual(fixture.http.requests.count, 1, "a failed newest attempt does not immediately repeat")
        fixture.http.on(route) { request in
            let rows = request.query("before_seq") == "9" ? [8, 7] : [10, 9]
            return (200, try JSONEncoder().encode(MessagesPage(messages: try rows.map { try fixture.message($0) }, hasMore: true)))
        }
        let recovered = await history.retry(sessionId: "s", operation: .older)
        XCTAssertFalse(recovered.failed)
        XCTAssertTrue(recovered.advanced)
        XCTAssertEqual(recovered.oldestSeq, 7)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, newest, "9"])
        var tail = try await syncPerfNext(stream)
        if let boundary = tail?.olderBoundary, boundary > 7 { tail = try await syncPerfNext(stream) }
        XCTAssertEqual(texts(tail), (7...10).map { "token \($0)" })
        XCTAssertEqual(tail?.olderBoundary, 7)
        XCTAssertEqual(tail?.windowEpoch, 1)
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 5)
        await history.stop()
    }

    func testJoinedNewestFailureKeepsItsOperationAfterConcurrentNewestRecovery() async throws {
        let fixture = try HistoryFixture()
        fixture.http.onRaw(route, "offline", status: 503)
        let requested = Gate(), release = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: newest,
                                                                requested: requested, release: release))
        let historyRoute = route
        let initialAndRecovery = Task {
            await history.ensureNewest(sessionId: "s")
            fixture.http.on(historyRoute, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
            await history.ensureNewest(sessionId: "s")
        }
        try await syncPerfWait(requested)
        let joined = expectation(description: "older caller awaits the exact held newest request")
        await history.observeCoalescing { kind in if kind == .older { joined.fulfill() } }
        let older = Task { await history.loadOlder(sessionId: "s") }
        await fulfillment(of: [joined], timeout: 5)
        await release.open()
        let result = await older.value
        try await initialAndRecovery.value
        let current = await history.current(sessionId: "s")
        XCTAssertNil(current.error)
        XCTAssertTrue(result.failed)
        XCTAssertEqual(result.failureOperation, .newest)
        let operation = try XCTUnwrap(result.failureOperation)
        let alreadyRecovered = await history.retry(sessionId: "s", operation: operation)
        XCTAssertFalse(alreadyRecovered.failed)
        XCTAssertEqual(alreadyRecovered.oldestSeq, 9)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, newest],
                       "retrying the captured newest operation reuses its recovered tail, not an older HTTP request")
        await history.stop()
    }

    func testCoalescedOlderCallsShareOneFailedInitialNewestAttempt() async throws {
        let fixture = try HistoryFixture()
        fixture.http.onRaw(route, "offline", status: 503)
        let requested = Gate(), release = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: newest,
                                                                requested: requested, release: release))
        let a = Task { await history.loadOlder(sessionId: "s") }
        try await syncPerfWait(requested)
        let joined = expectation(description: "second older caller shares held newest failure")
        await history.observeCoalescing { kind in if kind == .older { joined.fulfill() } }
        let b = Task { await history.loadOlder(sessionId: "s") }
        await fulfillment(of: [joined], timeout: 5)
        await release.open()
        let first = await a.value, second = await b.value
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.failureOperation, .newest)
        XCTAssertTrue(first.failed)
        XCTAssertFalse(first.advanced)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest])
        await history.stop()
    }

    func testCompletePrefixWithoutMarkerHasNoOlderOrNewestNetworkRequests() async throws {
        let fixture = try HistoryFixture()
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        let messages = try (1...10).map {
            decoder.message(try fixture.message($0), sessionId: "s", cipher: fixture.cipher)
        }
        try fixture.store.applyMessagePage(sessionId: "s", messages: messages, syncedThrough: 10)
        let disk = try await syncPerfNext(LocalChatFeed(store: fixture.store).snapshots(sessionId: "s"))
        XCTAssertEqual(disk?.isLoaded, true)
        XCTAssertEqual(disk?.hasMoreOlder, false)
        XCTAssertEqual(texts(disk), (1...10).map { "token \($0)" })
        let history = fixture.history()
        let state = await history.current(sessionId: "s")
        XCTAssertFalse(state.hasMore)
        await history.ensureNewest(sessionId: "s")
        let older = await history.loadOlder(sessionId: "s")
        let retried = await history.retry(sessionId: "s", operation: .older)
        XCTAssertFalse(older.hasMore)
        XCTAssertFalse(older.failed)
        XCTAssertFalse(retried.hasMore)
        XCTAssertFalse(retried.failed)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [])
        XCTAssertNil(try fixture.store.chatHistoryCoverage(sessionId: "s")?.marker)
        await history.stop()
        let empty = try HistoryFixture(seq: 10)
        // Burned sequences can prove full coverage without any message rows.
        try empty.store.applyMessagePage(sessionId: "s", messages: [], syncedThrough: 10)
        let loadedEmpty = try await syncPerfNext(LocalChatFeed(store: empty.store).snapshots(sessionId: "s"))
        XCTAssertEqual(loadedEmpty?.isLoaded, true)
        XCTAssertEqual(loadedEmpty?.hasMoreOlder, false)
        XCTAssertEqual(loadedEmpty?.messages, [])
        let emptyHistory = empty.history()
        await emptyHistory.ensureNewest(sessionId: "s")
        _ = await emptyHistory.loadOlder(sessionId: "s")
        XCTAssertEqual(empty.http.requests.count, 0)
        await emptyHistory.stop()
    }

    func testExhaustedOlderResultDoesNotInheritAStaleNewestFailure() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: false))
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        var session = try XCTUnwrap(fixture.store.session(id: "s"))
        session.seq = 12
        try fixture.store.upsertSessions([session])
        fixture.http.onRaw(route, "offline", status: 503)
        await history.ensureNewest(sessionId: "s")
        let current = await history.current(sessionId: "s")
        XCTAssertEqual(current.error?.operation, .newest)
        let older = await history.loadOlder(sessionId: "s")
        XCTAssertFalse(older.failed)
        XCTAssertNil(older.failureOperation)
        XCTAssertFalse(older.advanced)
        XCTAssertFalse(older.hasMore)
        XCTAssertEqual(older.oldestSeq, 9)
        XCTAssertEqual(fixture.http.requests.count, 2)
        await history.stop()
    }

    func testUnchangedHistoryAndPrefixOverlapFetchesAndDerivesNoChat() async throws {
        let counts = HistoryOverlapCounts()
        var configuration = Configuration()
        configuration.foreignKeysEnabled = true
        configuration.prepareDatabase { db in db.trace { counts.trace($0) } }
        let fixture = try HistoryFixture(configuration: configuration)
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        let messages = try [9, 10].map { decoder.message(try fixture.message($0), sessionId: "s", cipher: fixture.cipher) }
        try fixture.store.applyMessagePage(sessionId: "s", messages: messages, syncedThrough: 10)
        try fixture.store.applyChatHistoryPage(sessionId: "s", messages: messages,
                                               hasMore: true, page: .newest(checkedThroughSeq: 10))
        let initialRaw = expectation(description: "raw Chat observation starts")
        let fenceRaw = expectation(description: "raw Chat observer sees the visible-region fence")
        let raw = ValueObservation.tracking { db in
            try LocalStore.fetchChatChange(db, sessionId: "s")
        }.start(in: fixture.store.writer, scheduling: .async(onQueue: DispatchQueue(label: "history-overlap")),
                onError: { XCTFail("\($0)") }, onChange: { change in
            XCTAssertFalse(Thread.isMainThread)
            counts.delivered()
            if change.session?.agentStateVersion == 0 { initialRaw.fulfill() }
            else { fenceRaw.fulfill() }
        })
        defer { raw.cancel() }
        let initialChat = expectation(description: "production Chat feed is derived")
        let watching = Task.detached {
            let pass = ApplyPerfChatRowsTests.Pass()
            for await snapshot in LocalChatFeed(store: fixture.store).snapshots(sessionId: "s") {
                XCTAssertFalse(Thread.isMainThread)
                _ = pass.derive(snapshot.messages)
                counts.derived()
                initialChat.fulfill()
            }
        }
        defer { watching.cancel() }
        await fulfillment(of: [initialRaw, initialChat], timeout: 5)
        try await syncPerfWait(counts.registered)
        let baseline = counts.values
        XCTAssertEqual(baseline, [3, 1, 1, 1, 1])
        let commits = SyncPerfCommits()
        fixture.store.writer.add(transactionObserver: commits)
        let started = ContinuousClock.now
        for _ in 0..<100 {
            try fixture.store.applyChatHistoryPage(sessionId: "s", messages: messages,
                                                   hasMore: true, page: .newest(checkedThroughSeq: 10))
            try fixture.store.applyMessagePage(sessionId: "s", messages: messages, syncedThrough: 10)
        }
        let elapsed = started.duration(to: .now)
        XCTAssertEqual(commits.value, 0, "ignored duplicates and unchanged markers/cursors modify no rows")
        counts.armFence()
        _ = try fixture.store.applySessionUpdate(id: "s", metadata: nil,
            agentState: VersionedPayload(version: 1, cipher: "fence", value: nil), projectId: nil)
        await fulfillment(of: [fenceRaw], timeout: 5)
        try await syncPerfWait(counts.drained)
        XCTAssertEqual(counts.values, [baseline[0] + 3, baseline[1] + 1, 2, 1, 1],
                       "only the fence fetches the two observations and one page; no duplicate delivery or Chat derivation")
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").count, 2)
        print("HISTORY_OVERLAP 100 tail+prefix duplicate writes: modifying_commits=0 chat_sql_fetches=0 raw_deliveries=0 publications=0 derives=0 elapsed=\(elapsed)")
    }

    func testNewestAndBackgroundPrefixDownloadOverlapButStoreOneCopyAndPreserveCursor() async throws {
        let fixture = try HistoryFixture()
        let tail = try [10, 9].map { try fixture.message($0) }
        let prefix = try (1...10).map { try fixture.message($0) }
        fixture.http.on(route) { request in
            let rows = request.query("before_seq") != nil ? tail : prefix
            return (200, try JSONEncoder().encode(MessagesPage(messages: rows, hasMore: false)))
        }
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 0)
        let api = HappyAPI(serverURL: testServer, clientID: "test", transport: fixture.http, token: "test")
        let engine = SyncEngine(api: api, store: fixture.store, keys: fixture.keys)
        let start = ContinuousClock.now
        try await engine.pullMessages(sessionId: "s")
        let elapsed = start.duration(to: .now)
        XCTAssertEqual(fixture.http.requests.map { $0.query("before_seq") }, [newest, nil])
        XCTAssertEqual(fixture.http.requests.map { $0.query("after_seq") }, [nil, "0"])
        let stored = try fixture.store.messages(sessionId: "s")
        XCTAssertEqual(stored.map(\.seq), Array(1...10))
        XCTAssertTrue(stored.allSatisfy { $0.content != nil })
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 10)
        print("HISTORY_INITIAL_FILL received_encrypted_rows=12 overlap_rows=2 stored_rows=10 prefix_fill_elapsed=\(elapsed); both paths decode each received row off-main")
        await engine.stop(); await history.stop()
    }

    func testInvalidEmptyHasMoreCannotAdvanceAndEmptyCompletionIsLoaded() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [], hasMore: true))
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        let invalid = await history.current(sessionId: "s")
        XCTAssertNotNil(invalid.error)
        XCTAssertNil(invalid.oldestSeq)
        XCTAssertNil(try fixture.store.chatHistoryCoverage(sessionId: "s")?.marker)
        fixture.http.on(route, json: MessagesPage(messages: [], hasMore: false))
        await history.retry(sessionId: "s", operation: .newest)
        let loaded = await history.current(sessionId: "s")
        XCTAssertTrue(loaded.initialLoaded)
        XCTAssertFalse(loaded.hasMore)
        let chat = try await syncPerfNext(LocalChatFeed(store: fixture.store).snapshots(sessionId: "s"))
        XCTAssertEqual(chat?.isLoaded, true)
        XCTAssertEqual(chat?.messages, [])
        _ = await history.loadOlder(sessionId: "s")
        XCTAssertEqual(fixture.http.requests.count, 2)
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 0)
        await history.stop()
    }

    func testForwardPrefixJoiningTailAvoidsAnotherOlderRequest() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let history = fixture.history()
        await history.ensureNewest(sessionId: "s")
        try fixture.store.applyMessagePage(sessionId: "s", messages: [], syncedThrough: 8)
        let result = await history.loadOlder(sessionId: "s")
        XCTAssertFalse(result.hasMore)
        XCTAssertFalse(result.advanced)
        XCTAssertEqual(fixture.http.requests.count, 1)
        XCTAssertEqual(try fixture.store.session(id: "s")?.syncedMessageSeq, 8)
        await history.stop()
    }

    func testStopDrainsAndRejectsACancellationIgnoringLateResponse() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let requested = Gate(), release = Gate(), closed = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: newest,
                                                                requested: requested, release: release,
                                                                ignoresCancellation: true))
        let stream = history.snapshots(sessionId: "s")
        _ = try await syncPerfNext(stream)
        let watching = Task { for await _ in stream { }; await closed.open() }
        let loading = Task { await history.ensureNewest(sessionId: "s") }
        try await syncPerfWait(requested)
        let stopping = Task { await history.stop() }
        try await syncPerfWait(closed)
        let secondDone = expectation(description: "a second stop joins the first drain")
        secondDone.isInverted = true
        let secondStop = Task { await history.stop(); secondDone.fulfill() }
        await fulfillment(of: [secondDone], timeout: 0.05)
        await release.open()
        await stopping.value; await secondStop.value; await loading.value; await watching.value
        XCTAssertEqual(try fixture.store.messages(sessionId: "s"), [])
        XCTAssertNil(try fixture.store.chatHistoryCoverage(sessionId: "s")?.marker)
        let ended = try await syncPerfNext(history.snapshots(sessionId: "s"))
        XCTAssertNil(ended)
        // New account lifetime, same disk: the previous response was rejected,
        // but a fresh request may now persist normally.
        let fresh = fixture.history()
        await fresh.ensureNewest(sessionId: "s")
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").map(\.seq), [9, 10])
        await fresh.stop()
    }

    func testDeletedSessionRejectsAnInFlightPage() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let requested = Gate(), release = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: newest,
                                                                requested: requested, release: release))
        let loading = Task { await history.loadOlder(sessionId: "s") }
        try await syncPerfWait(requested)
        let joined = expectation(description: "deleted request has coalesced older callers")
        await history.observeCoalescing { kind in if kind == .older { joined.fulfill() } }
        let coalesced = Task { await history.loadOlder(sessionId: "s") }
        await fulfillment(of: [joined], timeout: 5)
        try fixture.store.deleteSession(id: "s")
        await release.open()
        let first = await loading.value, second = await coalesced.value
        XCTAssertEqual(first, second)
        XCTAssertFalse(first.failed)
        XCTAssertNil(first.failureOperation)
        XCTAssertFalse(first.advanced)
        XCTAssertFalse(first.hasMore)
        let state = await history.current(sessionId: "s")
        XCTAssertNil(state.error)
        XCTAssertEqual(try fixture.store.messages(sessionId: "s"), [])
        XCTAssertNil(try fixture.store.chatHistoryCoverage(sessionId: "s"))
        await history.stop()
    }

    func testCoalescedOlderCancellationRetiresWithoutFailureOrLateWrites() async throws {
        let fixture = try HistoryFixture()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(10), try fixture.message(9)], hasMore: true))
        let initial = fixture.history()
        await initial.ensureNewest(sessionId: "s")
        await initial.stop()
        fixture.http.on(route, json: MessagesPage(messages: [try fixture.message(8), try fixture.message(7)], hasMore: true))
        let requested = Gate(), release = Gate(), closed = Gate()
        let history = fixture.history(transport: HeldHistoryHTTP(base: fixture.http, before: "9",
                                                                requested: requested, release: release,
                                                                ignoresCancellation: true))
        let stream = history.snapshots(sessionId: "s")
        _ = try await syncPerfNext(stream)
        let watching = Task { for await _ in stream { }; await closed.open() }
        let a = Task { await history.loadOlder(sessionId: "s") }
        try await syncPerfWait(requested)
        let joined = expectation(description: "older cancellation shares one request")
        await history.observeCoalescing { kind in if kind == .older { joined.fulfill() } }
        let b = Task { await history.loadOlder(sessionId: "s") }
        await fulfillment(of: [joined], timeout: 5)
        let stopping = Task { await history.stop() }
        try await syncPerfWait(closed)
        await release.open()
        await stopping.value
        let first = await a.value, second = await b.value
        XCTAssertEqual(first, second)
        XCTAssertFalse(first.failed)
        XCTAssertNil(first.failureOperation)
        XCTAssertFalse(first.advanced)
        XCTAssertFalse(first.hasMore)
        XCTAssertEqual(try fixture.store.messages(sessionId: "s").map(\.seq), [9, 10])
        XCTAssertEqual(try fixture.store.chatHistoryCoverage(sessionId: "s")?.marker?.oldestRawSeq, 9)
        await watching.value
    }

    func testAccountOwnsAndEndsHistoryStatusStreams() async throws {
        let fixture = try HistoryFixture()
        let account = try AccountSession(credentials: Credentials(token: "test", secret: Data(repeating: 3, count: 32)),
                                         store: fixture.store, dependencies: .init(serverURL: testServer, clientID: "test",
                                                                                 transport: fixture.http, connector: FakeConnector()))
        let stream = account.chatHistory.snapshots(sessionId: "s")
        let initial = try await syncPerfNext(stream)
        let initialState = try XCTUnwrap(initial)
        // Queue a legitimate update before stopping. AsyncStream.finish()
        // retains buffered values, so termination must be checked after drain.
        try fixture.store.applyMessagePage(sessionId: "s", messages: [], syncedThrough: 10)
        await account.chatHistory.ensureNewest(sessionId: "s")
        let covered = await account.chatHistory.current(sessionId: "s")
        XCTAssertTrue(covered.initialLoaded)
        XCTAssertFalse(covered.hasMore)
        await account.stop()
        let closed = Gate()
        let draining = Task {
            var buffered: [ChatHistoryState] = []
            for await state in stream { buffered.append(state) }
            await closed.open()
            return buffered
        }
        defer { draining.cancel() }
        try await syncPerfWait(closed)
        let buffered = await draining.value
        XCTAssertGreaterThanOrEqual(buffered.count, 1)
        for state in buffered { XCTAssertTrue(state == initialState || state == covered) }
        let retired = try await syncPerfNext(account.chatHistory.snapshots(sessionId: "s"))
        XCTAssertNil(retired)
        XCTAssertEqual(fixture.http.requests.count, 0)
    }
}