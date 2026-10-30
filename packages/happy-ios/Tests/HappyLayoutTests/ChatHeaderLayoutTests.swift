import CoreGraphics
import HappyLayout
import XCTest

/// A conversation's title in the navigation bar: the name over its
/// status, both centred, the name on the same line with or without one.
final class ChatHeaderLayoutTests: XCTestCase {
    func testStatusTextWidthsDoNotMoveEitherLineWhenTheirRoomIsReserved() {
        let baseline = ChatHeaderLayout(titleWidth: 40, statusWidth: 30, maxWidth: 274, reservedStatusWidth: 180)
        XCTAssertEqual(baseline.size, CGSize(width: 180, height: 44))
        XCTAssertEqual(baseline.title, CGRect(x: 70, y: 3, width: 40, height: 22))
        XCTAssertEqual(baseline.status, CGRect(x: 0, y: 25, width: 180, height: 16))
        for width: CGFloat in [20, 55, 100, 180] {
            XCTAssertEqual(ChatHeaderLayout(titleWidth: 40, statusWidth: width, maxWidth: 274, reservedStatusWidth: 180), baseline)
        }
    }

    func testTheNameKeepsItsLineWithNoStatus() {
        let layout = ChatHeaderLayout(titleWidth: 140.3, statusWidth: nil, maxWidth: 274)
        XCTAssertEqual(layout.size, CGSize(width: 141, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 0, y: 3, width: 141, height: 22))
        XCTAssertNil(layout.status)
    }

    func testTheStatusComingAndGoingMovesTheNameNot() {
        let idle = ChatHeaderLayout(titleWidth: 60, statusWidth: nil, maxWidth: 274)
        let working = ChatHeaderLayout(titleWidth: 60, statusWidth: 40, maxWidth: 274)
        XCTAssertEqual(idle.title, working.title)
        XCTAssertEqual(idle.size, working.size)
    }

    func testTheStatusSitsUnderTheNameAndTheWiderLineSetsTheWidth() {
        let layout = ChatHeaderLayout(titleWidth: 60, statusWidth: 100, maxWidth: 274)
        XCTAssertEqual(layout.size, CGSize(width: 100, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 20, y: 3, width: 60, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 0, y: 25, width: 100, height: 16))
    }

    func testALongNameIsCutAtTheWidestTheBarAllows() {
        let layout = ChatHeaderLayout(titleWidth: 900, statusWidth: 52, maxWidth: 274)
        XCTAssertEqual(layout.size.width, 274)
        XCTAssertEqual(layout.title, CGRect(x: 0, y: 3, width: 274, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 111, y: 25, width: 52, height: 16))
    }
}
