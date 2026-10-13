import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

/// A fake account on a fake server: produces rows encrypted exactly as the
/// CLI and server would.
struct ServerFixture {
    let keys = try! AccountKeys(secret: SystemRandom().bytes(32))
    let dataKey = SystemRandom().bytes(32)

    var wrappedKey: String { Base64.encode(try! keys.wrapDataKey(dataKey)) }

    func seal(_ value: JSONValue) -> String {
        try! RecordCipher(key: dataKey).encrypt(value)
    }

    func session(_ id: String, seq: Int = 0, updatedAt: Int64, metadataVersion: Int = 1, title: String = "t", withKey: Bool = true) -> APISession {
        APISession(
            id: id, seq: seq, createdAt: 1, updatedAt: updatedAt, active: true, activeAt: updatedAt,
            metadata: seal(.object(["title": .string(title)])), metadataVersion: metadataVersion,
            agentState: nil, agentStateVersion: 0,
            dataEncryptionKey: withKey ? wrappedKey : nil, projectId: nil
        )
    }

    func message(seq: Int, text: String, localId: String? = nil) -> SessionMessage {
        let payload: JSONValue = .object([
            "role": .string("session"),
            "content": .object(["id": .string("e\(seq)"), "time": .number(1), "role": .string("agent"), "ev": .object(["t": .string("text"), "text": .string(text)])]),
        ])
        return SessionMessage(id: "m\(seq)", seq: seq, localId: localId, content: SessionMessageContent(c: seal(payload)), createdAt: Int64(seq), updatedAt: Int64(seq))
    }
}

final class SyncEngineTests: XCTestCase {
    var fixture: ServerFixture!
    var http: FakeHTTP!
    var store: LocalStore!
    var clock: Clock!
    var engine: SyncEngine!

    final class Clock: @unchecked Sendable {
        var now: Int64 = 1_000_000
    }

    override func setUpWithError() throws {
        fixture = ServerFixture()
        http = FakeHTTP()
        store = try LocalStore.inMemory()
        clock = Clock()
        let clock = self.clock!
        var options = SyncEngine.Options()
        options.backoff = Backoff(initial: .milliseconds(1), maximum: .milliseconds(2))
        engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options, now: { clock.now })
        http.onRaw("GET /v1/machines", "[]")
        http.onRaw("GET /v1/account/settings", #"{"settings":null,"settingsVersion":0}"#)
    }

    override func tearDown() async throws {
        await engine.stop()
    }

    private func titles() throws -> [String: String] {
        Dictionary(uniqueKeysWithValues: try store.sessions().map { ($0.id, $0.metadata?["title"]?.stringValue ?? "<nil>") })
    }

    func testFirstSyncIsFullThenOnlyDeltas() async throws {
        let fixture = self.fixture!
        let pages = PageCounter()
        let t0: Int64 = 1_760_000_000_000
        http.on("GET /v2/sessions") { request in
            pages.count += 1
            if request.query("changedSince") == nil {
                // Full listing, two pages.
                if request.query("cursor") == nil {
                    return (200, try JSONEncoder().encode(SessionsPage(sessions: [fixture.session("b", updatedAt: t0 + 200)], nextCursor: "cursor_v1_b", hasNext: true)))
                }
                return (200, try JSONEncoder().encode(SessionsPage(sessions: [fixture.session("a", updatedAt: t0 + 100)], nextCursor: nil, hasNext: false)))
            }
            return (200, try JSONEncoder().encode(SessionsPage(sessions: [fixture.session("a", updatedAt: t0 + 300, metadataVersion: 2, title: "renamed")], nextCursor: nil, hasNext: false)))
        }

        await engine.run(.sessions)
        XCTAssertEqual(try titles(), ["a": "t", "b": "t"])
        XCTAssertEqual(try store.cursor(.sessionsChangedSince), t0 + 200)
        XCTAssertEqual(try store.cursor(.sessionsLastFullSync), 1_000_000)

        clock.now += 60_000
        await engine.run(.sessions)
        let delta = try XCTUnwrap(http.requests("GET /v2/sessions").last)
        XCTAssertEqual(delta.query("changedSince"), "\(t0 + 200 - 5_000)", "re-reads a small overlap before the cursor")
        XCTAssertEqual(try titles(), ["a": "renamed", "b": "t"])
        XCTAssertEqual(try store.cursor(.sessionsChangedSince), t0 + 300)
        XCTAssertEqual(pages.count, 3)
    }

    func testDailyFullSyncDropsSessionsDeletedWhileOffline() async throws {
        let fixture = self.fixture!
        let remaining = ServerSessions([fixture.session("a", updatedAt: 100), fixture.session("b", updatedAt: 100)])
        http.on("GET /v2/sessions") { _ in (200, try JSONEncoder().encode(SessionsPage(sessions: remaining.value, nextCursor: nil, hasNext: false))) }
        await engine.run(.sessions)
        XCTAssertEqual(Set(try store.sessions().map(\.id)), ["a", "b"])

        remaining.value = [fixture.session("a", updatedAt: 100)]
        clock.now += 60_000
        await engine.run(.sessions)
        XCTAssertEqual(Set(try store.sessions().map(\.id)), ["a", "b"], "a delta pull cannot see deletions")

        clock.now += 24 * 60 * 60 * 1000
        await engine.run(.sessions)
        XCTAssertEqual(try store.sessions().map(\.id), ["a"])
    }

    func testSessionsWithoutADataKeyAreStoredButNotOpened() async throws {
        let fixture = self.fixture!
        http.on("GET /v2/sessions") { _ in
            (200, try JSONEncoder().encode(SessionsPage(sessions: [fixture.session("legacy", seq: 3, updatedAt: 1, withKey: false)], nextCursor: nil, hasNext: false)))
        }
        await engine.run(.sessions)
        let session = try XCTUnwrap(try store.session(id: "legacy"))
        XCTAssertFalse(session.decryptable)
        XCTAssertNil(session.metadata)
        await engine.waitForIdle()
        XCTAssertTrue(http.requests("GET /v3/sessions/legacy/messages").isEmpty)
    }

    func testMessagesAreFetchedOnlyAfterTheLocalCursor() async throws {
        let fixture = self.fixture!
        http.on("GET /v2/sessions") { _ in
            (200, try JSONEncoder().encode(SessionsPage(sessions: [fixture.session("s", seq: 3, updatedAt: 1)], nextCursor: nil, hasNext: false)))
        }
        http.on("GET /v3/sessions/s/messages") { request in
            let after = Int(request.query("after_seq") ?? "") ?? -1
            let all = (1...3).map { fixture.message(seq: $0, text: "m\($0)") }.filter { $0.seq > after }
            let page = Array(all.prefix(2))
            return (200, try JSONEncoder().encode(MessagesPage(messages: page, hasMore: all.count > 2)))
        }

        await engine.run(.sessions)
        await engine.waitForIdle()
        XCTAssertEqual(http.requests("GET /v3/sessions/s/messages").map { $0.query("after_seq") }, ["0", "2"])
        let messages = try store.messages(sessionId: "s")
        XCTAssertEqual(messages.map(\.seq), [1, 2, 3])
        guard case .session(let envelope, _)? = messages.last?.content.map(MessageContent.init(decrypted:)) else { return XCTFail() }
        XCTAssertEqual(envelope.ev, .text(text: "m3", thinking: false))
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 3)

        // Nothing new: no message request at all.
        await engine.run(.pendingMessages)
        XCTAssertEqual(http.requests("GET /v3/sessions/s/messages").count, 2)
    }

    func testLiveMessagesFastPathAndGapRecovery() async throws {
        let fixture = self.fixture!
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", seq: 1, updatedAt: 1))])
        try store.applyMessagePage(sessionId: "s", messages: [], syncedThrough: 1)
        http.on("GET /v3/sessions/s/messages") { _ in
            (200, try JSONEncoder().encode(MessagesPage(messages: [fixture.message(seq: 3, text: "three"), fixture.message(seq: 4, text: "four")], hasMore: false)))
        }

        await engine.handle(update(.newMessage(sessionId: "s", message: fixture.message(seq: 2, text: "two"))))
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 2)
        XCTAssertTrue(http.requests.isEmpty, "a contiguous message needs no fetch")

        await engine.handle(update(.newMessage(sessionId: "s", message: fixture.message(seq: 4, text: "four"))))
        await engine.waitForIdle()
        XCTAssertEqual(http.requests("GET /v3/sessions/s/messages").first?.query("after_seq"), "2")
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.seq), [2, 3, 4])
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 4)
    }

    func testLiveUpdatesForUnknownSessionsTriggerASessionPull() async throws {
        let fixture = self.fixture!
        http.on("GET /v2/sessions") { _ in
            (200, try JSONEncoder().encode(SessionsPage(sessions: [fixture.session("new", updatedAt: 5)], nextCursor: nil, hasNext: false)))
        }
        http.onRaw("GET /v3/sessions/new/messages", #"{"messages":[],"hasMore":false}"#)
        await engine.handle(update(.newMessage(sessionId: "new", message: fixture.message(seq: 1, text: "x"))))
        await engine.waitForIdle()
        XCTAssertEqual(http.requests("GET /v2/sessions").count, 1)
        XCTAssertNotNil(try store.session(id: "new"))
    }

    func testSessionUpdatesDecryptWithTheSessionKeyAndIgnoreStaleVersions() async throws {
        let fixture = self.fixture!
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1, metadataVersion: 5))])

        await engine.handle(update(.updateSession(UpdateSessionUpdate(
            id: "s", metadata: VersionedValue(version: 4, value: fixture.seal(.object(["title": .string("stale")])))
        ))))
        XCTAssertEqual(try titles()["s"], "t")

        await engine.handle(update(.updateSession(UpdateSessionUpdate(
            id: "s", metadata: VersionedValue(version: 6, value: fixture.seal(.object(["title": .string("fresh")])))
        ))))
        XCTAssertEqual(try titles()["s"], "fresh")

        await engine.handle(update(.deleteSession(sessionId: "s")))
        XCTAssertNil(try store.session(id: "s"))
    }

    func testMachinesAndSettings() async throws {
        let fixture = self.fixture!
        let machine = APIMachine(
            id: "m1", metadata: fixture.seal(.object(["host": .string("mac")])), metadataVersion: 1,
            daemonState: nil, daemonStateVersion: 0, dataEncryptionKey: fixture.wrappedKey,
            seq: 0, active: true, activeAt: 10, createdAt: 1, updatedAt: 1
        )
        http.on("GET /v1/machines", json: [machine])
        let settings = try AccountCipher(secret: fixture.keys.secret).encrypt(.object(["theme": .string("dark")]))
        http.onRaw("GET /v1/account/settings", #"{"settings":"\#(settings)","settingsVersion":3}"#)

        await engine.run(.machines)
        await engine.run(.settings)
        XCTAssertEqual(try store.machines().first?.metadata?["host"], .string("mac"))
        XCTAssertEqual(try store.accountSettings()?.settings?["theme"], .string("dark"))

        await engine.handle(update(.updateMachine(UpdateMachineUpdate(
            machineId: "m1", metadata: nil, daemonState: VersionedValue(version: 1, value: fixture.seal(.object(["pid": .number(42)]))), active: false, activeAt: 20
        ))))
        let stored = try XCTUnwrap(try store.machines().first)
        XCTAssertEqual(stored.daemonState?["pid"], .number(42))
        XCTAssertFalse(stored.active)

        await engine.handle(.machineActivity(machineId: "m1", active: true, activeAt: 30))
        XCTAssertEqual(try store.machines().first?.active, true)
    }

    func testOutboxSendsEncryptedIdempotentMessages() async throws {
        let fixture = self.fixture!
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        let failFirst = PageCounter()
        http.on("POST /v3/sessions/s/messages") { request in
            failFirst.count += 1
            if failFirst.count == 1 { return (503, Data()) }
            let body = try request.jsonBody(SendMessagesRequest.self)
            let sent = try XCTUnwrap(body.messages.first)
            return (200, Data(#"{"messages":[{"id":"srv1","seq":1,"localId":"\#(sent.localId)","createdAt":5,"updatedAt":5}]}"#.utf8))
        }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let localId = try await engine.accept(
            OutgoingMessage(text: "hi"), sessionId: "s", filesDirectory: directory
        )
        let payload = try XCTUnwrap(store.outbox(localId: localId)?.payload)
        XCTAssertEqual(try store.pendingOutbox().count, 1, "stored before any network call")
        await engine.waitForIdle()

        XCTAssertEqual(try store.outbox(localId: localId)?.nextAttemptAt, clock.now + 1_000)
        clock.now += 1_000
        await engine.run(.outbox)

        let attempts = http.requests("POST /v3/sessions/s/messages")
        XCTAssertEqual(attempts.count, 2, "retried after the 503")
        let sent = try attempts[1].jsonBody(SendMessagesRequest.self).messages[0]
        XCTAssertEqual(sent.localId, localId)
        XCTAssertEqual(RecordCipher(key: fixture.dataKey).decrypt(base64: sent.content), payload)
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.id), ["srv1"])
    }

    private func update(_ body: UpdateBody) -> UpdateContainer {
        UpdateContainer(id: "u", seq: 1, body: body, createdAt: 0)
    }
}

final class InvalidateSyncTests: XCTestCase {
    func testCoalescesInvalidationsWhileRunning() async throws {
        let gate = Gate()
        let runs = PageCounter()
        let sync = InvalidateSync {
            runs.count += 1
            await gate.wait()
        }
        await sync.invalidate()
        await eventually { runs.count == 1 }
        for _ in 0..<5 { await sync.invalidate() }
        await gate.open()
        await eventually { await !sync.isRunning }
        XCTAssertEqual(runs.count, 2, "five invalidations during a run collapse into one follow-up")
    }

    func testRetriesWithBackoffUntilSuccess() async throws {
        let attempts = PageCounter()
        let delays = DelayLog()
        let sync = InvalidateSync(backoff: Backoff(initial: .seconds(1), maximum: .seconds(3)), sleep: { delays.append($0) }) {
            attempts.count += 1
            if attempts.count < 4 { throw URLError(.notConnectedToInternet) }
        }
        await sync.invalidateAndAwait()
        XCTAssertEqual(attempts.count, 4)
        XCTAssertEqual(delays.values, [.seconds(1), .seconds(2), .seconds(3)])
    }

    func testStopWaitsForTheRunInFlight() async throws {
        let finished = PageCounter()
        let sync = InvalidateSync {
            // Stands in for a request: it ends when cancelled.
            try? await Task.sleep(for: .seconds(30))
            finished.count += 1
        }
        await sync.invalidate()
        await eventually { await sync.isRunning }
        await sync.stop()
        XCTAssertEqual(finished.count, 1, "stop() returns only after the run has ended")
        let running = await sync.isRunning
        XCTAssertFalse(running)
    }

    func testBackoffDelays() {
        let backoff = Backoff(initial: .seconds(1), maximum: .seconds(30))
        XCTAssertEqual((1...7).map(backoff.delay(attempt:)), [1, 2, 4, 8, 16, 30, 30].map { Duration.seconds($0) })
    }
}

final class PageCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0
    var count: Int {
        get { lock.lock(); defer { lock.unlock() }; return _count }
        set { lock.lock(); _count = newValue; lock.unlock() }
    }
}

final class ServerSessions: @unchecked Sendable {
    var value: [APISession]
    init(_ value: [APISession]) { self.value = value }
}

final class DelayLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [Duration] = []
    var values: [Duration] { lock.lock(); defer { lock.unlock() }; return _values }
    func append(_ value: Duration) { lock.lock(); _values.append(value); lock.unlock() }
}

actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}
