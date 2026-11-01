import Foundation
@testable import HappyCore
import XCTest

/// The header's debounce on a made-up clock: what shows at each moment as
/// the link comes and goes.
final class LinkStateDebounceTests: XCTestCase {
    func testAShortWobbleNeverShows() {
        var debounce = LinkStateDebounce(wanted: .online, now: 0)
        XCTAssertEqual(debounce.want(.connecting, now: 10), 10.8)
        XCTAssertEqual(debounce.shown, .online)
        XCTAssertEqual(debounce.want(.syncing, now: 10.4), 10.8, "still counted from when it went")
        XCTAssertEqual(debounce.settle(now: 10.5), 10.8)
        XCTAssertEqual(debounce.shown, .online)
        XCTAssertNil(debounce.want(.online, now: 10.79))
        XCTAssertNil(debounce.settle(now: 10.8))
        XCTAssertEqual(debounce.shown, .online, "back before 0.8 s: nothing was shown")
    }

    func testConnectingShowsAfterPointEightAndHoldsPointSix() {
        var debounce = LinkStateDebounce(wanted: .online, now: 0)
        XCTAssertEqual(debounce.want(.connecting, now: 1), 1.8)
        XCTAssertNil(debounce.settle(now: 1.8))
        XCTAssertEqual(debounce.shown, .connecting)
        // Live again at once: it stays until 0.6 s after it showed.
        XCTAssertEqual(debounce.want(.online, now: 1.9), 2.4)
        XCTAssertEqual(debounce.shown, .connecting)
        XCTAssertEqual(debounce.settle(now: 2.3), 2.4)
        XCTAssertNil(debounce.settle(now: 2.4))
        XCTAssertEqual(debounce.shown, .online)
    }

    func testTheDelayCountsFromLeavingOnlineNotFromTheLastChange() {
        var debounce = LinkStateDebounce(wanted: .online, now: 0)
        debounce.want(.connecting, now: 5)
        debounce.want(.syncing, now: 5.5)
        XCTAssertNil(debounce.settle(now: 5.8))
        XCTAssertEqual(debounce.shown, .syncing, "updating, 0.8 s after the link went")
    }

    func testWaitingForNetworkShowsAtOnceOverAnyHold() {
        var debounce = LinkStateDebounce(wanted: .online, now: 0)
        XCTAssertNil(debounce.want(.waitingForNetwork, now: 3))
        XCTAssertEqual(debounce.shown, .waitingForNetwork)
        debounce.want(.connecting, now: 3.1)
        XCTAssertEqual(debounce.shown, .waitingForNetwork, "held")
        XCTAssertNil(debounce.settle(now: 3.6))
        XCTAssertEqual(debounce.shown, .connecting, "from one status to the next as soon as the hold ends")
        XCTAssertNil(debounce.want(.waitingForNetwork, now: 3.7))
        XCTAssertEqual(debounce.shown, .waitingForNetwork, "no network breaks the hold")
    }

    /// The socket says connected a moment before its catch-up says it
    /// started: "Connecting…" hands straight to "Updating…".
    func testAMomentOfLiveBetweenTwoStatusesNeverShowsTheTitle() {
        var debounce = LinkStateDebounce(wanted: .online, now: 0)
        debounce.want(.connecting, now: 0)
        debounce.settle(now: 0.8)
        XCTAssertEqual(debounce.shown, .connecting)
        XCTAssertEqual(debounce.want(.online, now: 2), 2.3, "live has to stand 0.3 s")
        XCTAssertEqual(debounce.shown, .connecting)
        XCTAssertNil(debounce.want(.syncing, now: 2.01))
        XCTAssertEqual(debounce.shown, .syncing, "no title between")
    }

    func testLiveThatStandsGivesTheTitleBack() throws {
        var debounce = LinkStateDebounce(wanted: .online, now: 0)
        debounce.want(.connecting, now: 0)
        debounce.settle(now: 0.8)
        XCTAssertEqual(debounce.want(.online, now: 2), 2.3)
        XCTAssertEqual(debounce.settle(now: 2.2), 2.3)
        XCTAssertEqual(debounce.shown, .connecting)
        XCTAssertNil(debounce.settle(now: 2.3))
        XCTAssertEqual(debounce.shown, .online)
        // A new absence after that waits its own 0.8 s.
        XCTAssertEqual(try XCTUnwrap(debounce.want(.syncing, now: 2.5)), 3.3, accuracy: 1e-9)
        XCTAssertEqual(debounce.shown, .online)
    }

    func testAHeldStatusMovesStraightToTheNextOne() {
        var debounce = LinkStateDebounce(wanted: .online, now: 0)
        debounce.want(.connecting, now: 0)
        debounce.settle(now: 0.8)
        XCTAssertEqual(debounce.want(.syncing, now: 1.0), 1.4)
        XCTAssertEqual(debounce.shown, .connecting)
        XCTAssertEqual(debounce.want(.online, now: 1.2), 1.4)
        XCTAssertEqual(debounce.want(.syncing, now: 1.3), 1.4)
        XCTAssertNil(debounce.settle(now: 1.4))
        XCTAssertEqual(debounce.shown, .syncing, "connecting held, then updating with no title between")
        XCTAssertEqual(debounce.want(.online, now: 1.5), 2.0)
        XCTAssertNil(debounce.settle(now: 2.0))
        XCTAssertEqual(debounce.shown, .online)
    }

    func testALaunchShowsTheTitleUntilASlowConnectionSaysSo() {
        var debounce = LinkStateDebounce(wanted: .connecting, now: 100)
        XCTAssertEqual(debounce.shown, .online)
        XCTAssertEqual(debounce.settle(now: 100.5), 100.8)
        XCTAssertNil(debounce.settle(now: 100.8))
        XCTAssertEqual(debounce.shown, .connecting)
        var quick = LinkStateDebounce(wanted: .connecting, now: 100)
        quick.want(.online, now: 100.3)
        XCTAssertNil(quick.settle(now: 101))
        XCTAssertEqual(quick.shown, .online)
    }
}
