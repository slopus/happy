import Foundation
import GRDB
import XCTest
import HappyWire
@testable import HappyStore
@testable import HappyCore

private final class TroubleSQLCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var onMain = false
    var value: Int { lock.withLock { count } }
    var fetchedOnMain: Bool { lock.withLock { onMain } }
    func trace(_ event: Database.TraceEvent) {
        if event.description.contains("FROM machine ORDER BY createdAt DESC, id") {
            lock.withLock { count += 1; onMain = onMain || Thread.isMainThread }
        }
    }
}

final class SyncPerfTroubleshootingTests: XCTestCase {
    private func machine(_ id: String, createdAt: Int64 = 1, metadata: [String: JSONValue] = [:]) -> MachineRecord {
        MachineRecord(id: id, seq: 0, createdAt: createdAt, updatedAt: 1, active: false, activeAt: 100,
            metadataVersion: 1, metadataCipher: "", metadata: .object(metadata), daemonStateVersion: 0,
            daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: true)
    }

    private func session(_ id: String, updatedAt: Int64, machineId: String = "m", path: String) -> SessionRecord {
        var row = ChatRecords.storeSession(id)
        row.updatedAt = updatedAt
        row.metadata = .object(["machineId": .string(machineId), "path": .string(path), "unused": .string(String(repeating: "x", count: 2000))])
        return row
    }

    func testSevenSubscribersShareNarrowSQLAndOneComputerDerivation() async throws {
        let counter = TroubleSQLCounter()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { counter.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        try store.upsertMachine(machine("m", metadata: ["host": .string("host")]))
        try store.upsertSessions((0..<1000).map { session("s\($0)", updatedAt: Int64($0), path: "/work/p\($0)") })
        let feed = TroubleshootingFeed(store: store)
        let streams = (0..<7).map { _ in feed.snapshots() }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for stream in streams {
                group.addTask {
                    let state = try await syncPerfNext(stream)
                    XCTAssertEqual(state?.computers.map(\.id), ["m"])
                    XCTAssertTrue(state?.aiPrompt.contains("p999") == true)
                }
            }
            try await group.waitForAll()
        }
        XCTAssertEqual(counter.value, 1)
        XCTAssertFalse(counter.fetchedOnMain)
        let initialBuilds = await feed.computerDerivationCount
        XCTAssertEqual(initialBuilds, 1)
        let raw = try await store.writer.read { try LocalStore.fetchTroubleshootingSnapshot($0) }
        XCTAssertNil(raw.machines[0].metadata?["unused"])
        XCTAssertEqual(raw.recentSession?.path, "/work/p999")
        _ = try store.applyLiveMessage(.init(id: "new", sessionId: "s0", seq: 1, localId: nil, createdAt: 2000, updatedAt: 2000, contentCipher: "", content: nil))
        let changed = try await syncPerfNext(streams[0])
        XCTAssertTrue(changed?.aiPrompt.contains("p0") == true, "a real live message changes the recent project")
        let laterBuilds = await feed.computerDerivationCount
        XCTAssertEqual(laterBuilds, 1, "session timestamp changes reuse the computer projection")
        await feed.stop()
        let stopped = try await syncPerfNext(feed.snapshots())
        XCTAssertNil(stopped)
        await store.stopSnapshotProducers()
    }

    func testProjectionMatchesMachineGroupingAndPromptAndIgnoresSideChats() async throws {
        let store = try LocalStore.inMemory()
        try store.replaceMachines([
            machine("happy", createdAt: 100, metadata: ["displayName": .string("Laptop"), "happyHomeDir": .string("/logs")]),
            machine("rig", createdAt: 200, metadata: ["client": .object(["id": .string("rig")]), "siblingMachineId": .string("happy"), "host": .string("host")]),
            machine("other", createdAt: 300, metadata: ["host": .string("Server")]),
        ])
        var side = session("side", updatedAt: 10000, machineId: "other", path: "/wrong")
        var sideFields = side.metadata?.objectValue ?? [:]
        sideFields["isSideChat"] = .bool(true)
        side.metadata = .object(sideFields)
        try store.upsertSessions([side, session("unknown", updatedAt: 9000, machineId: "missing", path: "/unknown"),
                                  session("recent", updatedAt: 500, machineId: "rig", path: "/work/expected/"),
                                  session("older", updatedAt: 100, machineId: "other", path: "/old")])
        let full = try store.homeSnapshot()
        let choices = MachineChoice.collect(full.machines.machines)
        let legacy = OfflineTroubleshooting(choices: choices, sessions: full.sessions.filter { $0.metadata?["isSideChat"]?.boolValue != true })
        let feed = TroubleshootingFeed(store: store)
        let stream = feed.snapshots()
        let first = try await syncPerfNext(stream)
        XCTAssertEqual(first?.computers, choices.map { .init(id: $0.id, name: $0.name, online: $0.online) })
        XCTAssertEqual(first?.aiPrompt, legacy.aiPrompt)
        XCTAssertTrue(first?.aiPrompt.contains("/logs") == true)
        XCTAssertTrue(first?.aiPrompt.contains("expected") == true)
        try store.replaceMachines([machine("other", createdAt: 300, metadata: ["host": .string("Server")])])
        let deleted = try await syncPerfNext(stream)
        XCTAssertEqual(deleted?.computers.map(\.id), ["other"])
        XCTAssertTrue(deleted?.aiPrompt.contains("old") == true, "machine deletion atomically selects the next known session")
        await feed.stop()
        await store.stopSnapshotProducers()
    }

    func testEqualPromptAndUnrenderedMachineFieldsPublishNothing() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertMachine(machine("m", metadata: ["host": .string("host")]))
        try store.upsertSessions([session("s", updatedAt: 100, path: "/work/project")])
        let feed = TroubleshootingFeed(store: store)
        let stream = feed.snapshots()
        _ = try await syncPerfNext(stream)
        let extra = expectation(description: "no rendered troubleshooting change")
        extra.isInverted = true
        let consumer = Task { for await _ in stream { extra.fulfill() } }
        _ = try store.applyMachineUpdate(id: "m", metadata: .init(version: 2, cipher: "changed", value: .object(["host": .string("host"), "models": .array([.string("ignored")])])), daemonState: nil, active: nil, activeAt: nil)
        _ = try store.applyLiveMessage(.init(id: "new", sessionId: "s", seq: 1, localId: nil, createdAt: 200, updatedAt: 200, contentCipher: "", content: nil))
        await fulfillment(of: [extra], timeout: 0.05)
        let builds = await feed.computerDerivationCount
        XCTAssertEqual(builds, 1)
        consumer.cancel()
        await feed.stop()
        await store.stopSnapshotProducers()
    }

    func testPresenceProjectionAndAccountStopPreserveServerFlagsAndFreshScope() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertMachine(machine("m", metadata: ["host": .string("host")]))
        let account = try AccountSession(credentials: .init(token: "test", secret: Data(repeating: 3, count: 32)), store: store,
                                        dependencies: .init(serverURL: URL(string: "https://test.invalid")!, clientID: "test", transport: FakeHTTP(), connector: FakeConnector()))
        let stream = account.troubleshootingFeed.snapshots()
        let first = try await syncPerfNext(stream)
        XCTAssertEqual(first?.computers.first?.online, false)
        let online = PresenceOverlayValue(active: true, latestAt: 200, displayedAt: 100)
        store.setMachinePresenceOverlay(id: "m", value: online)
        store.setPresenceDisplayClock(1_000_000)
        try store.persistPresence(sessions: [:], machines: ["m": online])
        let flipped = try await syncPerfNext(stream)
        XCTAssertEqual(flipped?.computers.first?.online, true, "the server's active flag survives an old clock stamp")
        await account.stop()
        let finished = try await syncPerfNext(stream)
        XCTAssertNil(finished)
        _ = try store.applyMachineUpdate(id: "m", metadata: nil, daemonState: nil, active: false, activeAt: 300)
        let newFeed = TroubleshootingFeed(store: store)
        let refreshed = try await syncPerfNext(newFeed.snapshots())
        XCTAssertEqual(refreshed?.computers.first?.online, false, "a new account scope reads current disk")
        await newFeed.stop()
        await store.stopSnapshotProducers()
    }
}