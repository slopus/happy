import Foundation
import GRDB
import XCTest
import HappyCrypto
import HappyStore
import HappyWire
@testable import HappyCore

private struct MachineDetailRandom: RandomSource {
    func bytes(_ count: Int) -> Data { Data(repeating: 7, count: count) }
}

private final class MachineDetailSQL: @unchecked Sendable {
    private let lock = NSLock()
    private var home = 0
    private var machine = 0
    private var onMain = false
    var counts: [Int] { lock.withLock { [home, machine] } }
    var fetchedOnMain: Bool { lock.withLock { onMain } }
    func trace(_ event: Database.TraceEvent) {
        let sql = event.description.lowercased()
        let isHome = sql.contains("select * from \"session\" order by")
        let isMachine = sql.contains("rowid desc limit 5")
        guard isHome || isMachine else { return }
        lock.withLock {
            if isHome { home += 1 }
            if isMachine { machine += 1 }
            onMain = onMain || Thread.isMainThread
        }
    }
}

final class SyncPerfMachineDetailTests: XCTestCase {
    private func fixture() throws -> (LocalStore, SyncEngine, RecordCipher, MachineDetailSQL) {
        let sql = MachineDetailSQL()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { sql.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        let keys = try AccountKeys(secret: Data(repeating: 3, count: 32))
        let key = Data(repeating: 5, count: 32)
        let cipher = RecordCipher(key: key)
        let wrapped = Base64.encode(try keys.wrapDataKey(key, random: MachineDetailRandom()))
        let decoder = RecordDecoder(keyRing: KeyRing(keys: keys))
        let rows = try (0..<1000).map { (index: Int) -> SessionRecord in
            let summary: [String: JSONValue] = ["text": .string("Session \(index)")]
            let metadata: [String: JSONValue] = [
                "machineId": .string(index < 7 ? "computer" : "other"),
                "path": .string("/home/test/project\(index)"), "homeDir": .string("/home/test"),
                "summary": .object(summary),
                "unrendered": .string(String(repeating: "x", count: 1024)),
            ]
            let updatedAt: Int64 = index == 5 ? 1006 : 1000 + Int64(index)
            return decoder.session(APISession(
                id: "s\(index)", seq: 0, createdAt: 1,
                updatedAt: updatedAt,
                active: true, activeAt: ApplyPerfFixtures.now,
                metadata: try cipher.encrypt(.object(metadata), random: MachineDetailRandom()), metadataVersion: 1, agentState: nil,
                agentStateVersion: 0, dataEncryptionKey: wrapped, projectId: nil
            ))
        }
        try store.upsertSessions(rows)
        var side = ApplyPerfFixtures.session(1000)
        side.id = "side"; side.updatedAt = 99_000
        side.metadata = .object(["machineId": .string("computer"), "isSideChat": .bool(true)])
        try store.upsertSessions([side])
        try store.replaceMachines([ApplyPerfFixtures.machine])
        return (store, SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: keys,
                                  now: { ApplyPerfFixtures.now }), cipher, sql)
    }

    func testSocketMessageOutsideTopFiveReordersMachineWithoutFetchingHome() async throws {
        let (store, engine, cipher, sql) = try fixture()
        let home = HomeFeed(store: store).snapshots()
        let initialHome = try await syncPerfNext(home)
        let expected = MachineDetailsModel(machine: ApplyPerfFixtures.machine, sessions: initialHome?.sessions ?? [])
        let feed = MachineDetailFeed(store: store)
        let machine = feed.snapshots(machineId: "computer")
        let initial = try await syncPerfNext(machine)
        XCTAssertEqual(initial?.model, expected, "including the stable tie inherited from old Home SQL ordering")
        XCTAssertEqual(initial?.model?.recentSessions.map(\.id), ["s6", "s5", "s4", "s3", "s2"])
        XCTAssertEqual(sql.counts, [1, 1])
        let unexpected = expectation(description: "socket message does not publish Home")
        unexpected.isInverted = true
        let homeTask = Task.detached { for await _ in home { unexpected.fulfill() } }
        defer { homeTask.cancel() }
        let payload: JSONValue = .object([
            "role": .string("session"), "content": .object([
                "id": .string("e1"), "time": .number(3000), "role": .string("agent"),
                "ev": .object(["t": .string("text"), "text": .string("new activity")]),
            ]),
        ])
        let message = SessionMessage(id: "m1", seq: 1, localId: nil,
                                     content: SessionMessageContent(c: try cipher.encrypt(payload, random: MachineDetailRandom())),
                                     createdAt: 3000, updatedAt: 3000)
        await engine.handle(UpdateContainer(id: "u1", seq: 1,
                                            body: .newMessage(sessionId: "s0", message: message), createdAt: 3000))
        let changed = try await syncPerfNext(machine)
        XCTAssertEqual(changed?.model?.recentSessions.map(\.id), ["s0", "s6", "s5", "s4", "s3"])
        XCTAssertEqual(changed?.model?.recentSessions.first?.subtitle, "~/project0")
        await fulfillment(of: [unexpected], timeout: 0.05)
        XCTAssertEqual(sql.counts, [1, 2], "one scoped machine fetch and zero additional Home fetches")
        XCTAssertFalse(sql.fetchedOnMain)
        feed.stop()
        homeTask.cancel()
        await store.stopSnapshotProducers()
        await engine.stop()
    }

    func testSQLProjectionLimitsToFiveAndExcludesUnrenderedSessionFields() async throws {
        let (store, engine, _, _) = try fixture()
        let value = try await syncPerfNext(store.machineDetailSnapshots(machineId: "computer"))
        XCTAssertEqual(value?.sessions.count, 5)
        XCTAssertEqual(value?.sessions.map(\.id), ["s6", "s5", "s4", "s3", "s2"])
        for record in value?.sessions ?? [] {
            XCTAssertNil(record.metadata?["unrendered"])
            XCTAssertEqual(record.metadataCipher, "")
            XCTAssertNil(record.dataKeyCipher)
            XCTAssertEqual(record.seq, 0)
            XCTAssertEqual(record.metadata?["machineId"], .string("computer"))
        }
        let unknown = try await syncPerfNext(store.machineDetailSnapshots(machineId: "missing"))
        XCTAssertNil(unknown?.machine)
        XCTAssertEqual(unknown?.sessions, [])
        if let unknown { XCTAssertNil(MachineScreenContent(unknown).model) }
        await engine.stop()
    }

    func testEqualProjectionDoesNotPublishAndMachineDeletionIsVisible() async throws {
        let (store, engine, _, _) = try fixture()
        let feed = MachineDetailFeed(store: store)
        let stream = feed.snapshots(machineId: "computer")
        _ = try await syncPerfNext(stream)
        let unexpected = expectation(description: "unrendered metadata publishes no content")
        unexpected.isInverted = true
        let watching = Task.detached { for await _ in stream { unexpected.fulfill() } }
        var record = try XCTUnwrap(store.session(id: "s6"))
        var metadata = record.metadata?.objectValue ?? [:]
        metadata["unrendered"] = .string("changed")
        record.metadata = .object(metadata); record.metadataVersion += 1
        try store.upsertSessions([record])
        await fulfillment(of: [unexpected], timeout: 0.05)
        watching.cancel()
        // A fresh stream avoids a second iterator consuming the same value.
        let current = feed.snapshots(machineId: "computer")
        _ = try await syncPerfNext(current)
        try store.replaceMachines([])
        let deleted = try await syncPerfNext(current)
        XCTAssertNil(deleted?.machine)
        XCTAssertNil(deleted?.model)
        feed.stop()
        await engine.stop()
    }

    func testAccountStopEndsFeedAndNewScopeReadsCurrentMachine() async throws {
        let (store, engine, _, _) = try fixture()
        let account = try AccountSession(credentials: Credentials(token: "test", secret: Data(repeating: 3, count: 32)),
                                         store: store, dependencies: .init(serverURL: testServer, clientID: "test",
                                                                         transport: FakeHTTP(), connector: FakeConnector()))
        let stream = account.machineDetails.snapshots(machineId: "computer")
        _ = try await syncPerfNext(stream)
        await account.stop()
        let ended = try await syncPerfNext(stream)
        XCTAssertNil(ended)
        var machine = ApplyPerfFixtures.machine
        machine.metadata = .object(["host": .string("Renamed")]); machine.metadataVersion += 1
        try store.replaceMachines([machine])
        let fresh = MachineDetailFeed(store: store)
        let replay = try await syncPerfNext(fresh.snapshots(machineId: "computer"))
        XCTAssertEqual(replay?.model?.name, "Renamed")
        fresh.stop()
        await engine.stop()
    }
}