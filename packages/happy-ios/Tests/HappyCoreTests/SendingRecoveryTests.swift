import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

final class SendingRecoveryTests: XCTestCase, @unchecked Sendable {
    func testRelaunchRecoversSendingAndRetainsDraftAndComposerNull() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("store.sqlite")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = try LocalStore.open(at: url)
            try store.enqueue(OutboxRecord(localId: "a", kind: .message, sessionId: "s", payload: .null, createdAt: 1, attempts: 2, state: .sending))
            try store.saveDraft(sessionId: "s", text: "draft", at: 1)
            try store.saveComposerState(ComposerStateRecord(sessionId: "s", values: .object(["permissionMode": .string("auto"), "serviceTier": .null])))
        }
        let reopened = try LocalStore.open(at: url)
        XCTAssertEqual(try reopened.outbox(localId: "a")?.state, .queued)
        XCTAssertEqual(try reopened.outbox(localId: "a")?.attempts, 2)
        XCTAssertEqual(try reopened.draft(sessionId: "s")?.text, "draft")
        XCTAssertEqual(try reopened.composerState(sessionId: "s").values["serviceTier"], .null)
    }

    func testExhaustedAttemptsFailAndOtherSessionStillDelivers() async throws {
        let fixture = ServerFixture()
        let http = FakeHTTP()
        let store = try LocalStore.inMemory()
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        try store.upsertSessions([decoder.session(fixture.session("s", updatedAt: 1)), decoder.session(fixture.session("other", updatedAt: 1))])
        var options = LegacySyncEngine.Options()
        options.sendAttempts = 2
        options.sendRetryInitialMs = 60_000
        let engine = LegacySyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options, now: { 1_000 })
        http.onRaw("POST /v3/sessions/s/messages", "offline", status: 503)
        http.onRaw("POST /v3/sessions/other/messages", #"{"messages":[{"id":"m","seq":1,"localId":"b","createdAt":1,"updatedAt":1}]}"#)
        try store.enqueue(OutboxRecord(localId: "a", kind: .message, sessionId: "s", payload: .null, createdAt: 1, attempts: 1))
        try store.enqueue(OutboxRecord(localId: "b", kind: .message, sessionId: "other", payload: .null, createdAt: 1))
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "a")?.attempts, 2)
        XCTAssertEqual(try store.outbox(localId: "a")?.state, .interrupted)
        XCTAssertNil(try store.outbox(localId: "b"))
        await engine.stop()
    }

    /// A caption and its picture that ran out of tries with no way to the
    /// server read "not sent", and go again whole, by themselves, when the
    /// connection comes back. A message the server refused stays failed
    /// for the person.
    func testConnectionFailureGoesAgainWhenTheConnectionReturns() async throws {
        let fixture = ServerFixture()
        let http = FakeHTTP()
        let store = try LocalStore.inMemory()
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        try store.upsertSessions([decoder.session(fixture.session("s", updatedAt: 1)), decoder.session(fixture.session("other", updatedAt: 1))])
        var options = LegacySyncEngine.Options()
        options.sendAttempts = 1
        options.sendRetryInitialMs = 60_000
        let engine = LegacySyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options, now: { 1_000 })
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        await engine.configureSending(filesDirectory: directory)
        try Data([1]).write(to: directory.appendingPathComponent("f"))
        try store.enqueueBatch([
            OutboxRecord(localId: "f", kind: .file, sessionId: "s", payload: .null, createdAt: 1),
            OutboxRecord(localId: "t", kind: .message, sessionId: "s", payload: .object(["role": .string("user")]), createdAt: 1, dependsOn: "f"),
            OutboxRecord(localId: "refused", kind: .message, sessionId: "other", payload: .null, createdAt: 1),
        ], attachments: [AttachmentRecord(localId: "f", sessionId: "s", outboxLocalId: "f", path: "f", name: "f.jpg", mimeType: "image/jpeg", size: 1, createdAt: 1)])
        http.on("POST /v1/sessions/s/attachments/request-upload") { _ in throw URLError(.cannotConnectToHost) }
        http.onRaw("POST /v3/sessions/other/messages", "no", status: 400)
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "f")?.state, .interrupted)
        XCTAssertEqual(try store.outbox(localId: "t")?.state, .interrupted, "the caption waits with its picture")
        XCTAssertEqual(try store.outbox(localId: "refused")?.state, .failed)
        XCTAssertEqual(try OutboxSender(store: store, sync: engine, filesDirectory: directory).failedAttachmentCount(sessionId: "s"), 1)
        let tried = http.requests.count
        try await engine.flushOutbox()
        XCTAssertEqual(http.requests.count, tried, "nothing goes until the connection is back")

        http.onRaw("POST /v1/sessions/s/attachments/request-upload", #"{"ref":"ref-1","uploadUrl":"https://api.example.test/blob","method":"PUT"}"#)
        http.onRaw("PUT /blob", "")
        let seqs = Counter()
        http.on("POST /v3/sessions/s/messages") { request in
            let localId = try request.jsonBody(SendMessagesRequest.self).messages[0].localId
            return (200, Data(#"{"messages":[{"id":"m-\#(localId)","seq":\#(seqs.next()),"localId":"\#(localId)","createdAt":1,"updatedAt":1}]}"#.utf8))
        }
        await engine.resumeSending()
        await engine.waitForIdle()
        let posted = try http.requests("POST /v3/sessions/s/messages").map { try $0.jsonBody(SendMessagesRequest.self).messages[0].localId }
        XCTAssertEqual(posted, ["f", "t"])
        XCTAssertEqual(try store.pendingOutbox().map(\.localId), ["refused"])
        XCTAssertEqual(try store.outbox(localId: "refused")?.state, .failed, "a refusal waits for the person")
        await engine.stop()
    }

    /// A message with one part refused for good isn't sent again by itself,
    /// even if another part only lost the connection.
    func testResumeLeavesAMessageWithARefusedPart() throws {
        let store = try LocalStore.inMemory()
        try store.enqueueBatch([
            OutboxRecord(localId: "f", kind: .file, sessionId: "s", payload: .null, createdAt: 1, state: .failed),
            OutboxRecord(localId: "t", kind: .message, sessionId: "s", payload: .null, createdAt: 1, state: .interrupted, dependsOn: "f"),
            OutboxRecord(localId: "u", kind: .message, sessionId: "s", payload: .null, createdAt: 2, attempts: 3, state: .interrupted),
            OutboxRecord(localId: "v", kind: .message, sessionId: "s", payload: .null, createdAt: 3, state: .queued, nextAttemptAt: 9_000),
        ], attachments: [])
        XCTAssertEqual(try store.resumeInterruptedOutbox(), 1)
        XCTAssertEqual(try store.pendingOutbox().map(\.state), [.failed, .interrupted, .queued, .queued])
        XCTAssertEqual(try store.outbox(localId: "u")?.attempts, 0)
        XCTAssertEqual(try store.outbox(localId: "v")?.nextAttemptAt, 0, "a backoff goes now")
    }

    func testBackgroundLetsInFlightDeliveryFinishWithLeaseAndPausesNext() async throws {
        let fixture = ServerFixture()
        let http = SuspendedDelivery()
        let activity = ActivityLog()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        var options = LegacySyncEngine.Options()
        options.deliveryActivity = { await activity.append($0) }
        let engine = LegacySyncEngine(api: HappyAPI(serverURL: testServer, clientID: "ios/test", transport: http, token: "t"), store: store, keys: fixture.keys, options: options)
        for id in ["a", "b"] { try store.enqueue(OutboxRecord(localId: id, kind: .message, sessionId: "s", payload: .null, createdAt: 1)) }
        let flush = Task { try await engine.flushOutbox() }
        await eventually { await http.waiting }
        await engine.setBackgrounded(true)
        await http.release()
        try await flush.value
        XCTAssertNil(try store.outbox(localId: "a"))
        XCTAssertEqual(try store.outbox(localId: "b")?.state, .queued)
        let values = await activity.values
        XCTAssertEqual(values, [true, false])
        await engine.setBackgrounded(false)
        await engine.waitForIdle()
        XCTAssertNil(try store.outbox(localId: "b"))
        await engine.stop()
    }

    func testMissingAcknowledgementRetainsIdAndServerEchoSettlesIt() async throws {
        let fixture = ServerFixture()
        let http = FakeHTTP()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        let engine = LegacySyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        http.onRaw("POST /v3/sessions/s/messages", #"{"messages":[]}"#)
        try store.enqueue(OutboxRecord(localId: "a", kind: .message, sessionId: "s", payload: .null, createdAt: 1))
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "a")?.state, .queued)
        XCTAssertEqual(try http.requests[0].jsonBody(SendMessagesRequest.self).messages[0].localId, "a")
        _ = try store.applyLiveMessage(MessageRecord(id: "m", sessionId: "s", seq: 1, localId: "a", createdAt: 1, updatedAt: 1, contentCipher: "", content: .null))
        XCTAssertNil(try store.outbox(localId: "a"))
        await engine.stop()
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int {
        lock.withLock {
            value += 1
            return value
        }
    }
}

private actor ActivityLog {
    var values: [Bool] = []
    func append(_ value: Bool) { values.append(value) }
}

private actor SuspendedDelivery: HTTPTransport {
    var waiting = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var sequence = 0
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        sequence += 1
        let seq = sequence
        if seq == 1 {
            await withCheckedContinuation { continuation in
                waiting = true
                self.continuation = continuation
            }
        }
        let localId = try JSONDecoder().decode(SendMessagesRequest.self, from: request.body!).messages[0].localId
        return HTTPResponse(status: 200, body: Data("{\"messages\":[{\"id\":\"m\(seq)\",\"seq\":\(seq),\"localId\":\"\(localId)\",\"createdAt\":1,\"updatedAt\":1}]}".utf8))
    }
    func release() {
        waiting = false
        continuation?.resume()
        continuation = nil
    }
}
