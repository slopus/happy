import XCTest
@testable import HappyLayout

final class StartLayoutTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)
    private let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)
    private let logoHeight = 220 / (1200.0 / 319.0)

    func testStartSitsFortyEightAboveTheBottomInset() {
        let layout = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 120, height: 56))
        XCTAssertEqual(layout.button.maxY, 852 - 34 - 48)
        XCTAssertEqual(layout.contentHeight, 759)
    }

    func testTheLogoIsCentredInTheSpaceAboveStart() {
        let layout = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 120, height: 56))
        XCTAssertEqual(layout.logo.minY - 59, layout.button.minY - layout.logo.maxY, accuracy: 0.001)
        XCTAssertEqual(layout.logo.width, 220)
        XCTAssertEqual(layout.logo.midX, 196.5)
    }

    func testStartIsAsWideAsItsLabelAtLeastTwoHundredAndCentred() {
        let layout = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 120, height: 56))
        XCTAssertEqual(layout.button.width, 200)
        XCTAssertEqual(layout.button.midX, 196.5)
        let wide = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 260, height: 56))
        XCTAssertEqual(wide.button.width, 260)
        XCTAssertEqual(wide.button.midX, 196.5)
        let shifted = StartLayout(size: phone, safeArea: LayoutInsets(top: 59, left: 40, bottom: 34, right: 0), button: CGSize(width: 120, height: 56))
        XCTAssertEqual(shifted.button.midX, 40 + 353 / 2)
    }

    func testMoreSitsFourInFromTheTopRightOfTheSafeArea() {
        let layout = StartLayout(size: phone, safeArea: LayoutInsets(top: 59, left: 0, bottom: 34, right: 20), button: CGSize(width: 120, height: 56))
        XCTAssertEqual(layout.more, CGRect(x: 393 - 20 - 4 - 48, y: 63, width: 48, height: 48))
    }

    func testTooTallItScrollsWithNothingFree() {
        let layout = StartLayout(size: CGSize(width: 393, height: 200), safeArea: safe, button: CGSize(width: 120, height: 180))
        XCTAssertEqual(layout.logo.minY, 59, accuracy: 0.001)
        XCTAssertEqual(layout.button.minY, layout.logo.maxY, accuracy: 0.001)
        XCTAssertEqual(layout.contentHeight, logoHeight + 180 + 48, accuracy: 0.001)
    }
}
