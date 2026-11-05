import Foundation
@testable import HappyCore
import XCTest

/// The migration card's flag as the core keeps it: a stored yes counts only
/// while something may ask PostHog (the analytics module), so a build
/// without analytics never shows the card.
@MainActor
final class MigrationNoteFlagTests: XCTestCase {
    func testAStoredYesCountsOnlyWhileSomethingAsks() {
        let flag = MigrationNoteFlag()
        let storage = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: storage)
        flag.store(true, in: settings)
        XCTAssertFalse(flag.isOn(settings, optedOut: false), "nothing asks, as in a build without analytics")
        flag.isAnswering = true
        XCTAssertTrue(flag.isOn(settings, optedOut: false))
        XCTAssertFalse(flag.isOn(settings, optedOut: true))
        XCTAssertEqual(LocalSettings(storage: storage).migrationNoteFlag, true, "kept for the account")
        flag.store(nil, in: settings)
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
    }

    func testAHarnessAnswerNeedsNoAsk() {
        let flag = MigrationNoteFlag()
        flag.fixedAnswer = true
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        XCTAssertTrue(flag.isOn(settings, optedOut: false))
        XCTAssertFalse(flag.isOn(settings, optedOut: true))
    }

    func testObserversHearAnAnswerAndTheAskGoingAway() {
        let flag = MigrationNoteFlag()
        var heard = 0
        let observation = flag.observe { heard += 1 }
        flag.isAnswering = true
        flag.store(true, in: LocalSettings(storage: InMemoryKeyValueStore()))
        flag.isAnswering = false
        XCTAssertEqual(heard, 3)
        _ = observation
    }
}
