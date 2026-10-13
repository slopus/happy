import Foundation
import GRDB
import HappyWire
import XCTest
@testable import HappyCore
@testable import HappyStore

/// Counts the troubleshooting feed's machine query.
private final class TroubleshootReads: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func trace(_ event: Database.TraceEvent) {
        if event.description.contains("FROM machine ORDER BY createdAt DESC, id") {
            lock.withLock { count += 1 }
        }
    }
}

/// Long enough for a cancelled subscription to leave the store.
private func visibleFeedSettle() async throws {
    try await Task.sleep(for: .milliseconds(200))
}

/// The troubleshoot screen follows its feed only while it is on screen.
final class ApplyPerfVisibleFeedTests: XCTestCase {
    private func machine(_ name: String) -> MachineRecord {
        MachineRecord(id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 100,
            metadataVersion: 1, metadataCipher: "", metadata: .object(["displayName": .string(name)]), daemonStateVersion: 0,
            daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: true)
    }

    private func rename(_ store: LocalStore, _ name: String, version: Int) throws {
        _ = try store.applyMachineUpdate(id: "m", metadata: .init(version: version, cipher: name, value: .object(["displayName": .string(name)])),
                                         daemonState: nil, active: nil, activeAt: nil)
    }

    @MainActor
    func testAScreenReadsOnlyWhileOnScreenAndReadsTheDiskAfreshOnReturn() async throws {
        let reads = TroubleshootReads()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { reads.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        try store.upsertMachine(machine("Laptop"))
        let feed = TroubleshootingFeed(store: store)
        let recorder = ApplyPerfRecorder<TroubleshootState>()
        let screen = VisibleFeed<TroubleshootState> { recorder.take($0) }

        screen.start { feed.snapshots() }
        await applyPerfWait { recorder.outputs.count == 1 }
        XCTAssertEqual(recorder.outputs.last?.computers.map(\.name), ["Laptop"])
        try rename(store, "Desk", version: 2)
        await applyPerfWait { recorder.outputs.count == 2 }
        XCTAssertEqual(recorder.outputs.last?.computers.map(\.name), ["Desk"], "on screen, changes arrive")

        screen.stop()
        XCTAssertFalse(screen.isFollowing)
        try await visibleFeedSettle()
        let away = reads.value
        try rename(store, "Server", version: 3)
        try await visibleFeedSettle()
        XCTAssertEqual(reads.value, away, "nothing is read for a screen that is away")
        XCTAssertEqual(recorder.outputs.count, 2)

        screen.start { feed.snapshots() }
        XCTAssertTrue(screen.isFollowing)
        await applyPerfWait { recorder.outputs.count == 3 }
        XCTAssertEqual(recorder.outputs.last?.computers.map(\.name), ["Server"], "coming back reads the database afresh")
        XCTAssertEqual(reads.value, away + 1)

        // Away and back with nothing changed: read again, nothing applied.
        screen.stop()
        try await visibleFeedSettle()
        screen.start { feed.snapshots() }
        await applyPerfWait { reads.value == away + 2 && screen.counts?.unchanged == 1 }
        XCTAssertEqual(screen.counts?.applies, 0)
        XCTAssertEqual(recorder.outputs.count, 3)

        screen.stop()
        await feed.stop()
        await store.stopSnapshotProducers()
    }

    @MainActor
    func testStartingTwiceSubscribesOnceAndARefusedValueIsOfferedAgain() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertMachine(machine("Laptop"))
        let feed = TroubleshootingFeed(store: store)
        let recorder = ApplyPerfRecorder<TroubleshootState>()
        recorder.refuses = true
        let screen = VisibleFeed<TroubleshootState> { recorder.take($0) }
        var subscriptions = 0
        screen.start { subscriptions += 1; return feed.snapshots() }
        screen.start { subscriptions += 1; return feed.snapshots() }
        XCTAssertEqual(subscriptions, 1)

        await applyPerfWait { recorder.outputs.count == 1 }
        XCTAssertEqual(screen.counts?.rejected, 1)
        // Refused, so not what the screen shows: the same value is taken
        // after coming back.
        screen.stop()
        try await visibleFeedSettle()
        recorder.refuses = false
        screen.start { feed.snapshots() }
        await applyPerfWait { recorder.outputs.count == 2 }
        XCTAssertEqual(recorder.outputs[1], recorder.outputs[0])
        XCTAssertEqual(screen.counts?.applies, 1)

        screen.stop()
        await feed.stop()
        await store.stopSnapshotProducers()
    }
}
