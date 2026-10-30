import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class AccountSwitcherLayoutTests: XCTestCase {
    func testAShortNameFitsAsMeasured() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 40, height: 20), subtitle: nil, chevron: CGSize(width: 10, height: 6))
        XCTAssertEqual(layout.picture, CGRect(x: 4, y: 4, width: 28, height: 28))
        XCTAssertEqual(layout.title, CGRect(x: 40, y: 8, width: 40, height: 20))
        XCTAssertNil(layout.subtitle)
        XCTAssertEqual(layout.chevron, CGRect(x: 84, y: 15, width: 10, height: 6))
        XCTAssertEqual(layout.size, CGSize(width: 104, height: 36))
    }

    func testTheConnectionHangsUnderTheName() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 40, height: 18), subtitle: CGSize(width: 70, height: 14), chevron: CGSize(width: 10, height: 6))
        XCTAssertEqual(layout.title, CGRect(x: 40, y: 2, width: 40, height: 18))
        XCTAssertEqual(layout.subtitle, CGRect(x: 40, y: 20, width: 70, height: 14))
        // The subtitle is wider than the name and its chevron.
        XCTAssertEqual(layout.size.width, 40 + 70 + 10)
    }

    func testALongNameShortensAtTheMaximum() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 500, height: 20), subtitle: CGSize(width: 500, height: 14), chevron: CGSize(width: 10, height: 6))
        XCTAssertEqual(layout.size.width, 200)
        XCTAssertEqual(layout.title.width, 200 - 40 - 4 - 10 - 10)
        XCTAssertEqual(layout.chevron.maxX, 200 - 10)
        XCTAssertEqual(layout.subtitle?.width, 200 - 40 - 4 - 10 - 10)
    }

    func testANarrowerBarCapsItSooner() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 500, height: 20), subtitle: nil, chevron: CGSize(width: 10, height: 6), maxWidth: 150)
        XCTAssertEqual(layout.size.width, 150)
    }
}
