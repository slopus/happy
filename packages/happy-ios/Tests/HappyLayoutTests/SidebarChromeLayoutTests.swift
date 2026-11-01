import Foundation
import HappyLayout
import XCTest

final class SidebarChromeLayoutTests: XCTestCase {
    /// The 13-inch iPad's floating sidebar: 340 wide, 1329 tall, 10 of
    /// safe area at its foot.
    private let sidebar = CGSize(width: 340, height: 1329)

    func testSettingsAtTheBottomLeftAndComposeAtTheBottomRight() {
        let layout = SidebarBottomBarLayout(size: sidebar, safeArea: LayoutInsets(top: 0, bottom: 10), composeWidth: 139.3)
        // 16 off the foot (more than its 10 of safe area) and the sides.
        XCTAssertEqual(layout.settings, CGRect(x: 16, y: 1265, width: 48, height: 48))
        XCTAssertEqual(layout.compose, CGRect(x: 184, y: 1265, width: 140, height: 48))
        XCTAssertEqual(layout.bar, CGRect(x: 16, y: 1265, width: 308, height: 48))
    }

    func testTheSafeAreaWinsWhereItIsMore() {
        let layout = SidebarBottomBarLayout(size: sidebar, safeArea: LayoutInsets(top: 0, bottom: 34), composeWidth: 120)
        XCTAssertEqual(layout.settings.minY, 1329 - 34 - 48)
        XCTAssertEqual(layout.compose?.minY, 1329 - 34 - 48)
    }

    func testComposeIsHeldToTheRoomBesideSettings() {
        let layout = SidebarBottomBarLayout(size: sidebar, safeArea: .zero, composeWidth: 500)
        // 340 - 16 - 48 - 12 - 16.
        XCTAssertEqual(layout.compose, CGRect(x: 76, y: 1265, width: 248, height: 48))
        XCTAssertEqual(layout.compose.map { $0.minX - layout.settings.maxX }, 12)
    }

    func testWithNothingToStartOnlySettings() {
        let layout = SidebarBottomBarLayout(size: sidebar, safeArea: .zero, composeWidth: nil)
        XCTAssertNil(layout.compose)
        XCTAssertEqual(layout.bar, layout.settings)
    }

    func testTheSearchFieldRestsUnderTheBarAndTheListUnderIt() {
        let layout = SidebarSearchLayout(width: 340, chromeTop: 86, scrolled: 0, pinned: false, cancelWidth: nil)
        XCTAssertEqual(layout.field, CGRect(x: 16, y: 94, width: 308, height: 36))
        XCTAssertNil(layout.cancel)
        XCTAssertEqual(layout.alpha, 1)
        XCTAssertEqual(layout.listTop, 134)
    }

    func testTheFieldScrollsWithTheListAndFadesUnderTheBar() {
        // Read down 26: the field's top at the bar's foot, still whole.
        let half = SidebarSearchLayout(width: 340, chromeTop: 86, scrolled: 26, pinned: false, cancelWidth: nil)
        XCTAssertEqual(half.field, CGRect(x: 16, y: 68, width: 308, height: 36))
        XCTAssertEqual(half.alpha, 0.5)
        XCTAssertEqual(half.listTop, 134, "the list's inset never moves")
        let gone = SidebarSearchLayout(width: 340, chromeTop: 86, scrolled: 200, pinned: false, cancelWidth: nil)
        XCTAssertEqual(gone.alpha, 0)
        // Pulled down, it comes down with the rows.
        let pulled = SidebarSearchLayout(width: 340, chromeTop: 86, scrolled: -40, pinned: false, cancelWidth: nil)
        XCTAssertEqual(pulled.field.minY, 134)
        XCTAssertEqual(pulled.alpha, 1)
    }

    func testOpenSearchPinsTheFieldWithCancelBesideIt() {
        let layout = SidebarSearchLayout(width: 340, chromeTop: 86, scrolled: 300, pinned: true, cancelWidth: 51.4)
        XCTAssertEqual(layout.field, CGRect(x: 16, y: 94, width: 248, height: 36))
        XCTAssertEqual(layout.cancel, CGRect(x: 272, y: 94, width: 52, height: 36))
        XCTAssertEqual(layout.alpha, 1)
    }
}
