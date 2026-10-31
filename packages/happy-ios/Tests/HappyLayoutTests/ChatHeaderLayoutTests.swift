import CoreGraphics
import HappyLayout
import XCTest

/// A conversation's title in the navigation bar: the name over its
/// status, both centred on one glass capsule as tall as the bar's buttons,
/// the name on the same line with or without a status.
final class ChatHeaderLayoutTests: XCTestCase {
    func testStatusTextWidthsDoNotMoveEitherLineWhenTheirRoomIsReserved() {
        let baseline = ChatHeaderLayout(titleWidth: 40, statusWidth: 30, maxWidth: 274, reservedStatusWidth: 180)
        XCTAssertEqual(baseline.size, CGSize(width: 204, height: 44))
        XCTAssertEqual(baseline.capsule, CGRect(x: 0, y: 0, width: 204, height: 44))
        XCTAssertEqual(baseline.title, CGRect(x: 82, y: 3, width: 40, height: 22))
        XCTAssertEqual(baseline.status, CGRect(x: 12, y: 25, width: 180, height: 16))
        for width: CGFloat in [20, 55, 100, 180] {
            XCTAssertEqual(ChatHeaderLayout(titleWidth: 40, statusWidth: width, maxWidth: 274, reservedStatusWidth: 180), baseline)
        }
    }

    func testTheNameKeepsItsLineWithNoStatus() {
        let layout = ChatHeaderLayout(titleWidth: 140.3, statusWidth: nil, maxWidth: 274)
        XCTAssertEqual(layout.size, CGSize(width: 165, height: 44))
        XCTAssertEqual(layout.capsule, CGRect(x: 0, y: 0, width: 165, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 12, y: 3, width: 141, height: 22))
        XCTAssertNil(layout.status)
    }

    func testTheStatusComingAndGoingMovesTheNameNot() {
        let idle = ChatHeaderLayout(titleWidth: 60, statusWidth: nil, maxWidth: 274)
        let working = ChatHeaderLayout(titleWidth: 60, statusWidth: 40, maxWidth: 274)
        XCTAssertEqual(idle.title, working.title)
        XCTAssertEqual(idle.capsule, working.capsule)
        XCTAssertEqual(idle.size, working.size)
    }

    func testTheStatusSitsUnderTheNameAndTheWiderLineSetsTheCapsule() {
        let layout = ChatHeaderLayout(titleWidth: 60, statusWidth: 100, maxWidth: 274)
        XCTAssertEqual(layout.size, CGSize(width: 124, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 32, y: 3, width: 60, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 12, y: 25, width: 100, height: 16))
    }

    func testALongNameIsCutInsideTheWidestCapsuleTheBarAllows() {
        let layout = ChatHeaderLayout(titleWidth: 900, statusWidth: 52, maxWidth: 274)
        XCTAssertEqual(layout.size.width, 274)
        XCTAssertEqual(layout.capsule, CGRect(x: 0, y: 0, width: 274, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 12, y: 3, width: 250, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 111, y: 25, width: 52, height: 16))
    }

    /// The bar hands the title more room than it asked for, as it does
    /// while it centres it: the capsule stays its own size, centred.
    func testTheCapsuleIsCentredInMoreRoomThanItWants() {
        let layout = ChatHeaderLayout(titleWidth: 60, statusWidth: 100, maxWidth: 274, bounds: CGSize(width: 200, height: 44))
        XCTAssertEqual(layout.size, CGSize(width: 200, height: 44))
        XCTAssertEqual(layout.capsule, CGRect(x: 38, y: 0, width: 124, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 70, y: 3, width: 60, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 50, y: 25, width: 100, height: 16))
    }

    /// Between a back button and two trailing buttons the bar may give
    /// less than the capsule asked for: it fits that, never past it, and
    /// the name is cut inside its ends.
    func testTheCapsuleFitsLessRoomThanItWanted() {
        let layout = ChatHeaderLayout(titleWidth: 400, statusWidth: 150, maxWidth: 265, bounds: CGSize(width: 213, height: 44))
        XCTAssertEqual(layout.capsule, CGRect(x: 0, y: 0, width: 213, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 12, y: 3, width: 189, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 32, y: 25, width: 150, height: 16))
    }

    /// A taller bar (a wide window's) centres the capsule on its height.
    func testTheCapsuleIsCentredOnATallerBar() {
        let layout = ChatHeaderLayout(titleWidth: 60, statusWidth: nil, maxWidth: 274, bounds: CGSize(width: 84, height: 50))
        XCTAssertEqual(layout.capsule, CGRect(x: 0, y: 3, width: 84, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 12, y: 6, width: 60, height: 22))
    }
}
