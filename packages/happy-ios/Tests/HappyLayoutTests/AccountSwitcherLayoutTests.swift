import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class AccountSwitcherLayoutTests: XCTestCase {
    func testReservedStatusWidthKeepsTheWholeSwitcherFixedForAShortName() {
        let baseline = AccountSwitcherLayout(title: CGSize(width: 30, height: 18), subtitle: CGSize(width: 20, height: 14), subtitleHeight: 14, chevron: CGSize(width: 10, height: 6), reservedSubtitleWidth: 100)
        XCTAssertEqual(baseline.size, CGSize(width: 150, height: 36))
        XCTAssertEqual(baseline.title, CGRect(x: 40, y: 2, width: 30, height: 18))
        XCTAssertEqual(baseline.subtitle, CGRect(x: 40, y: 20, width: 100, height: 14))
        for width: CGFloat in [30, 55, 100] {
            XCTAssertEqual(AccountSwitcherLayout(title: CGSize(width: 30, height: 18), subtitle: CGSize(width: width, height: 14), subtitleHeight: 14, chevron: CGSize(width: 10, height: 6), reservedSubtitleWidth: 100), baseline)
        }
    }

    func testAShortNameFitsAsMeasured() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 40, height: 20), subtitle: nil, subtitleHeight: 14, chevron: CGSize(width: 10, height: 6))
        XCTAssertEqual(layout.picture, CGRect(x: 4, y: 4, width: 28, height: 28))
        XCTAssertEqual(layout.title, CGRect(x: 40, y: 1, width: 40, height: 20))
        XCTAssertNil(layout.subtitle)
        XCTAssertEqual(layout.chevron, CGRect(x: 84, y: 8, width: 10, height: 6))
        XCTAssertEqual(layout.size, CGSize(width: 104, height: 36))
    }

    func testTheNameStaysPutAsTheConnectionComesAndGoes() {
        let live = AccountSwitcherLayout(title: CGSize(width: 40, height: 18), subtitle: nil, subtitleHeight: 14, chevron: CGSize(width: 10, height: 6))
        let connecting = AccountSwitcherLayout(title: CGSize(width: 40, height: 18), subtitle: CGSize(width: 30, height: 14), subtitleHeight: 14, chevron: CGSize(width: 10, height: 6))
        XCTAssertEqual(live.title, connecting.title)
        XCTAssertEqual(live.chevron, connecting.chevron)
        XCTAssertEqual(live.size, connecting.size)
    }

    func testTheConnectionHangsUnderTheName() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 40, height: 18), subtitle: CGSize(width: 70, height: 14), subtitleHeight: 14, chevron: CGSize(width: 10, height: 6))
        XCTAssertEqual(layout.title, CGRect(x: 40, y: 2, width: 40, height: 18))
        XCTAssertEqual(layout.subtitle, CGRect(x: 40, y: 20, width: 70, height: 14))
        // The subtitle is wider than the name and its chevron.
        XCTAssertEqual(layout.size.width, 40 + 70 + 10)
    }

    func testALongNameShortensAtTheMaximum() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 500, height: 20), subtitle: CGSize(width: 500, height: 14), subtitleHeight: 14, chevron: CGSize(width: 10, height: 6))
        XCTAssertEqual(layout.size.width, 200)
        XCTAssertEqual(layout.title.width, 200 - 40 - 4 - 10 - 10)
        XCTAssertEqual(layout.chevron.maxX, 200 - 10)
        XCTAssertEqual(layout.subtitle?.width, 200 - 40 - 4 - 10 - 10)
    }

    func testANarrowerBarCapsItSooner() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 500, height: 20), subtitle: nil, subtitleHeight: 14, chevron: CGSize(width: 10, height: 6), maxWidth: 150)
        XCTAssertEqual(layout.size.width, 150)
    }
}
