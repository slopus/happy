import Foundation
import GRDB
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// A Happy account's archives, leaves and deletes (docs/offline-first.md):
/// shown at once, kept through a kill and relaunch while offline, never
/// undone by a stale list, sent once the socket is back, and put back
/// when refused.
final class LegacyIntentTests: XCTestCase {
    private var fixture: ServerFixture!
    private var http: FakeHTTP!
    private var rpc: FakeRPC!
    private var file: URL!
    private var engines: [LegacySyncEngine] = []

    override func setUpWithError() throws {
        fixture = ServerFixture()
        http = FakeHTTP()
        rpc = FakeRPC()
        file = FileManager.default.temporaryDirectory.appendingPathComponent("legacy-intents-\(UUID().uuidString).sqlite")
    }

    override func tearDown() async throws {
        for engine in engines { await engine.stop() }
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: file.path + suffix) }
    }

    /// One launch: the store on disk, its engine and actions, offline.
    private func launch() async throws -> (LocalStore, LegacySyncEngine, SessionActions) {
        let store = try LocalStore(writer: DatabaseQueue(path: file.path))
        let engine = LegacySyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        engines.append(engine)
        let actions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: rpc, now: { 500 })
        await engine.intents.setDeliver { try await actions.deliver($0) }
        await engine.setConnected(false)
        return (store, engine, actions)
    }

    private func record(_ id: String = "s") -> SessionRecord {
        RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session(id, updatedAt: 1))
    }

    private func offline(_ route: String) {
        http.on(route) { _ in throw URLError(.notConnectedToInternet) }
    }

    private func drained(_ engine: LegacySyncEngine) async throws {
        for _ in 0..<300 where await !engine.intents.pending().isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        let pending = await engine.intents.pending()
        XCTAssertEqual(pending, [])
    }

    func testAPendingArchiveSurvivesARelaunchOfflineThenGoesOnce() async throws {
        offline("POST /v1/sessions/s/archive")
        do {
            let (store, engine, actions) = try await launch()
            try store.upsertSessions([record()])
            try await actions.archive(sessionId: "s")
            XCTAssertEqual(try store.session(id: "s")?.isArchived, true, "out of the list at once")
            await engine.stop()
            try store.close()
        }

        // Killed and opened again, still offline.
        let (store, engine, actions) = try await launch()
        _ = actions
        XCTAssertEqual(try store.session(id: "s")?.archiving, true, "the launch reset brought the row back")
        let pending = await engine.intents.pending()
        XCTAssertEqual(pending.map(\.kind), [.archive])
        // A list read meanwhile still has it live: the row stays out.
        try store.upsertSessions([record()])
        XCTAssertEqual(try store.session(id: "s")?.isArchived, true, "a stale list brought it back")

        http.onRaw("POST /v1/sessions/s/archive", #"{"success":true}"#)
        await engine.setConnected(true)
        try await drained(engine)
        XCTAssertEqual(http.requests("POST /v1/sessions/s/archive").count, 2, "one try offline, one that went")
        XCTAssertEqual(try store.session(id: "s")?.active, false)
        XCTAssertEqual(try store.session(id: "s")?.isArchived, true)
    }

    func testAnArchiveNotPendingIsResetAtLaunch() async throws {
        do {
            let (store, engine, _) = try await launch()
            try store.upsertSessions([record()])
            try store.setSessionArchiving(id: "s", true)
            await engine.stop()
            try store.close()
        }
        let (store, _, _) = try await launch()
        XCTAssertEqual(try store.session(id: "s")?.archiving, false, "an archive answered last run, or never kept")
    }

    func testADeletedSessionStaysGoneThroughAStaleListThenGoes() async throws {
        offline("DELETE /v1/sessions/s")
        let (store, engine, actions) = try await launch()
        try store.upsertSessions([record()])
        try await actions.delete(sessionId: "s")
        XCTAssertNil(try store.session(id: "s"))
        try store.upsertSessions([record()])
        XCTAssertNil(try store.session(id: "s"), "a stale list brought it back")

        http.onRaw("DELETE /v1/sessions/s", #"{"success":true}"#)
        await engine.setConnected(true)
        try await drained(engine)
        XCTAssertEqual(http.requests("DELETE /v1/sessions/s").count, 2)
    }

    /// Sent after a relaunch, the server says no: the row is back, and the
    /// rejection is marked unheard so home says why.
    func testARefusalAfterARelaunchPutsTheRowBack() async throws {
        offline("POST /v1/sessions/s/archive")
        do {
            let (store, engine, actions) = try await launch()
            try store.upsertSessions([record()])
            try await actions.archive(sessionId: "s")
            await engine.stop()
            try store.close()
        }
        let (store, engine, _) = try await launch()
        let rejections = await engine.intents.rejections()
        http.onRaw("POST /v1/sessions/s/archive", "no", status: 403)
        await engine.setConnected(true)
        var iterator = rejections.makeAsyncIterator()
        let rejection = await iterator.next()
        XCTAssertEqual(rejection?.intent.kind, .archive)
        XCTAssertEqual(rejection?.heard, false)
        for _ in 0..<300 where (try? store.session(id: "s")?.archiving) == true { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(try store.session(id: "s")?.archiving, false)
        XCTAssertEqual(try store.session(id: "s")?.isArchived, false)
    }

    /// A machine that looks unreachable only because this phone is offline
    /// isn't a refusal: the task's archive waits for the socket.
    func testATaskArchiveOfflineWaitsRatherThanFailing() async throws {
        let (store, engine, actions) = try await launch()
        var task = record("t")
        task.metadata = .object(["task": .object(["id": .string("task1"), "name": .string("Launch")])])
        try store.upsertSessions([task])
        try await actions.archive(sessionId: "t")
        XCTAssertEqual(try store.session(id: "t")?.archiving, true)
        let pending = await engine.intents.pending()
        XCTAssertEqual(pending.map(\.kind), [.archive])
        XCTAssertTrue(http.requests.isEmpty, "a task is never archived on the server")
    }

    func testRefusalReasonsReadBack() {
        for error in [SessionActionError.unknownSession, .notDecryptable, .noAnswer, .botNeedsMachine, .taskNeedsMachine, .failed(""), .failed("Only its owner may.")] {
            XCTAssertEqual(SessionActionError(refusal: error.refusalReason), error)
        }
    }
}
