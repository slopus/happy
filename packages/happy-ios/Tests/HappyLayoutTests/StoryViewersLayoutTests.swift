import XCTest
@testable import HappyLayout

final class StoryViewersLayoutTests: XCTestCase {
    func testTheHalfOpenSheetRunsEdgeToEdgeToTheFootUnderA56Header() {
        let container = CGSize(width: 402, height: 874)
        XCTAssertEqual(StoryViewersSheetLayout.half(874), 525)
        XCTAssertEqual(StoryViewersSheetLayout.full(874), 802)
        XCTAssertEqual(StoryViewersSheetLayout.sheet(container: container, shown: 525), CGRect(x: 0, y: 349, width: 402, height: 525))
        XCTAssertEqual(StoryViewersSheetLayout.sheet(container: container, shown: 802), CGRect(x: 0, y: 72, width: 402, height: 802))
        let inside = StoryViewersSheetLayout(size: CGSize(width: 402, height: 525), titleSize: CGSize(width: 61.4, height: 20.3))
        XCTAssertEqual(inside.header, CGRect(x: 0, y: 0, width: 402, height: 56))
        XCTAssertEqual(inside.title, CGRect(x: 170, y: 17, width: 62, height: 21))
        XCTAssertEqual(inside.list, CGRect(x: 0, y: 56, width: 402, height: 469))
    }

    func testAClosingSheetKeepsItsHalfHeightAndSlidesDown() {
        XCTAssertEqual(StoryViewersSheetLayout.sheet(container: CGSize(width: 402, height: 874), shown: 200), CGRect(x: 0, y: 674, width: 402, height: 525))
        XCTAssertEqual(StoryViewersSheetLayout.sheet(container: CGSize(width: 402, height: 874), shown: 0).minY, 874)
    }

    func testAShortScreenStillShowsSomeOfTheList() {
        XCTAssertEqual(StoryViewersSheetLayout.half(400), 88)
    }

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
