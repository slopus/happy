import CoreGraphics
import HappyLayout
import XCTest

/// A conversation's title in the navigation bar: the name alone on the
/// bar's line, or the name over its status, both centred.
final class ChatHeaderLayoutTests: XCTestCase {
    func testTheNameAloneIsCentredOnTheBarsLine() {
        let layout = ChatHeaderLayout(titleWidth: 140.3, statusWidth: nil, maxWidth: 274)
        XCTAssertEqual(layout.size, CGSize(width: 141, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 0, y: 11, width: 141, height: 22))
        XCTAssertNil(layout.status)
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
