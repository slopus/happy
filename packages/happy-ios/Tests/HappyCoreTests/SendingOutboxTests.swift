import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

final class SendingOutboxTests: XCTestCase, @unchecked Sendable {
    func setup() throws -> (LocalStore, SyncEngine, FakeHTTP, ServerFixture) {
        let fixture = ServerFixture()
        let http = FakeHTTP()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        var options = SyncEngine.Options()
        options.sendAttempts = 2
        options.sendRetryInitialMs = 60_000
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options, now: { 1_000 })
        return (store, engine, http, fixture)
    }

    func testBackoffFailureBlocksOnlyItsSessionRetryAndDiscard() async throws {
        let (store, engine, http, _) = try setup()
        http.onRaw("POST /v3/sessions/s/messages", "offline", status: 503)
        for id in ["a", "b"] { try store.enqueue(OutboxRecord(localId: id, kind: .message, sessionId: "s", payload: .object(["role": .string("user")]), createdAt: 1)) }
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "a")?.state, .queued)
        XCTAssertEqual(try store.outbox(localId: "a")?.attempts, 1)
        XCTAssertEqual(try store.outbox(localId: "a")?.nextAttemptAt, 61_000)
        try await engine.flushOutbox()
        XCTAssertEqual(http.requests.count, 1)
        try store.retryOutbox(localId: "a")
        http.onRaw("POST /v3/sessions/s/messages", "no", status: 400)
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "a")?.state, .failed)
        XCTAssertEqual(try store.outbox(localId: "b")?.state, .queued)
        XCTAssertEqual(try store.outbox(localId: "b")?.attempts, 0)
        _ = try store.discardOutbox(localId: "a")
        XCTAssertNotNil(try store.outbox(localId: "b"))
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "b")?.state, .failed)
        await engine.stop()
    }

    func testUnencryptableSessionFailsVisiblyAndBlocksLaterText() async throws {
        let (store, engine, http, fixture) = try setup()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("foreign", updatedAt: 1, withKey: false))])
        for id in ["a", "b"] { try store.enqueue(OutboxRecord(localId: id, kind: .message, sessionId: "foreign", payload: .null, createdAt: 1)) }
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "a")?.state, .failed)
        XCTAssertEqual(try store.outbox(localId: "b")?.state, .queued)
        XCTAssertTrue(http.requests.isEmpty)
        await engine.stop()
    }

    func testAttachmentsUploadBeforeTextWithEncryptedSizeAndBlobKey() async throws {
        let (store, engine, http, fixture) = try setup()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("picked")
        let plaintext = Data([0, 1, 2, 255])
        try plaintext.write(to: source)
        http.on("POST /v1/sessions/s/attachments/request-upload") { request in
            let body = try request.jsonBody(JSONValue.self)
            XCTAssertEqual(body["size"], .number(44))
            return (200, Data(#"{"ref":"blob-ref","uploadUrl":"https://api.example.test/blob","method":"PUT"}"#.utf8))
        }
        http.on("PUT /blob") { request in
            XCTAssertEqual(request.headers["Authorization"], "Bearer token-1")
            XCTAssertEqual(BlobCipher.open(request.body!, key: BlobCipher.sessionKey(dataKey: fixture.dataKey)), plaintext)
            return (200, Data())
        }
        let count = Counter()
        http.on("POST /v3/sessions/s/messages") { request in
            let body = try request.jsonBody(SendMessagesRequest.self)
            let item = body.messages[0]
            let payload = try XCTUnwrap(RecordCipher(key: fixture.dataKey).decrypt(base64: item.content))
            let sequence = count.next()
            if sequence == 1 {
                XCTAssertEqual(payload["role"], .string("session"))
                XCTAssertEqual(payload["content"]?["data"]?["ev"]?["ref"], .string("blob-ref"))
                XCTAssertEqual(payload["content"]?["data"]?["ev"]?["image"]?["width"], .number(10))
            } else { XCTAssertEqual(payload["content"]?["text"], .string("hello")) }
            return (200, Data("{\"messages\":[{\"id\":\"m\(sequence)\",\"seq\":\(sequence),\"localId\":\"\(item.localId)\",\"createdAt\":1,\"updatedAt\":1}]}".utf8))
        }
        let sender = OutboxSender(store: store, sync: engine, filesDirectory: directory.appendingPathComponent("files"))
        let picked = OutgoingAttachment(
            fileURL: source, name: "image.png", mimeType: "image/png", size: 4, width: 10, height: 20
        )
        _ = try await sender.send(OutgoingMessage(text: "hello", attachments: [picked]), sessionId: "s")
        await engine.waitForIdle()
        XCTAssertEqual(http.requests.map { $0.url.path }, ["/v1/sessions/s/attachments/request-upload", "/blob", "/v3/sessions/s/messages", "/v3/sessions/s/messages"])
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        await engine.stop()
    }

    func testFailedUploadReleasesTextAndDiscardRemovesDependencyChain() async throws {
        let (store, engine, http, _) = try setup()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        await engine.configureSending(filesDirectory: directory)
        try Data([1]).write(to: directory.appendingPathComponent("f"))
        try store.enqueueBatch([
            OutboxRecord(localId: "f", kind: .file, sessionId: "s", payload: .null, createdAt: 1),
            OutboxRecord(localId: "t", kind: .message, sessionId: "s", payload: .object(["role": .string("user")]), createdAt: 1, dependsOn: "f")
        ], attachments: [AttachmentRecord(localId: "f", sessionId: "s", outboxLocalId: "f", path: "f", name: "file", mimeType: "application/octet-stream", size: 1, createdAt: 1)])
        http.onRaw("POST /v1/sessions/s/attachments/request-upload", "too big", status: 413)
        http.onRaw("POST /v3/sessions/s/messages", #"{"messages":[{"id":"m","seq":1,"localId":"t","createdAt":1,"updatedAt":1}]}"#)
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "f")?.state, .failed)
        XCTAssertNil(try store.outbox(localId: "t"))
        XCTAssertEqual(try OutboxSender(store: store, sync: engine, filesDirectory: directory).failedAttachmentCount(sessionId: "s"), 1)
        _ = try store.discardOutbox(localId: "f")
        XCTAssertNil(try store.attachment(outboxLocalId: "f"))
        await engine.stop()
    }

    func testBackgroundAcceptanceDraftModesAndRefusal() async throws {
        let (store, engine, http, _) = try setup()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sender = OutboxSender(store: store, sync: engine, filesDirectory: directory)
        await engine.setBackgrounded(true)
        try sender.saveDraft(sessionId: "s", text: "draft")
        XCTAssertEqual(try sender.draft(sessionId: "s"), "draft")
        try sender.saveComposerState(ComposerStateRecord(sessionId: "s", values: .object(["modelMode": .string("default"), "serviceTier": .null])))
        let id = try await sender.send(OutgoingMessage(text: "hello"), sessionId: "s")
        await engine.waitForIdle()
        XCTAssertEqual(try store.outbox(localId: id)?.payload["meta"]?["model"], .null)
        XCTAssertTrue(http.requests.isEmpty)
        var session = try XCTUnwrap(store.session(id: "s"))
        session.metadata = .object(["version": .string("1.2.0")])
        session.metadataVersion += 1
        try store.upsertSessions([session])
        try sender.saveComposerState(ComposerStateRecord(sessionId: "s", values: .object(["permissionMode": .string("auto")])))
        do {
            _ = try await sender.send(OutgoingMessage(text: "refused"), sessionId: "s")
            XCTFail("expected refusal")
        } catch is UnsupportedPermissionModeError {}
        XCTAssertEqual(try store.pendingOutbox().count, 1)
        try await sender.discard(localId: id)
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        await engine.stop()
    }

    /// sync.ts `sendMessage`: a session written to is released from the
    /// start that made it, so changing the new-session draft can't stop it.
    func testAcceptedSendReleasesASpawnedSession() async throws {
        let (store, engine, _, _) = try setup()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let requests = SpawnRequests()
        let otherAccount = SpawnRequests()
        let sender = OutboxSender(store: store, sync: engine, filesDirectory: directory, spawnRequests: requests)
        await engine.setBackgrounded(true)
        let released = await MainActor.run { () -> Counter in
            let counter = Counter()
            let id = requests.requestId(for: .init(machineId: "m", agent: "claude", place: "~", worktree: nil, modelKey: nil, permissionMode: nil, effort: nil))
            requests.remember(id, sessionId: "s", abandon: {}, release: { _ = counter.next() })
            let otherID = otherAccount.requestId(for: .init(machineId: "m", agent: "claude", place: "~", worktree: nil, modelKey: nil, permissionMode: nil, effort: nil))
            otherAccount.remember(otherID, sessionId: "s", abandon: {}, release: { XCTFail("sending in one account must not release another account's same session ID") })
            return counter
        }
        _ = try await sender.send(OutgoingMessage(text: "hello"), sessionId: "s")
        XCTAssertEqual(released.next(), 2, "released once")
        await MainActor.run {
            let otherID = otherAccount.requestId(for: .init(machineId: "m", agent: "claude", place: "~", worktree: nil, modelKey: nil, permissionMode: nil, effort: nil))
            XCTAssertEqual(otherAccount.spawnedSessionId(otherID), "s")
            requests.complete()
            otherAccount.complete()
        }
        await engine.stop()
    }

    func testAcceptedSendReleasesPendingChatChildThroughAccountRoot() async throws {
        let (store, engine, _, _) = try setup()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let requests = SpawnRequests()
        let sender = OutboxSender(store: store, sync: engine, filesDirectory: directory, spawnRequests: requests)
        await engine.setBackgrounded(true)
        let state = await MainActor.run { () -> (Counter, String) in
            let counter = Counter()
            let signature = SpawnRequests.Signature(machineId: "m", agent: "claude", place: "~", worktree: nil, modelKey: nil, permissionMode: nil, effort: nil)
            let homeID = requests.requestId(for: signature)
            requests.remember(homeID, sessionId: "home", abandon: {}, release: { XCTFail("sending to the strip released a different Home session") })
            let child = requests.child(.pendingChats)
            let childID = child.requestId(for: signature)
            child.remember(childID, sessionId: "s", abandon: {}, release: { _ = counter.next() })
            return (counter, homeID)
        }
        _ = try await sender.send(OutgoingMessage(text: "hello", source: .newSession), sessionId: "s")
        XCTAssertEqual(state.0.next(), 2, "accepted first text releases the account's child once")
        await MainActor.run {
            XCTAssertEqual(requests.spawnedSessionId(state.1), "home")
            requests.complete()
            requests.close()
        }
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
