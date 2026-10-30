import XCTest
@testable import HappyLayout

final class StartLayoutTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)
    private let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)

    /// 759 of safe height less the logo (≈58.5), Start (56) and 16 leaves
    /// ≈628.5 free, split 3 : 2 : 1.
    func testTheFreeHeightSplitsThreeTwoOne() {
        let layout = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 120, height: 56))
        let logoHeight = 220 / (1200.0 / 319.0)
        let free = 759 - logoHeight - 56 - 16
        XCTAssertEqual(layout.logo.minY, 59 + free / 2, accuracy: 0.001)
        XCTAssertEqual(layout.logo.width, 220)
        XCTAssertEqual(layout.logo.midX, 196.5)
        XCTAssertEqual(layout.button.minY - layout.logo.maxY, free / 3, accuracy: 0.001)
        XCTAssertEqual(852 - 34 - 16 - layout.button.maxY, free / 6, accuracy: 0.001)
        XCTAssertEqual(layout.contentHeight, 759)
    }

    func testStartIsAtLeastTwoHundredWideAndCentred() {
        let layout = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 120, height: 56))
        XCTAssertEqual(layout.button.width, 200)
        XCTAssertEqual(layout.button.midX, 196.5)
        let wide = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 260, height: 56))
        XCTAssertEqual(wide.button.width, 260)
    }

    func testMoreSitsFourInFromTheTopRightOfTheSafeArea() {
        let layout = StartLayout(size: phone, safeArea: LayoutInsets(top: 59, left: 0, bottom: 34, right: 20), button: CGSize(width: 120, height: 56))
        XCTAssertEqual(layout.more, CGRect(x: 393 - 20 - 4 - 48, y: 63, width: 48, height: 48))
    }

    func testTooTallItScrollsWithNothingFree() {
        let layout = StartLayout(size: CGSize(width: 393, height: 200), safeArea: safe, button: CGSize(width: 120, height: 180))
        XCTAssertEqual(layout.logo.minY, 59)
        XCTAssertEqual(layout.button.minY, layout.logo.maxY)
        XCTAssertEqual(layout.contentHeight, layout.logo.height + 180 + 16, accuracy: 0.001)
    }
}
