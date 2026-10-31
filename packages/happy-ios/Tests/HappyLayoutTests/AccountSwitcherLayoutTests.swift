import Foundation
import HappyLayout
import XCTest

final class AccountSwitcherLayoutTests: XCTestCase {
    func testNameUsesTheAvailableHeaderWidthOnOneCentredLine() {
        let room = AccountSwitcherLayout.availableWidth(barWidth: 393, safeArea: .zero, trailingItems: 1)
        XCTAssertEqual(room, 305)
        let layout = AccountSwitcherLayout(title: CGSize(width: 210, height: 20), chevron: CGSize(width: 10, height: 6), maxWidth: room)
        XCTAssertEqual(layout.size, CGSize(width: 274, height: 36))
        XCTAssertEqual(layout.title, CGRect(x: 40, y: 8, width: 210, height: 20))
        XCTAssertEqual(layout.picture, CGRect(x: 4, y: 4, width: 28, height: 28))
        XCTAssertEqual(layout.chevron, CGRect(x: 254, y: 15, width: 10, height: 6))
    }

    func testLongNamesTruncateBeforeTheTrailingActions() {
        let room = AccountSwitcherLayout.availableWidth(barWidth: 393, safeArea: LayoutInsets(left: 20, right: 20), trailingItems: 2)
        XCTAssertEqual(room, 217)
        let layout = AccountSwitcherLayout(title: CGSize(width: 500, height: 20), chevron: CGSize(width: 10, height: 6), maxWidth: room)
        XCTAssertEqual(layout.size.width, room)
        XCTAssertEqual(layout.title.width, 153)
        XCTAssertEqual(layout.chevron.maxX, room - 10)
    }

    func testFloatingSearchHasRoomForTheWholeLastRowAndGlass() {
        let layout = HomeBottomBarLayout(height: 874, safeBottom: 83, control: CGRect(x: 20, y: 800, width: 300, height: 38))
        XCTAssertEqual(layout.bottomInset, 86)
        let aboveKeyboard = HomeBottomBarLayout(height: 874, safeBottom: 83, control: CGRect(x: 20, y: 484, width: 300, height: 38))
        XCTAssertEqual(aboveKeyboard.bottomInset, 402)
        XCTAssertEqual(HomeBottomBarLayout(height: 874, safeBottom: 83, control: nil).bottomInset, 83)
    }

    func testSearchPullHasACancellationThreshold() {
        XCTAssertFalse(HomeSearchPresentationLayout.shouldDismiss(distance: 40, velocity: 0))
        XCTAssertTrue(HomeSearchPresentationLayout.shouldDismiss(distance: 110, velocity: 0))
        XCTAssertTrue(HomeSearchPresentationLayout.shouldDismiss(distance: 30, velocity: 800))
        XCTAssertFalse(HomeSearchPresentationLayout.shouldDismiss(distance: 10, velocity: 800))
    }
}