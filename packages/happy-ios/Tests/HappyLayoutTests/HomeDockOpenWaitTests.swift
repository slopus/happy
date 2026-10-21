import HappyLayout
import XCTest

/// The open composer waits up to 32ms for its text's height before it
/// grows, and the frame it gives the modal shrinks by what that took.
final class HomeDockOpenWaitTests: XCTestCase {
    func testTheWaitIsTwoFrames() {
        XCTAssertEqual(HomeDockFocusMotion.heightWait, 0.032)
    }

    func testAHeightAlreadyMeasuredKeepsTheModalsFrame() {
        XCTAssertEqual(HomeDockFocusMotion.openDelay(afterWaiting: 0), HomeDockFocusMotion.openDelay)
    }

    func testTheWaitCountsTowardsTheModalsFrame() {
        XCTAssertEqual(HomeDockFocusMotion.openDelay(afterWaiting: 0.01), 0.006, accuracy: 1e-9)
    }

    func testAWaitPastTheFrameStartsAtOnce() {
        XCTAssertEqual(HomeDockFocusMotion.openDelay(afterWaiting: HomeDockFocusMotion.heightWait), 0)
        XCTAssertEqual(HomeDockFocusMotion.openDelay(afterWaiting: 1), 0)
    }

    func testAClockThatRanBackwardsWaitsTheWholeFrame() {
        XCTAssertEqual(HomeDockFocusMotion.openDelay(afterWaiting: -0.5), HomeDockFocusMotion.openDelay)
    }
}
