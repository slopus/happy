import Foundation
import GRDB
import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

private final class HomeSQLCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func trace(_ event: Database.TraceEvent) {
        if event.description.lowercased().contains("select * from \"session\" order by") {
            lock.withLock { count += 1 }
        }
    }
}

final class SyncPerfObservationTests: XCTestCase {
    func testSevenHomeSubscribersShareOneFetchAndReceiveOffMain() async throws {
        let counter = HomeSQLCounter()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { counter.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        try store.upsertSessions([ChatRecords.storeSession()])
        let streams = (0..<7).map { _ in HomeFeed(store: store).snapshots() }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for stream in streams {
                group.addTask {
                    let first = try await syncPerfNext(stream)
                    XCTAssertFalse(Thread.isMainThread)
                    XCTAssertEqual(first?.sessions.map(\.id), ["s"])
                }
            }
            try await group.waitForAll()
        }
        XCTAssertEqual(counter.value, 1, "all seven clients share one database fetch and JSON decode")
    }

    func testEqualRowsDoNotPublishAndUnrelatedCursorsDoNotFetch() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let stream = HomeFeed(store: store).snapshots()
        let initial = try await syncPerfNext(stream)
        XCTAssertEqual(initial?.sessions.count, 1)
        try store.upsertSessions([ChatRecords.storeSession()])
        try store.setCursor(.sessionsChangedSince, 100)
        _ = try store.applySessionUpdate(id: "s", metadata: VersionedPayload(
            version: 2, cipher: "changed", value: .object(["title": .string("changed")])
        ), agentState: nil, projectId: nil)
        let next = try await syncPerfNext(stream)
        XCTAssertEqual(next?.sessions.first?.metadata?["title"], .string("changed"))
    }

    func testSettingsFeedReplaysCurrentValueThenDistinctChanges() async throws {
        let store = try LocalStore.inMemory()
        let feed = SettingsFeed(store: store)
        let a = feed.snapshots()
        let initial = try await syncPerfNext(a)
        XCTAssertEqual(initial?.pending, [:])
        try store.addPendingSettings(["theme": .string("dark")])
        let update = try await syncPerfNext(a)
        XCTAssertEqual(update?.pending, ["theme": .string("dark")])
        let b = feed.snapshots()
        let replay = try await syncPerfNext(b)
        XCTAssertEqual(replay, update)
    }
}