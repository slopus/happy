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
        var options = SyncEngine.Options()
        options.sendAttempts = 2
        options.sendRetryInitialMs = 60_000
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options, now: { 1_000 })
        http.onRaw("POST /v3/sessions/s/messages", "offline", status: 503)
        http.onRaw("POST /v3/sessions/other/messages", #"{"messages":[{"id":"m","seq":1,"localId":"b","createdAt":1,"updatedAt":1}]}"#)
        try store.enqueue(OutboxRecord(localId: "a", kind: .message, sessionId: "s", payload: .null, createdAt: 1, attempts: 1))
        try store.enqueue(OutboxRecord(localId: "b", kind: .message, sessionId: "other", payload: .null, createdAt: 1))
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "a")?.attempts, 2)
        XCTAssertEqual(try store.outbox(localId: "a")?.state, .failed)
        XCTAssertNil(try store.outbox(localId: "b"))
        await engine.stop()
    }

    func testBackgroundLetsInFlightDeliveryFinishWithLeaseAndPausesNext() async throws {
        let fixture = ServerFixture()
        let http = SuspendedDelivery()
        let activity = ActivityLog()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        var options = SyncEngine.Options()
        options.deliveryActivity = { await activity.append($0) }
        let engine = SyncEngine(api: HappyAPI(serverURL: testServer, clientID: "ios/test", transport: http, token: "t"), store: store, keys: fixture.keys, options: options)
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
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
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
