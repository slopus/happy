import Foundation
import XCTest
import GRDB
@testable import HappyCore
import HappyStore
import HappyWire

final class OpsModeSyncTests: XCTestCase {
    func testPendingMasksStaleMetadataAndNullOtherwiseResets() {
        let local: JSONValue = .object(["permissionMode": .string("auto"), "modelMode": .string("local"), "serviceTier": .string("fast")])
        let metadata: JSONValue = .object(["permissionMode": .null, "modelMode": .string("stale")])
        XCTAssertEqual(
            SessionModesReconciler.reconcile(local: local, metadata: metadata, pending: ["modelMode"]),
            .object(["permissionMode": .null, "modelMode": .string("local"), "serviceTier": .string("fast")])
        )
        XCTAssertEqual(SessionModesReconciler.reconcile(local: local, metadata: .object([:]), pending: []), local)
    }

    func testRigV1ComposerIsUntouched() {
        let local: JSONValue = .object(["modelMode": .string("p:local")])
        let metadata: JSONValue = .object(["client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1), "modelMode": .string("ignore"), "permissionMode": .null])
        XCTAssertEqual(SessionModesReconciler.reconcile(local: local, metadata: metadata, pending: []), local)
    }

    func testOverlappingCountersArePerSessionFieldAndAccount() {
        let first = SessionModePushCounters()
        let second = SessionModePushCounters()
        first.mark(sessionId: "s", fields: ["modelMode"])
        first.mark(sessionId: "s", fields: ["modelMode", "permissionMode"])
        first.clear(sessionId: "s", fields: ["modelMode"])
        XCTAssertEqual(first.pending(sessionId: "s"), ["modelMode", "permissionMode"])
        XCTAssertTrue(first.pending(sessionId: "other").isEmpty)
        XCTAssertTrue(second.pending(sessionId: "s").isEmpty)
        first.clear(sessionId: "s", fields: ["modelMode", "permissionMode"])
        XCTAssertTrue(first.pending(sessionId: "s").isEmpty)
    }

    func fixture() throws -> (ServerFixture, LocalStore, FakeHTTP, SyncEngine) {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        let http = FakeHTTP()
        let sync = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        let row = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))
        try store.upsertSessions([row])
        try store.saveComposerState(ComposerStateRecord(sessionId: "s", values: .object(["modelMode": .string("local"), "effortLevel": .string("high")])) )
        return (fixture, store, http, sync)
    }

    func update(_ metadata: JSONValue, version: Int, fixture: ServerFixture) -> UpdateContainer {
        UpdateContainer(
            id: "update-\(version)", seq: version,
            body: .updateSession(UpdateSessionUpdate(id: "s", metadata: VersionedValue(version: version, value: fixture.seal(metadata)))),
            createdAt: Int64(version)
        )
    }

    func testRealtimeHookKeepsPendingThenAppliesNullAndAbsentRules() async throws {
        let (fixture, store, _, sync) = try fixture()
        sync.modePushes.mark(sessionId: "s", fields: ["modelMode"])
        await sync.handle(update(.object(["modelMode": .string("stale")]), version: 2, fixture: fixture))
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("local"))
        sync.modePushes.clear(sessionId: "s", fields: ["modelMode"])
        await sync.handle(update(.object(["modelMode": .null]), version: 3, fixture: fixture))
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .null)
        XCTAssertEqual(try store.composerState(sessionId: "s").values["effortLevel"], .string("high"))
        await sync.stop()
    }

    func testPullHookUsesStoredNewestMetadata() async throws {
        let (fixture, store, http, sync) = try fixture()
        var row = fixture.session("s", updatedAt: 3, metadataVersion: 3)
        row.metadata = fixture.seal(.object(["permissionMode": .null, "modelMode": .string("remote")]))
        let response = SessionsPage(sessions: [row], nextCursor: nil, hasNext: false)
        http.on("GET /v2/sessions", json: response)
        try await sync.pullSessions()
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("remote"))
        XCTAssertEqual(try store.composerState(sessionId: "s").values["permissionMode"], .null)
        await sync.stop()
    }

    func testFailedPushClearsPendingAndNextInboundMetadataWins() async throws {
        let (fixture, store, http, sync) = try fixture()
        let actions = SessionActions(api: testAPI(http), store: store, sync: sync, rpc: FakeRPC())
        let error = FakeMetadataTransport([.object(["result": .string("error"), "message": .string("offline")])])
        do {
            try await actions.sessionSetAgentModes(sessionId: "s", patch: SessionAgentModesPatch(modelMode: .string("optimistic")), transport: error)
            XCTFail("expected failed push")
        } catch {}
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("optimistic"))
        XCTAssertTrue(sync.modePushes.pending(sessionId: "s").isEmpty)
        await sync.handle(update(.object(["modelMode": .string("remote")]), version: 2, fixture: fixture))
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("remote"))
        await sync.stop()
    }

    @MainActor
    func testSessionAndComposerObserversSeeOneAtomicCommit() async throws {
        let (fixture, store, _, sync) = try fixture()
        let changed = expectation(description: "joint update")
        var snapshots: [String] = []
        let values = ValueObservation.tracking { db -> String in
            XCTAssertFalse(Thread.isMainThread)
            let session = try SessionRecord.fetchOne(db, key: "s")
            let composer = try ComposerStateRecord.fetchOne(db, key: "s")
            return "\(session?.metadataVersion ?? 0):\(composer?.values["modelMode"]?.stringValue ?? "nil")"
        }.values(in: store.writer, scheduling: .async(onQueue: DispatchQueue(label: "OpsModeSyncTests.observation")))
        let observation = Task {
            for try await value in values {
                snapshots.append(value)
                if value == "2:remote" { changed.fulfill() }
            }
        }
        defer { observation.cancel() }
        await sync.handle(update(.object(["modelMode": .string("remote")]), version: 2, fixture: fixture))
        await fulfillment(of: [changed], timeout: 2)
        observation.cancel()
        XCTAssertFalse(snapshots.contains("2:local"))
        XCTAssertTrue(snapshots.contains("2:remote"))
        await sync.stop()
    }
}
