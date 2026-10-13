import Foundation
import XCTest
import HappyCrypto
import HappyStore
import HappyWire
@testable import HappyCore

final class SyncPerfPresenceTests: XCTestCase {
    private func fixture() throws -> (LocalStore, SyncEngineTests.Clock, SessionPresence) {
        let store = try LocalStore.inMemory()
        let clock = SyncEngineTests.Clock()
        var session = ChatRecords.storeSession()
        session.active = true
        session.activeAt = clock.now
        try store.upsertSessions([session])
        return (store, clock, SessionPresence(store: store, now: { clock.now }))
    }

    func testThinkingFlipsImmediatelyAndIdleSettlesUnreadWithoutReassertingRead() async throws {
        let (store, clock, presence) = try fixture()
        let home = HomeFeed(store: store).snapshots()
        _ = try await syncPerfNext(home)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        clock.now += 1
        await presence.activity(id: "s", active: true, activeAt: clock.now, thinking: true)
        let busy = try await syncPerfNext(home)
        XCTAssertEqual(busy?.sessions.first?.thinking, true)
        XCTAssertEqual(commits.value, 1)
        clock.now += 1
        await presence.activity(id: "s", active: true, activeAt: clock.now, thinking: false)
        let idle = try await syncPerfNext(home)
        XCTAssertEqual(idle?.sessions.first?.thinking, false)
        XCTAssertEqual(idle?.sessions.first?.unread, true)
        XCTAssertEqual(commits.value, 2)
        try store.markSessionRead(id: "s")
        let read = try await syncPerfNext(home)
        XCTAssertEqual(read?.sessions.first?.unread, false)
    }

    func testOfflineClearsThinkingAndStaleStampCannotBringItBack() async throws {
        let (store, clock, presence) = try fixture()
        clock.now += 2
        await presence.activity(id: "s", active: true, activeAt: clock.now, thinking: true)
        let home = HomeFeed(store: store).snapshots()
        _ = try await syncPerfNext(home)
        clock.now += 2
        await presence.activity(id: "s", active: false, activeAt: clock.now, thinking: true)
        let offline = try await syncPerfNext(home)
        XCTAssertEqual(offline?.sessions.first?.active, false)
        XCTAssertEqual(offline?.sessions.first?.thinking, false)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        await presence.activity(id: "s", active: true, activeAt: clock.now - 1, thinking: true)
        try store.addPendingSettings(["sentinel": .bool(true)])
        let next = try await syncPerfNext(home)
        XCTAssertEqual(next?.settings.pending["sentinel"], .bool(true))
        XCTAssertEqual(next?.sessions.first?.active, false)
        XCTAssertEqual(commits.value, 1, "sentinel only, stale presence is ignored")
    }

    func testServerOfflinePacketAndLastSeenPublishAtMinuteGranularity() async throws {
        let (store, clock, presence) = try fixture()
        let home = HomeFeed(store: store).snapshots()
        _ = try await syncPerfNext(home)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        clock.now += 10 * 60_000
        await presence.tick()
        XCTAssertEqual(try store.session(id: "s")?.active, true, "only the server changes active, regardless of device clock")
        await presence.activity(id: "s", active: false, activeAt: 1_000_000, thinking: false)
        let expired = try await syncPerfNext(home)
        XCTAssertEqual(expired?.sessions.first?.active, false)
        XCTAssertEqual(expired?.sessions.first?.thinking, false)
        XCTAssertEqual(expired?.presenceNow, clock.now)
        XCTAssertEqual(commits.value, 1)
        clock.now += 30_000
        await presence.tick() // Same "10 minutes ago": no value.
        clock.now += 30_000
        await presence.tick()
        let minute = try await syncPerfNext(home)
        XCTAssertEqual(minute?.presenceNow, clock.now)
        XCTAssertEqual(commits.value, 1, "the displayed clock is not a database write")
    }

    func testTenMachineHeartbeatsPublishNothingAndSixtySecondCheckpointIsOneBatch() async throws {
        let store = try LocalStore.inMemory()
        let clock = SyncEngineTests.Clock()
        try store.replaceMachines((0..<10).map { index in
            MachineRecord(id: "m\(index)", seq: 0, createdAt: Int64(index), updatedAt: 1,
                          active: true, activeAt: clock.now, metadataVersion: 0, metadataCipher: "",
                          metadata: nil, daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil,
                          dataKeyCipher: nil, decryptable: false)
        })
        let presence = SessionPresence(store: store, now: { clock.now })
        let firstHome = expectation(description: "home initial")
        let firstMachines = expectation(description: "machines initial")
        let homeChurn = expectation(description: "no home heartbeat value")
        let machineChurn = expectation(description: "no machine heartbeat value")
        homeChurn.isInverted = true
        machineChurn.isInverted = true
        let homeValues = PageCounter(), machineValues = PageCounter()
        let homeTask = Task {
            for await _ in HomeFeed(store: store).snapshots() {
                homeValues.count += 1
                if homeValues.count == 1 { firstHome.fulfill() } else { homeChurn.fulfill() }
            }
        }
        let machineTask = Task {
            for await _ in MachinesFeed(store: store).snapshots() {
                machineValues.count += 1
                if machineValues.count == 1 { firstMachines.fulfill() } else { machineChurn.fulfill() }
            }
        }
        defer { homeTask.cancel(); machineTask.cancel() }
        await fulfillment(of: [firstHome, firstMachines], timeout: 5)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        for tick in 1...15 {
            clock.now = 1_000_000 + Int64(tick * 2000)
            for index in 0..<10 { await presence.machineActivity(id: "m\(index)", active: true, activeAt: clock.now) }
        }
        XCTAssertEqual(commits.value, 0)
        clock.now = 1_061_000
        await presence.tick()
        await fulfillment(of: [homeChurn, machineChurn], timeout: 0.05)
        XCTAssertEqual(commits.value, 1)
        XCTAssertEqual(homeValues.count, 1)
        XCTAssertEqual(machineValues.count, 1)
        XCTAssertTrue(try store.machines().allSatisfy { $0.activeAt == 1_030_000 })
        print("SYNC_PERF 10-machine-heartbeats: modifying_commits_30s=0 home_values=0 machines_values=0 checkpoint_commits_61s=1")
        try await presence.stop()
        await presence.machineActivity(id: "m0", active: false, activeAt: clock.now + 1)
        XCTAssertEqual(try store.machine(id: "m0")?.active, true, "stopped presence ignores later packets")
    }

    func testBackgroundFlushAndRestartKeepLatestStamp() async throws {
        let store = try LocalStore.inMemory()
        let clock = SyncEngineTests.Clock()
        var row = ChatRecords.storeSession()
        row.activeAt = clock.now
        try store.upsertSessions([row])
        let engine = SyncEngine(api: testAPI(FakeHTTP()), store: store,
                                keys: try AccountKeys(secret: Data(repeating: 3, count: 32)), now: { clock.now })
        clock.now += 2000
        await engine.handle(.activity(sessionId: "s", active: true, activeAt: clock.now, thinking: false))
        XCTAssertEqual(try store.session(id: "s")?.activeAt, 1_000_000)
        await engine.setBackgrounded(true)
        XCTAssertEqual(try store.session(id: "s")?.activeAt, clock.now)
        await engine.stop()
        let restarted = SessionPresence(store: store, now: { clock.now })
        await restarted.activity(id: "s", active: false, activeAt: clock.now - 1, thinking: false)
        XCTAssertEqual(try store.session(id: "s")?.active, true)
        try await restarted.stop()
    }

    func testCriticalWireStampCheckpointsEvenWithClientClockSkew() async throws {
        let (store, clock, presence) = try fixture()
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        await presence.activity(id: "s", active: true, activeAt: clock.now + 61_000, thinking: false)
        XCTAssertEqual(commits.value, 1)
        XCTAssertEqual(try store.session(id: "s")?.activeAt, clock.now + 61_000)
    }

    func testMachineOfflinePacketsAreImmediateAndMonotonicDespiteClockSkew() async throws {
        let store = try LocalStore.inMemory()
        let clock = SyncEngineTests.Clock()
        let machine = MachineRecord(id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: true,
                                    activeAt: clock.now, metadataVersion: 0, metadataCipher: "", metadata: nil,
                                    daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil,
                                    dataKeyCipher: nil, decryptable: false)
        try store.replaceMachines([machine])
        let presence = SessionPresence(store: store, now: { clock.now })
        let stream = MachinesFeed(store: store).snapshots()
        _ = try await syncPerfNext(stream)
        clock.now += 2
        await presence.machineActivity(id: "m", active: false, activeAt: clock.now)
        let offline = try await syncPerfNext(stream)
        XCTAssertEqual(offline?.machines.first?.active, false)
        await presence.machineActivity(id: "m", active: true, activeAt: clock.now - 1)
        XCTAssertEqual(try store.machine(id: "m")?.active, false)
        clock.now += 2
        await presence.machineActivity(id: "m", active: true, activeAt: clock.now)
        let online = try await syncPerfNext(stream)
        XCTAssertEqual(online?.machines.first?.active, true)
        clock.now += 10 * 60_000
        await presence.tick()
        XCTAssertEqual(try store.machine(id: "m")?.active, true)
        await presence.machineActivity(id: "m", active: false, activeAt: clock.now - 10 * 60_000)
        let expired = try await syncPerfNext(stream)
        XCTAssertEqual(expired?.machines.first?.active, false)
    }

    func testAheadAndBehindClientClocksCannotFlapLiveSessionOrMachinePresence() async throws {
        for skew: Int64 in [15 * 60_000, -15 * 60_000] {
            let store = try LocalStore.inMemory()
            let clock = SyncEngineTests.Clock()
            let wireStart: Int64 = 1_000_000
            let clientStart = wireStart + skew
            clock.now = clientStart
            try store.upsertSessions((0..<10).map { index in
                var row = ChatRecords.storeSession("s\(index)")
                row.activeAt = wireStart
                return row
            })
            try store.replaceMachines((0..<10).map { index in
                MachineRecord(id: "m\(index)", seq: 0, createdAt: 1, updatedAt: 1, active: true,
                              activeAt: wireStart, metadataVersion: 0, metadataCipher: "", metadata: nil,
                              daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil,
                              dataKeyCipher: nil, decryptable: false)
            })
            let presence = SessionPresence(store: store, now: { clock.now })
            let initialHome = expectation(description: "home initial"), initialMachines = expectation(description: "machines initial")
            let homeChurn = expectation(description: "no skew home value"), machineChurn = expectation(description: "no skew machine value")
            homeChurn.isInverted = true
            machineChurn.isInverted = true
            let homes = PageCounter(), machines = PageCounter()
            let watchingHome = Task {
                for await _ in HomeFeed(store: store).snapshots() {
                    homes.count += 1
                    if homes.count == 1 { initialHome.fulfill() } else { homeChurn.fulfill() }
                }
            }
            let watchingMachines = Task {
                for await _ in MachinesFeed(store: store).snapshots() {
                    machines.count += 1
                    if machines.count == 1 { initialMachines.fulfill() } else { machineChurn.fulfill() }
                }
            }
            defer { watchingHome.cancel(); watchingMachines.cancel() }
            await fulfillment(of: [initialHome, initialMachines], timeout: 5)
            let commits = SyncPerfCommits()
            store.writer.add(transactionObserver: commits)
            for tick in 1...15 {
                if tick == 8 { clock.now = clientStart + 15_000; await presence.tick() }
                clock.now = clientStart + Int64(tick * 2000)
                let wireStamp = wireStart + Int64(tick * 2000)
                for index in 0..<10 {
                    await presence.activity(id: "s\(index)", active: true, activeAt: wireStamp, thinking: false)
                    await presence.machineActivity(id: "m\(index)", active: true, activeAt: wireStamp)
                }
            }
            await presence.tick() // 30s, after the last live packet.
            XCTAssertEqual(commits.value, 0)
            XCTAssertEqual(homes.count, 1)
            XCTAssertEqual(machines.count, 1)
            XCTAssertTrue(try store.sessions().allSatisfy { $0.active && !$0.thinking })
            XCTAssertTrue(try store.machines().allSatisfy(\.active))
            try await presence.stop()
            XCTAssertEqual(commits.value, 1, "one separate stop checkpoint for all 20 dirty rows")
            await fulfillment(of: [homeChurn, machineChurn], timeout: 0.05)
            XCTAssertEqual(homes.count, 1)
            XCTAssertEqual(machines.count, 1)
        }
    }

    func testSilenceDoesNotInventOfflineStateAndOnlyDirtyPresenceCheckpoints() async throws {
        let (store, clock, presence) = try fixture()
        clock.now += 2000
        await presence.activity(id: "s", active: true, activeAt: clock.now, thinking: false)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        clock.now += 11 * 60_000
        await presence.tick()
        XCTAssertEqual(try store.session(id: "s")?.active, true)
        XCTAssertEqual(commits.value, 1, "only the previously dirty timestamp is checkpointed")
        clock.now += 60_000
        await presence.tick()
        XCTAssertEqual(try store.session(id: "s")?.active, true)
        XCTAssertEqual(commits.value, 1, "an empty minute checkpoint writes nothing")
        await presence.activity(id: "s", active: false, activeAt: 1_002_000, thinking: false)
        XCTAssertEqual(try store.session(id: "s")?.active, false)
        XCTAssertEqual(commits.value, 2, "server timeout flips offline immediately")
    }
}