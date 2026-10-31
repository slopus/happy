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

    /// An iPhone 17 Pro's home at rest: the bar's foot at 116, the toolbar
    /// with the search field at 808 making the safe area's foot 86.
    func testHomeStandingReadsTheBarAndTheToolbar() {
        let size = CGSize(width: 402, height: 874)
        let room = HomeListRoom(size: size, safeArea: LayoutInsets(top: 116, bottom: 86), control: CGRect(x: 28, y: 808, width: 286, height: 28), standing: true, kept: nil)
        XCTAssertEqual(room.size, size)
        XCTAssertEqual(room.insets.chromeTop, 116)
        XCTAssertEqual(room.insets.contentTop, 128)
        XCTAssertEqual(room.insets.listBottom, 86)
        XCTAssertEqual(room.insets.indicatorInsets, LayoutInsets(top: 116, bottom: 86))
        // The field above the keyboard: the list ends 12 above it.
        let searching = HomeListRoom(size: size, safeArea: LayoutInsets(top: 116, bottom: 86), control: CGRect(x: 28, y: 484, width: 286, height: 28), standing: true, kept: room)
        XCTAssertEqual(searching.insets.listBottom, 402)
        XCTAssertEqual(searching.insets.contentTop, 128)
    }

    /// Mid-pop, UIKit lays home out with the toolbar on its way back: the
    /// home indicator's 34 and no field. Home keeps the room it stood with.
    func testHomeComingOrGoingKeepsTheRoomItStoodWith() {
        let size = CGSize(width: 402, height: 874)
        let standing = HomeListRoom(size: size, safeArea: LayoutInsets(top: 116, bottom: 86), control: CGRect(x: 28, y: 808, width: 286, height: 28), standing: true, kept: nil)
        let moving = HomeListRoom(size: size, safeArea: LayoutInsets(top: 116, bottom: 34), control: nil, standing: false, kept: standing)
        XCTAssertEqual(moving, standing)
        XCTAssertEqual(moving.insets.listBottom, 86)
        // Read alone, the same moment would have ended the list under the field.
        let read = HomeListRoom(size: size, safeArea: LayoutInsets(top: 116, bottom: 34), control: nil, standing: true, kept: standing)
        XCTAssertEqual(read.insets.listBottom, 34)
        // Standing again, it reads what is there.
        let back = HomeListRoom(size: size, safeArea: LayoutInsets(top: 116, bottom: 86), control: CGRect(x: 28, y: 808, width: 286, height: 28), standing: true, kept: moving)
        XCTAssertEqual(back, standing)
    }

    /// Nothing kept yet (home laid out under another screen before it ever
    /// showed), or a size that changed while it was covered: read it.
    func testHomeComingOrGoingReadsWhatItHasNoRoomFor() {
        let portrait = CGSize(width: 402, height: 874)
        let first = HomeListRoom(size: portrait, safeArea: LayoutInsets(top: 116, bottom: 34), control: nil, standing: false, kept: nil)
        XCTAssertEqual(first.insets.contentTop, 128)
        XCTAssertEqual(first.insets.listBottom, 34)
        let landscape = CGSize(width: 874, height: 402)
        let turned = HomeListRoom(size: landscape, safeArea: LayoutInsets(top: 68, left: 62, bottom: 21, right: 62), control: nil, standing: false, kept: first)
        XCTAssertEqual(turned.size, landscape)
        XCTAssertEqual(turned.insets.chromeTop, 68)
        XCTAssertEqual(turned.insets.contentTop, 80)
        XCTAssertEqual(turned.insets.listBottom, 21)
    }

    func testSearchPullHasACancellationThreshold() {
        XCTAssertFalse(HomeSearchPresentationLayout.shouldDismiss(distance: 40, velocity: 0))
        XCTAssertTrue(HomeSearchPresentationLayout.shouldDismiss(distance: 110, velocity: 0))
        XCTAssertTrue(HomeSearchPresentationLayout.shouldDismiss(distance: 30, velocity: 800))
        XCTAssertFalse(HomeSearchPresentationLayout.shouldDismiss(distance: 10, velocity: 800))
    }
}