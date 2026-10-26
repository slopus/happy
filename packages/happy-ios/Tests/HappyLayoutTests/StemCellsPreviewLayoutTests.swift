import XCTest
@testable import HappyLayout

final class StemCellsPreviewLayoutTests: XCTestCase {
    func testAPhonesPreviewIsTheScreenLess12ASideAndAtMost460Tall() {
        // iPhone 17 Pro: 402 × 874, 62 over and 34 under the safe area.
        XCTAssertEqual(StemCellsPreviewLayout.size(screen: CGSize(width: 402, height: 874), top: 62, bottom: 34, regular: false), CGSize(width: 378, height: 460))
        // A short screen gives up height before the menu's room.
        XCTAssertEqual(StemCellsPreviewLayout.size(screen: CGSize(width: 375, height: 500), top: 20, bottom: 0, regular: false), CGSize(width: 351, height: 456))
    }

    func testARegularWidthPreviewIsAtMost400Wide() {
        XCTAssertEqual(StemCellsPreviewLayout.size(screen: CGSize(width: 1024, height: 1366), top: 24, bottom: 20, regular: true), CGSize(width: 400, height: 460))
    }

    func testTheNameSitsCentredInACapsuleAtTheTopAndTheMessagesUnderIt() {
        let layout = StemCellsPreviewLayout(size: CGSize(width: 378, height: 460), titleSize: CGSize(width: 120.4, height: 20.3))
        XCTAssertEqual(layout.pill, CGRect(x: 112, y: 10, width: 153, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 128, y: 21, width: 121, height: 21))
        XCTAssertEqual(layout.listTop, 62)
        XCTAssertEqual(layout.listBottom, 8)
        // The ground covers down to the capsule's foot and is gone 24 under it.
        XCTAssertEqual(layout.fadeClear, 54)
        XCTAssertEqual(layout.fadeOpaque, 78)
    }

    func testALongNameIsCutToTheCardLessItsMargins() {
        let layout = StemCellsPreviewLayout(size: CGSize(width: 378, height: 460), titleSize: CGSize(width: 900, height: 20))
        XCTAssertEqual(layout.pill, CGRect(x: 16, y: 10, width: 346, height: 44))
        XCTAssertEqual(layout.title.width, 314)
    }
}
