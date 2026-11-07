import XCTest
@testable import HappyCore

final class RadioWakeTests: XCTestCase {
    func testWithNoTrafficItWaitsUntilTheLatest() async throws {
        let wake = RadioWake()
        let start = ContinuousClock.now
        try await wake.next(after: .milliseconds(20), by: .milliseconds(120))
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - start, .milliseconds(120))
    }

    func testTrafficAfterTheEarliestEndsTheWait() async throws {
        let wake = RadioWake()
        let start = ContinuousClock.now
        // Off the main actor, as the event stream's reader is.
        let note = Task.detached {
            try await Task.sleep(for: .milliseconds(60))
            wake.noted()
        }
        try await wake.next(after: .milliseconds(20), by: .seconds(5))
        let waited = ContinuousClock.now - start
        XCTAssertGreaterThanOrEqual(waited, .milliseconds(60))
        XCTAssertLessThan(waited, .seconds(2))
        try await note.value
    }

    func testTrafficJustBeforeTheEarliestGoesAtTheEarliest() async throws {
        let wake = RadioWake()
        let start = ContinuousClock.now
        // Off the main actor, as the event stream's reader is.
        let note = Task.detached {
            try await Task.sleep(for: .milliseconds(10))
            wake.noted()
        }
        try await wake.next(after: .milliseconds(40), by: .seconds(5))
        XCTAssertLessThan(ContinuousClock.now - start, .seconds(2))
        try await note.value
    }

    func testCancellingStopsTheWait() async throws {
        let wake = RadioWake()
        let waiting = Task { try await wake.next(after: .milliseconds(10), by: .seconds(30)) }
        try await Task.sleep(for: .milliseconds(50))
        waiting.cancel()
        let start = ContinuousClock.now
        do {
            try await waiting.value
            XCTFail("a cancelled wait throws")
        } catch is CancellationError {}
        XCTAssertLessThan(ContinuousClock.now - start, .seconds(2))
    }
}
