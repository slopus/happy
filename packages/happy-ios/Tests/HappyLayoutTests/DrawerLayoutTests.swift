import Foundation
import HappyLayout
import XCTest

/// The phone's drawer: the panel, the switcher at its top, the list, and
/// Settings at its foot, on an iPhone 12 (390 × 844, 47 over, 34 under).
final class DrawerLayoutTests: XCTestCase {
    private let phone = CGSize(width: 390, height: 844)
    private let safe = LayoutInsets(top: 47, bottom: 34)

    func testThePanelHeaderListAndFooterOnAPhone() {
        let layout = DrawerLayout(size: phone, safeArea: safe, header: CGSize(width: 200, height: 36), footerHeight: 76)
        XCTAssertEqual(layout.panel, CGRect(x: 0, y: 0, width: 327, height: 844))
        XCTAssertEqual(layout.header, CGRect(x: 16, y: 59, width: 200, height: 36))
        XCTAssertEqual(layout.list, CGRect(x: 0, y: 103, width: 327, height: 631))
        XCTAssertEqual(layout.footer, CGRect(x: 0, y: 734, width: 327, height: 76))
    }

    /// Settings' card: one 48 row, 8 over it and 24 under, as the list lays it out.
    func testTheFooterHoldsOneRowWithTheListsRoom() {
        XCTAssertEqual(DrawerLayout.footerHeight(width: 327), 80)
    }

    func testALongNameStopsInsideThePanel() {
        let layout = DrawerLayout(size: phone, safeArea: safe, header: CGSize(width: 400, height: 36), footerHeight: 76)
        XCTAssertEqual(layout.header, CGRect(x: 16, y: 59, width: 295, height: 36))
    }

    /// A wide screen never gets a panel wider than 340.
    func testThePanelHasAMaximumWidth() {
        XCTAssertEqual(DrawerLayout.width(for: 1000), 340)
        XCTAssertEqual(DrawerLayout.width(for: 375), 315)
    }

    /// In landscape the panel runs under the notch's side; its content doesn't.
    func testLandscapeKeepsTheContentOutOfTheSafeArea() {
        let layout = DrawerLayout(size: CGSize(width: 844, height: 390), safeArea: LayoutInsets(top: 0, left: 47, bottom: 21, right: 47), header: CGSize(width: 200, height: 36), footerHeight: 76)
        XCTAssertEqual(layout.panel, CGRect(x: 0, y: 0, width: 340, height: 390))
        XCTAssertEqual(layout.header, CGRect(x: 63, y: 12, width: 200, height: 36))
        XCTAssertEqual(layout.list, CGRect(x: 47, y: 56, width: 293, height: 237))
        XCTAssertEqual(layout.footer, CGRect(x: 47, y: 293, width: 293, height: 76))
    }

    func testRightToLeftOpensFromTheRight() {
        let layout = DrawerLayout(size: phone, safeArea: safe, header: CGSize(width: 200, height: 36), footerHeight: 76, rightToLeft: true)
        XCTAssertEqual(layout.panel, CGRect(x: 63, y: 0, width: 327, height: 844))
        XCTAssertEqual(layout.header, CGRect(x: 174, y: 59, width: 200, height: 36))
        XCTAssertEqual(layout.list, CGRect(x: 63, y: 103, width: 327, height: 631))
        XCTAssertEqual(DrawerLayout.offset(progress: 0, width: 327, rightToLeft: true), 327)
    }

    func testTheSlideFollowsTheFinger() {
        XCTAssertEqual(DrawerLayout.offset(progress: 0, width: 327), -327)
        XCTAssertEqual(DrawerLayout.offset(progress: 0.5, width: 327), -163.5)
        XCTAssertEqual(DrawerLayout.offset(progress: 1, width: 327), 0)
        XCTAssertEqual(DrawerLayout.offset(progress: 2, width: 327), 0)
        XCTAssertEqual(DrawerLayout.progress(from: 0, translation: 163.5, width: 327), 0.5)
        XCTAssertEqual(DrawerLayout.progress(from: 1, translation: -400, width: 327), 0)
        XCTAssertEqual(DrawerLayout.progress(from: 0, translation: -100, width: 327, rightToLeft: true), 100 / 327)
    }

    /// A flick decides; a slow release settles to the nearer end.
    func testLettingGoSettlesOpenOrShut() {
        XCTAssertTrue(DrawerLayout.settlesOpen(progress: 0.4, velocity: 600))
        XCTAssertFalse(DrawerLayout.settlesOpen(progress: 0.9, velocity: -600))
        XCTAssertTrue(DrawerLayout.settlesOpen(progress: 0.6, velocity: 0))
        XCTAssertFalse(DrawerLayout.settlesOpen(progress: 0.4, velocity: 100))
        XCTAssertTrue(DrawerLayout.settlesOpen(progress: 0.4, velocity: -600, rightToLeft: true))
    }
}
