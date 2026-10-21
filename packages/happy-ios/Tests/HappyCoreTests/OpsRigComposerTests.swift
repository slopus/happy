import Foundation
import GRDB
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

private actor RigWriteProbe: MetadataUpdateTransport {
    let cipher: RecordCipher
    var calls: [JSONValue] = []
    var gate: CheckedContinuation<Void, Never>?
    var blockFirst = false
    var failures = 0

    init(key: Data) { cipher = RecordCipher(key: key) }

    func block() { blockFirst = true }

    func fail(_ count: Int) { failures = count }

    func release() {
        gate?.resume()
        gate = nil
    }

    func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue {
        calls.append(payload)
        if blockFirst, calls.count == 1 { await withCheckedContinuation { gate = $0 } }
        if failures > 0 {
            failures -= 1
            throw SessionActionError.failed("offline")
        }
        return .object([
            "result": .string("success"), "version": .number((payload["expectedVersion"]?.numberValue ?? 0) + 1),
            "metadata": payload["metadata"]!,
        ])
    }

    func drafts() -> [JSONValue] {
        calls.compactMap { $0["metadata"]?.stringValue.flatMap { cipher.decrypt(base64: $0) } }
    }
}

private actor RigSleepProbe {
    var durations: [Duration] = []
    var sleepers: [UUID: CheckedContinuation<Void, any Error>] = [:]

    func sleep(_ duration: Duration) async throws {
        durations.append(duration)
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { sleepers[id] = continuation }
            }
        } onCancel: { Task { await self.cancel(id) } }
    }

    func cancel(_ id: UUID) { sleepers.removeValue(forKey: id)?.resume(throwing: CancellationError()) }

    func wake() {
        let pending = sleepers.values
        sleepers.removeAll()
        for sleeper in pending { sleeper.resume() }
    }
}

final class OpsRigComposerTests: XCTestCase {
    func metadata(stamp: Double = 10, text: String? = "remote", model: String = "remote") -> JSONValue {
        .object([
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "unknown": .number(7), "draftUpdatedAt": .number(stamp),
            "draft": text.map { .object([
                "text": .string($0), "providerId": .string("p"), "modelId": .string(model),
                "effort": .string("low"), "permissionMode": .string("ask"), "serviceTier": .null,
            ]) } ?? .null,
            "lastMode": .object(["providerId": .string("p"), "modelId": .string("used")]),
        ])
    }

    private func fixture(sleep: @escaping InvalidateSync.Sleep = { try await Task.sleep(for: $0) }) throws
        -> (ServerFixture, LocalStore, RigComposerSync, RigWriteProbe) {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))
        session.metadata = metadata()
        try store.upsertSessions([session], reconcileComposer: SessionModePushCounters().reconciliation)
        let writer = RigComposerSync(store: store, keyRing: KeyRing(keys: fixture.keys), now: { 100 }, sleep: sleep)
        return (fixture, store, writer, RigWriteProbe(key: fixture.dataKey))
    }

    func waitUntil(_ predicate: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<2000 {
            if await predicate() { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("timed out waiting for writer")
        throw CancellationError()
    }

    func testInboundEqualStampAdoptsDraftAndPicksWhileAheadLocalSurvivesAndOldVersionLoses() throws {
        let (_, store, _, _) = try fixture()
        var session = try XCTUnwrap(store.session(id: "s"))
        try store.saveRigComposer(
            ComposerStateRecord(sessionId: "s", values: .object([
                "draftUpdatedAt": .number(20), "modelMode": .string("p:local"), "draftIsNull": .bool(false),
            ])), text: "local", at: 20
        )
        let reconcile = SessionModePushCounters().reconciliation
        session.metadataVersion = 2
        session.metadata = metadata(stamp: 19)
        try store.upsertSessions([session], reconcileComposer: reconcile)
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "local")
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("p:local"))
        session.metadataVersion = 3
        session.metadata = metadata(stamp: 20, text: "equal", model: "equal")
        try store.upsertSessions([session], reconcileComposer: reconcile)
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "equal")
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("p:equal"))
        session.metadataVersion = 2
        session.metadata = metadata(stamp: 99, text: "stale version")
        try store.upsertSessions([session], reconcileComposer: reconcile)
        XCTAssertEqual(try store.session(id: "s")?.metadataVersion, 3)
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "equal")
    }

    func testClearEchoRetainsCapturedPicksUntilLastModeChanges() throws {
        let (_, store, writer, _) = try fixture()
        try writer.clear(sessionId: "s")
        var row = try XCTUnwrap(store.session(id: "s"))
        row.metadataVersion = 2
        row.metadata = metadata(stamp: 100, text: nil)
        let reconcile = SessionModePushCounters().reconciliation
        try store.upsertSessions([row], reconcileComposer: reconcile)
        XCTAssertNil(try store.draft(sessionId: "s"))
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("p:remote"))
        var changed = row.metadata!.objectValue!
        changed["lastMode"] = .object(["providerId": .string("p"), "modelId": .string("confirmed")])
        row.metadata = .object(changed)
        row.metadataVersion = 3
        try store.upsertSessions([row], reconcileComposer: reconcile)
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("p:confirmed"))
    }

    func testDebounceReadsLatestTextAndEmptyEditIsImmediate() async throws {
        let clock = RigSleepProbe()
        let (_, store, writer, transport) = try fixture(sleep: { try await clock.sleep($0) })
        await writer.configure(transport: transport)
        try writer.setText(sessionId: "s", text: "first")
        try await waitUntil { await clock.durations.count == 1 }
        try writer.setText(sessionId: "s", text: "latest")
        try await waitUntil { await clock.durations.count == 2 }
        let before = await transport.calls
        XCTAssertTrue(before.isEmpty)
        await clock.wake()
        try await waitUntil { await transport.calls.count == 1 }
        let drafts = await transport.drafts()
        XCTAssertEqual(drafts[0]["draft"]?["text"], .string("latest"))
        XCTAssertEqual(drafts[0]["unknown"], .number(7))
        try await writer.flushPending(sessionId: "s")
        try writer.setText(sessionId: "s", text: "")
        try await waitUntil { await transport.calls.count >= 3 }
        let cleared = await transport.drafts().last
        XCTAssertEqual(cleared?["draft"]?["text"], .string(""))
        XCTAssertNil(try store.draft(sessionId: "s"))
        await writer.stop()
    }

    func testOneInflightWriteCoalescesEditsIntoOneFollowup() async throws {
        let (_, store, writer, transport) = try fixture()
        await writer.configure(transport: transport)
        await transport.block()
        try writer.setText(sessionId: "s", text: "")
        try await waitUntil { await transport.calls.count == 1 }
        try writer.setText(sessionId: "s", text: "second")
        try writer.setText(sessionId: "s", text: "third")
        try writer.clear(sessionId: "s")
        // Configure shares the edit queue: every synchronous schedule before it
        // has reached the writer before the first RPC is released.
        await writer.configure(transport: transport)
        await transport.release()
        try await waitUntil { await transport.calls.count == 2 }
        try await waitUntil { (try? store.session(id: "s")?.metadataVersion) == 3 }
        await writer.configure(transport: transport)
        let writes = await transport.drafts()
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[0]["draft"]?["text"], .string(""))
        XCTAssertEqual(writes[1]["draft"], .null)
        XCTAssertGreaterThan(writes[1]["draftUpdatedAt"]!.numberValue!, writes[0]["draftUpdatedAt"]!.numberValue!)
        await writer.stop()
    }

    func testRetryBackoffCapsAtThirtySecondsAndDisconnectStopsIt() async throws {
        let clock = RigSleepProbe()
        let (_, _, writer, transport) = try fixture(sleep: { try await clock.sleep($0) })
        await writer.configure(transport: transport)
        await transport.fail(20)
        await writer.setConnected(true)
        try writer.setText(sessionId: "s", text: "")
        for count in 1...7 {
            try await waitUntil { await clock.durations.count == count }
            if count < 7 { await clock.wake() }
        }
        let delays = await clock.durations
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30, 30].map { .seconds($0) })
        await writer.setConnected(false)
        let before = await transport.calls.count
        await clock.wake()
        await writer.configure(transport: transport)
        let after = await transport.calls.count
        XCTAssertEqual(after, before)
        await writer.setConnected(true)
        try await waitUntil { await transport.calls.count == before + 1 }
        await writer.stop()
    }

    func testComposerFacadeRoutesRigDraftAndClearsAfterAcceptance() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        let sync = SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: fixture.keys, now: { 100 })
        var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))
        session.metadata = metadata()
        try store.upsertSessions([session], reconcileComposer: sync.modePushes.reconciliation)
        let files = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: files) }
        let sender = OutboxSender(store: store, sync: sync, filesDirectory: files)
        try sender.saveDraft(sessionId: "s", text: "unsent")
        XCTAssertEqual(try store.composerState(sessionId: "s").values["draftUpdatedAt"], .number(100))
        let id = try await sender.send(OutgoingMessage(text: "unsent"), sessionId: "s")
        XCTAssertNotNil(try store.outbox(localId: id))
        XCTAssertEqual(try sender.draft(sessionId: "s"), "")
        let cleared = try store.composerState(sessionId: "s").values
        XCTAssertEqual(cleared["draftIsNull"], .bool(true))
        XCTAssertEqual(cleared["draftUpdatedAt"], .number(101))
        try sender.saveDraft(sessionId: "s", text: "")
        XCTAssertEqual(try store.composerState(sessionId: "s").values, cleared)
        await sync.stop()
    }

    @MainActor
    func testInboundRigSessionDraftAndPicksPublishOneAtomicCommit() async throws {
        let (_, store, writer, _) = try fixture()
        let changed = expectation(description: "session and composer committed")
        var snapshots: [String] = []
        let values = ValueObservation.tracking { db -> String in
            XCTAssertFalse(Thread.isMainThread)
            let session = try SessionRecord.fetchOne(db, key: "s")
            let composer = try ComposerStateRecord.fetchOne(db, key: "s")
            let draft = try DraftRecord.fetchOne(db, key: "s")
            return "\(session?.metadataVersion ?? 0):\(draft?.text ?? "nil"):\(composer?.values["modelMode"]?.stringValue ?? "nil")"
        }.values(in: store.writer, scheduling: .async(onQueue: DispatchQueue(label: "OpsRigComposerTests.observation")))
        let observation = Task {
            for try await value in values {
                snapshots.append(value)
                if value == "2:new:p:new" { changed.fulfill() }
            }
        }
        defer { observation.cancel() }
        var session = try XCTUnwrap(store.session(id: "s"))
        session.metadataVersion = 2
        session.metadata = metadata(stamp: 20, text: "new", model: "new")
        try store.upsertSessions([session], reconcileComposer: SessionModePushCounters().reconciliation)
        await fulfillment(of: [changed], timeout: 2)
        observation.cancel()
        XCTAssertFalse(snapshots.contains("2:remote:p:remote"))
        XCTAssertTrue(snapshots.contains("2:new:p:new"))
        await writer.stop()
    }

    func testClearingAnAcceptedSendPreservesSubsequentWriting() async throws {
        let (_, store, writer, transport) = try fixture()
        await writer.configure(transport: transport)
        let oldStamp = try store.composerState(sessionId: "s").values["draftUpdatedAt"]
        try writer.setText(sessionId: "s", text: "next message")
        try writer.clearAfterSend(sessionId: "s", expectedStamp: oldStamp)
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "next message")
        await writer.stop()
    }
}
