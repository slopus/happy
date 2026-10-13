import Foundation
import GRDB
import XCTest
@testable import HappyStore
import HappyWire
@testable import HappyCore

private final class HomeSQLCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var mainFetch = false
    var value: Int { lock.withLock { count } }
    var fetchedOnMain: Bool { lock.withLock { mainFetch } }
    func trace(_ event: Database.TraceEvent) {
        if event.description.lowercased().contains("select * from \"session\" order by") {
            lock.withLock { count += 1; mainFetch = mainFetch || Thread.isMainThread }
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
        XCTAssertFalse(counter.fetchedOnMain, "assert inside the producer SQL trace, not only at the consumer")
    }

    func testEqualRowsDoNotPublishAndUnrelatedCursorsDoNotFetch() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let stream = HomeFeed(store: store).snapshots()
        let initial = try await syncPerfNext(stream)
        XCTAssertEqual(initial?.sessions.count, 1)
        try store.upsertSessions([ChatRecords.storeSession()])
        try store.setCursor(.sessionsLastFullSync, 100)
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

    func testEmptyFirstSessionListPublishesReadinessOnce() async throws {
        let counter = HomeSQLCounter()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { counter.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        try store.setCursor(.machinesLastSync, 100)
        try store.setCursor(.sessionsLastFullSync, 100)
        let stream = HomeFeed(store: store).snapshots()
        let initial = try await syncPerfNext(stream)
        XCTAssertEqual(initial?.sessionsSynced, false)
        try store.setCursor(.sessionsChangedSince, 100)
        let ready = try await syncPerfNext(stream)
        XCTAssertEqual(ready?.sessionsSynced, true)
        XCTAssertTrue(ready?.sessions.isEmpty == true)
        try store.setCursor(.sessionsChangedSince, 200)
        try store.setCursor(.machinesLastSync, 200)
        try store.setCursor(.sessionsLastFullSync, 200)
        try store.addPendingSettings(["theme": .string("dark")])
        let next = try await syncPerfNext(stream)
        XCTAssertEqual(next?.settings.pending["theme"], .string("dark"))
        XCTAssertEqual(counter.value, 3, "initial, readiness insert, and settings; no timestamp-only cursor fetches")
    }

    func testMessageCursorOnlyBumpDoesNotFetchHome() async throws {
        let counter = HomeSQLCounter()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { counter.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        try store.upsertSessions([ChatRecords.storeSession()])
        let stream = HomeFeed(store: store).snapshots()
        _ = try await syncPerfNext(stream)
        try store.applyMessagePage(sessionId: "s", messages: [], syncedThrough: 500)
        try store.addPendingSettings(["theme": .string("dark")])
        let next = try await syncPerfNext(stream)
        XCTAssertEqual(next?.settings.pending["theme"], .string("dark"))
        XCTAssertEqual(counter.value, 2, "initial fetch and settings change only; message cursors do not invalidate home")
    }

    func testSharedProducerCallbackRunsOffMain() async throws {
        let store = try LocalStore.inMemory()
        let delivered = expectation(description: "background producer")
        let observation = store.homeObservation.start(onError: { error in XCTFail("\(error)") }, onChange: { _ in
            XCTAssertFalse(Thread.isMainThread)
            delivered.fulfill()
        })
        await fulfillment(of: [delivered], timeout: 5)
        observation.cancel()
    }

    @MainActor
    func testCancelledCompatibilityObserverReceivesNoFurtherValues() async throws {
        let store = try LocalStore.inMemory()
        let initial = expectation(description: "initial")
        let cancelled = expectation(description: "cancelled observer")
        cancelled.isInverted = true
        var first = true
        let token = store.observeHome { _ in
            if first { first = false; initial.fulfill() }
            else { cancelled.fulfill() }
        }
        await fulfillment(of: [initial], timeout: 5)
        token.cancel()
        try store.addPendingSettings(["theme": .string("dark")])
        await fulfillment(of: [cancelled], timeout: 0.05)
        // Subscribing again starts the shared observation against current disk.
        let stream = HomeFeed(store: store).snapshots()
        let restarted = try await syncPerfNext(stream)
        XCTAssertEqual(restarted?.settings.pending["theme"], .string("dark"))
    }
}