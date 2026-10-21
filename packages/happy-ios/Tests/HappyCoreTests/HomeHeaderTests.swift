@testable import HappyCore
import XCTest

final class HomeConnectionStatusTests: XCTestCase {
    func testOnlyAnUnhealthySocketIsShown() {
        XCTAssertFalse(HomeConnectionStatus.shows(.connected))
        XCTAssertTrue(HomeConnectionStatus.shows(.connecting))
        XCTAssertTrue(HomeConnectionStatus.shows(.disconnected))
        XCTAssertTrue(HomeConnectionStatus.shows(.error))
    }

    func testACustomSubtitleOwnsTheLine() {
        XCTAssertFalse(HomeConnectionStatus.shows(.error, hasCustomSubtitle: true))
    }

    func testOnlyConnectingPulsesAndTheStartIsDisconnected() {
        XCTAssertTrue(HomeConnectionStatus.pulses(.connecting))
        XCTAssertFalse(HomeConnectionStatus.pulses(.error))
        XCTAssertEqual(HomeConnectionStatus.initial, .disconnected)
    }
}
