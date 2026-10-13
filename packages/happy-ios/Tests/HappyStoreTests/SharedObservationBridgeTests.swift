import Foundation
import XCTest
@testable import HappyStore

private final class RetainedSnapshots: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var peak = 0
    var current: Int { lock.withLock { count } }
    var maximum: Int { lock.withLock { peak } }
    func created() { lock.withLock { count += 1; peak = max(peak, count) } }
    func destroyed() { lock.withLock { count -= 1 } }
}

private final class TrackedSnapshot: @unchecked Sendable {
    let id: Int
    private let retained: RetainedSnapshots
    init(_ id: Int, retained: RetainedSnapshots) {
        self.id = id
        self.retained = retained
        retained.created()
    }
    deinit { retained.destroyed() }
}

private final class DeliveredSnapshots: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [Int] = []
    var values: [Int] { lock.withLock { ids } }
    func append(_ id: Int) { lock.withLock { ids.append(id) } }
}

final class SharedObservationBridgeTests: XCTestCase {
    private enum Terminal: Error, Equatable { case expected }

    func testHeldDeliveryCoalescesThousandSnapshotsBeforeTerminalError() async {
        let retained = RetainedSnapshots()
        let delivered = DeliveredSnapshots()
        let entered = expectation(description: "first snapshot is in flight")
        let ended = expectation(description: "latest snapshot then error")
        let release = DispatchSemaphore(value: 0)
        let delivery = SharedObservationDelivery<TrackedSnapshot>(onError: { error in
            XCTAssertEqual(error as? Terminal, .expected)
            XCTAssertEqual(delivered.values, [0, 1000])
            ended.fulfill()
        }, onChange: { snapshot in
            delivered.append(snapshot.id)
            if snapshot.id == 0 {
                entered.fulfill()
                _ = release.wait(timeout: .now() + 2)
            }
            return true
        })
        delivery.offer(TrackedSnapshot(0, retained: retained))
        await fulfillment(of: [entered], timeout: 5)
        for id in 1...1000 { delivery.offer(TrackedSnapshot(id, retained: retained)) }
        XCTAssertEqual(retained.current, 2, "one in-flight DTO and one pending DTO")
        XCTAssertLessThanOrEqual(retained.maximum, 3, "offering also owns one temporary DTO")
        delivery.fail(Terminal.expected)
        delivery.offer(TrackedSnapshot(1001, retained: retained))
        XCTAssertEqual(retained.current, 2, "values after an error are discarded")
        release.signal()
        await fulfillment(of: [ended], timeout: 5)
        delivery.cancel()
    }

    func testCancellationDropsPendingSnapshotErrorAndCallbacks() async {
        let retained = RetainedSnapshots()
        let entered = expectation(description: "first snapshot is in flight")
        let extra = expectation(description: "no pending value or error after cancellation")
        extra.isInverted = true
        let release = DispatchSemaphore(value: 0)
        let delivery = SharedObservationDelivery<TrackedSnapshot>(onError: { _ in
            extra.fulfill()
        }, onChange: { snapshot in
            if snapshot.id == 0 {
                entered.fulfill()
                _ = release.wait(timeout: .now() + 2)
            } else { extra.fulfill() }
            return true
        })
        delivery.offer(TrackedSnapshot(0, retained: retained))
        await fulfillment(of: [entered], timeout: 5)
        delivery.offer(TrackedSnapshot(1, retained: retained))
        delivery.fail(Terminal.expected)
        delivery.cancel()
        delivery.cancel()
        XCTAssertEqual(retained.current, 1, "cancellation drops the pending DTO while delivery is held")
        release.signal()
        await fulfillment(of: [extra], timeout: 0.05)
    }
}