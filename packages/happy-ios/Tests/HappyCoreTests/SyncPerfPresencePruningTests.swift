import Foundation
import XCTest
import HappyCrypto
import HappyStore
import HappyWire
@testable import HappyCore

final class SyncPerfPresencePruningTests: XCTestCase {
    private func machine(_ id: String, activeAt: Int64 = 1_000_000) -> MachineRecord {
        MachineRecord(id: id, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: activeAt,
            metadataVersion: 0, metadataCipher: "", metadata: nil, daemonStateVersion: 0,
            daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: false)
    }

    private func engine(_ store: LocalStore, _ http: FakeHTTP, _ clock: SyncEngineTests.Clock) throws -> SyncEngine {
        SyncEngine(api: testAPI(http), store: store, keys: try AccountKeys(secret: Data(repeating: 3, count: 32)), now: { clock.now })
    }

    func testWireDeletesRemoveDirtyCachesAndDoNotPublishPhantomLastSeenTicks() async throws {
        let store = try LocalStore.inMemory()
        var row = ChatRecords.storeSession("s")
        row.active = false
        row.activeAt = 1_000_000
        try store.upsertSessions([row])
        try store.replaceMachines([machine("m")])
        let clock = SyncEngineTests.Clock()
        let sync = try engine(store, FakeHTTP(), clock)
        await sync.presence.tick()
        await sync.handle(.init(id: "delete-session", seq: 1, body: .deleteSession(sessionId: "s"), createdAt: clock.now))
        await sync.handle(.init(id: "delete-machine", seq: 2, body: .deleteMachine(machineId: "m"), createdAt: clock.now))
        let counts = await sync.presence.trackedCounts
        XCTAssertEqual(counts.sessions, 0)
        XCTAssertEqual(counts.machines, 0)
        let initial = expectation(description: "empty home")
        let phantom = expectation(description: "no deleted last-seen tick")
        phantom.isInverted = true
        let values = PageCounter()
        let watching = Task {
            for await value in HomeFeed(store: store).snapshots() {
                values.count += 1
                XCTAssertTrue(value.sessions.isEmpty)
                if values.count == 1 { initial.fulfill() } else { phantom.fulfill() }
            }
        }
        await fulfillment(of: [initial], timeout: 5)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        clock.now += 60_000
        await sync.presence.tick()
        await fulfillment(of: [phantom], timeout: 0.05)
        XCTAssertEqual(commits.value, 0)
        watching.cancel()

        // An id reintroduced with a lower wire stamp starts from its new row.
        row.activeAt = 0
        try store.upsertSessions([row])
        try store.replaceMachines([machine("m", activeAt: 0)])
        await sync.handle(.activity(sessionId: "s", active: true, activeAt: 1, thinking: false))
        await sync.handle(.machineActivity(machineId: "m", active: true, activeAt: 1))
        XCTAssertEqual(try store.session(id: "s")?.active, true)
        XCTAssertEqual(try store.machine(id: "m")?.active, true)
        await sync.stop()
    }

    func testFullSessionReconciliationPrunesDeletedCacheButPreservesLateRows() async throws {
        let store = try LocalStore.inMemory()
        var gone = ChatRecords.storeSession("gone")
        gone.updatedAt = 1
        gone.active = false
        gone.activeAt = 1_000_000
        var late = ChatRecords.storeSession("late")
        late.updatedAt = 200
        late.activeAt = 1_000_000
        try store.upsertSessions([gone, late])
        try store.setCursor(.sessionsChangedSince, 100)
        let http = FakeHTTP()
        http.on("GET /v2/sessions", json: SessionsPage(sessions: [], nextCursor: nil, hasNext: false))
        let clock = SyncEngineTests.Clock()
        let sync = try engine(store, http, clock)
        await sync.presence.tick()
        try await sync.pullSessions()
        let counts = await sync.presence.trackedCounts
        XCTAssertEqual(counts.sessions, 1)
        XCTAssertEqual(try store.sessions().map(\.id), ["late"], "live rows newer than the listing cutoff remain")
        let home = try await syncPerfNext(HomeFeed(store: store).snapshots())
        XCTAssertEqual(home?.sessions.map(\.id), ["late"])
        XCTAssertEqual(home?.sessions.first?.active, true)
        await sync.stop()
    }

    func testFullMachineReplacementPrunesCacheAndOverlayBeforeReintroduction() async throws {
        let store = try LocalStore.inMemory()
        try store.replaceMachines([machine("m")])
        let http = FakeHTTP()
        http.on("GET /v1/machines", json: [APIMachine]())
        let clock = SyncEngineTests.Clock()
        let sync = try engine(store, http, clock)
        await sync.presence.tick()
        try await sync.pullMachines()
        let counts = await sync.presence.trackedCounts
        XCTAssertEqual(counts.machines, 0)
        try store.replaceMachines([machine("m", activeAt: 0)])
        let snapshot = try await syncPerfNext(MachinesFeed(store: store).snapshots())
        XCTAssertEqual(snapshot?.machines.first?.activeAt, 0)
        await sync.handle(.machineActivity(machineId: "m", active: true, activeAt: 1))
        XCTAssertEqual(try store.machine(id: "m")?.active, true)
        await sync.stop()
    }
}