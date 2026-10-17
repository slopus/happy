import Foundation
import XCTest
@testable import HappyStore
import HappyWire
@testable import HappyCore

/// `HomeFeed.latest`: what a screen opened now draws in its first frame.
final class HomeFeedLatestTests: XCTestCase {
    func testLatestIsWhatSubscribersWereLastHanded() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let feed = HomeFeed(store: store)
        XCTAssertNil(feed.latest, "nothing read before anyone listens")
        let stream = feed.snapshots()
        let first = try await syncPerfNext(stream)
        XCTAssertEqual(feed.latest, first)

        _ = try store.applySessionUpdate(id: "s", metadata: VersionedPayload(
            version: 2, cipher: "changed", value: .object(["title": .string("changed")])
        ), agentState: nil, projectId: nil)
        let next = try await syncPerfNext(stream)
        XCTAssertEqual(next?.sessions.first?.metadata?["title"], .string("changed"))
        XCTAssertEqual(feed.latest, next)
        // Another feed of the same account reads the same, without a read.
        XCTAssertEqual(HomeFeed(store: store).latest, next)
        withExtendedLifetime(stream) {}
    }

    func testAStoppedAccountHasNoLatest() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let feed = HomeFeed(store: store)
        let stream = feed.snapshots()
        _ = try await syncPerfNext(stream)
        XCTAssertNotNil(feed.latest)
        await store.stopSnapshotProducers()
        XCTAssertNil(feed.latest)
        withExtendedLifetime(stream) {}
    }
}
