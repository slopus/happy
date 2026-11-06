import Foundation
@testable import HappyCore
import XCTest

/// The migration card's flag as the core keeps it: an answer in memory,
/// which counts only while something may ask PostHog (the analytics
/// module), so a build without analytics never shows the card.
@MainActor
final class MigrationNoteFlagTests: XCTestCase {
    func testAYesCountsOnlyWhileSomethingAsks() {
        let flag = MigrationNoteFlag()
        flag.store(true)
        XCTAssertFalse(flag.isOn(optedOut: false), "nothing asks, as in a build without analytics")
        flag.isAnswering = true
        XCTAssertTrue(flag.isOn(optedOut: false))
        XCTAssertFalse(flag.isOn(optedOut: true))
        flag.store(nil)
        XCTAssertFalse(flag.isOn(optedOut: false))
    }

    func testAHarnessAnswerNeedsNoAsk() {
        let flag = MigrationNoteFlag()
        flag.fixedAnswer = true
        XCTAssertTrue(flag.isOn(optedOut: false))
        XCTAssertFalse(flag.isOn(optedOut: true))
    }

    func testObserversHearAnAnswerAndTheAskGoingAway() {
        let flag = MigrationNoteFlag()
        var heard = 0
        let observation = flag.observe { heard += 1 }
        flag.isAnswering = true
        flag.store(true)
        flag.isAnswering = false
        XCTAssertEqual(heard, 3)
        _ = observation
    }

    /// The answer kept per account by earlier builds is deleted.
    func testTheOldStoredAnswerIsDeleted() {
        let storage = InMemoryKeyValueStore()
        storage.set("true", forKey: "posthog.direct-connection-migration-note")
        _ = LocalSettings(storage: storage)
        XCTAssertNil(storage.string(forKey: "posthog.direct-connection-migration-note"))
    }
}
