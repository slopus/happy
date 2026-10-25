import XCTest
@testable import HappyLayout

final class StoryViewersLayoutTests: XCTestCase {
    func testAReactorsRowCentresNameAndTimeBesideTheAvatarWithTheReactionRight() {
        let row = StoryViewersRowLayout(width: 393, titleHeight: 20.3, subtitleHeight: 17.9, reacted: true)
        XCTAssertEqual(row.height, 60)
        XCTAssertEqual(row.avatar, CGRect(x: 10, y: 10, width: 40, height: 40))
        // 21 + 2 + 18 = 41 tall, centred in the inner 58.
        XCTAssertEqual(row.title, CGRect(x: 62, y: 9, width: 291, height: 21))
        XCTAssertEqual(row.subtitle, CGRect(x: 62, y: 32, width: 291, height: 18))
        XCTAssertEqual(row.reaction, CGRect(x: 357, y: 19, width: 22, height: 22))
        XCTAssertEqual(row.separatorLeading, 62)
        XCTAssertEqual(row.separatorTrailing, 16)
    }

    func testAViewerWithNothingUnderTheirNameHasAShorterRowAndTheNameCentred() {
        let row = StoryViewersRowLayout(width: 393, titleHeight: 20.3, subtitleHeight: nil, reacted: false)
        XCTAssertEqual(row.height, 50)
        XCTAssertEqual(row.avatar, CGRect(x: 10, y: 5, width: 40, height: 40))
        XCTAssertEqual(row.title, CGRect(x: 62, y: 14, width: 323, height: 21))
        XCTAssertNil(row.subtitle)
        XCTAssertNil(row.reaction)
    }

    func testANarrowRowNeverGivesTheTextANegativeWidth() {
        let row = StoryViewersRowLayout(width: 80, titleHeight: 20, subtitleHeight: 18, reacted: true)
        XCTAssertEqual(row.title.width, 0)
        XCTAssertEqual(row.subtitle?.width, 0)
    }
}
