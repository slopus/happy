import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// utils/responsive.ts and utils/deviceCalculations.ts (with the iOS cases
/// of deviceCalculations.test.ts), and components/layout.ts.
final class TabletBreakpointTests: XCTestCase {
    func testTheTabletLayoutStartsAtAWindow768Wide() {
        XCTAssertFalse(TabletBreakpoint.isTablet(windowWidth: 767.5))
        XCTAssertTrue(TabletBreakpoint.isTablet(windowWidth: 768))
        // A 13-inch iPad in half of Split View is a phone layout; full
        // screen it is a tablet either way round.
        XCTAssertFalse(TabletBreakpoint.isTablet(windowWidth: 678))
        XCTAssertTrue(TabletBreakpoint.isTablet(windowWidth: 1024))
        XCTAssertTrue(TabletBreakpoint.isTablet(windowWidth: 1366))
        // An iPad mini in portrait is under it.
        XCTAssertFalse(TabletBreakpoint.isTablet(windowWidth: 744))
        // Width alone: a short window stays a tablet.
        XCTAssertTrue(TabletBreakpoint.isTablet(windowWidth: 1180))
    }

    func testLandscapeIsWiderThanTall() {
        XCTAssertTrue(TabletBreakpoint.isLandscape(CGSize(width: 1180, height: 820)))
        XCTAssertFalse(TabletBreakpoint.isLandscape(CGSize(width: 820, height: 1180)))
        XCTAssertFalse(TabletBreakpoint.isLandscape(CGSize(width: 800, height: 800)))
    }

    func testDimensionsAt163PointsPerInch() {
        let phone = DeviceCalculations.dimensions(widthPoints: 390, heightPoints: 844)
        XCTAssertEqual(phone.widthInches, 2.393, accuracy: 0.001)
        XCTAssertEqual(phone.heightInches, 5.178, accuracy: 0.001)
        XCTAssertEqual(phone.diagonalInches, 5.704, accuracy: 0.01)
        let pro11 = DeviceCalculations.dimensions(widthPoints: 834, heightPoints: 1194)
        XCTAssertEqual(pro11.diagonalInches, 8.935, accuracy: 0.01)
        let custom = DeviceCalculations.dimensions(widthPoints: 1000, heightPoints: 2000, pointsPerInch: 96)
        XCTAssertEqual(custom.diagonalInches, 23.292, accuracy: 0.01)
    }

    func testOnlyIPadsOverNineInchesAreTablets() {
        typealias D = DeviceCalculations
        XCTAssertEqual(D.deviceType(diagonalInches: 8.3, isPad: true), .phone)
        XCTAssertEqual(D.deviceType(diagonalInches: 12.9, isPad: true), .tablet)
        // Strictly over 9 on an iPad, from 9 on anything else.
        XCTAssertEqual(D.deviceType(diagonalInches: 9, isPad: true), .phone)
        XCTAssertEqual(D.deviceType(diagonalInches: 9, isPad: false), .tablet)
        XCTAssertEqual(D.deviceType(diagonalInches: 6.7, isPad: false), .phone)
        XCTAssertEqual(D.deviceType(diagonalInches: 8, isPad: false, tabletThresholdInches: 7), .tablet)
    }

    func testScreensByModel() {
        typealias D = DeviceCalculations
        // iPhone 13 Pro Max, iPad mini 6, iPad 10th generation, iPad Pro
        // 11-inch: phones. iPad Pro 12.9-inch and 13-inch: tablets.
        XCTAssertEqual(D.deviceType(screen: CGSize(width: 428, height: 926), isPad: false), .phone)
        XCTAssertEqual(D.dimensions(widthPoints: 744, heightPoints: 1133).diagonalInches, 8.316, accuracy: 0.01)
        XCTAssertEqual(D.deviceType(screen: CGSize(width: 744, height: 1133), isPad: true), .phone)
        XCTAssertEqual(D.deviceType(screen: CGSize(width: 820, height: 1180), isPad: true), .phone)
        XCTAssertEqual(D.deviceType(screen: CGSize(width: 834, height: 1194), isPad: true), .phone)
        XCTAssertEqual(D.deviceType(screen: CGSize(width: 1024, height: 1366), isPad: true), .tablet)
        XCTAssertEqual(D.deviceType(screen: CGSize(width: 1376, height: 1032), isPad: true), .tablet)
    }

    func testHeaderHeightGoesByTheDevice() {
        XCTAssertEqual(DeviceCalculations.headerHeight(isPad: false), 44)
        XCTAssertEqual(DeviceCalculations.headerHeight(isPad: true), 50)
        XCTAssertEqual(DeviceCalculations.headerHeight(isPad: true, isMacCatalyst: true), 56)
    }

    func testContentWidthLimit() {
        // Every iPad, whatever its size or window; no limit on a phone.
        XCTAssertEqual(ContentWidthLimit.maxWidth(isPad: true), 800)
        XCTAssertEqual(ContentWidthLimit.maxWidth(isPad: false), .greatestFiniteMagnitude)
    }
}

/// The tablet branches inside other screens (ChatHeaderView.tsx,
/// SessionView.tsx, PermissionFooter.tsx, WorktreeTabStrip.tsx,
/// navigation/Header.tsx).
final class TabletBranchesTests: XCTestCase {
    func testATabletChatHasAPlainHeaderAndADockedComposer() {
        let tablet = TabletBranches(isTablet: true, isLandscape: false, headerHeight: 50)
        XCTAssertFalse(tablet.chatShowsBackButton)
        XCTAssertFalse(tablet.chatHeaderGlass)
        XCTAssertEqual(tablet.chatHeaderContentHeight, 50)
        XCTAssertFalse(tablet.chatShowsAvatar)
        XCTAssertFalse(tablet.chatGlassBackdrop)
        XCTAssertFalse(tablet.chatHidesHeaderInLandscape)
        XCTAssertFalse(tablet.chatShowsLandscapeBackButton)
        XCTAssertFalse(tablet.chatContentRunsUnderHeader)
        XCTAssertEqual(tablet.chatContentTop(safeTop: 24, tabStrip: 0), 74)
        XCTAssertEqual(tablet.chatContentTop(safeTop: 24, tabStrip: 40), 114)
        XCTAssertFalse(tablet.chatFloatingDock)
        XCTAssertEqual(tablet.chatInputPaddingH, 12)
        XCTAssertEqual(tablet.chatOldestEndSpacer(safeTop: 24, headerAccessory: 40), 106)
        XCTAssertTrue(tablet.chatShowsCliWarning)
        XCTAssertTrue(tablet.permissionButtonsTrailing)
        XCTAssertFalse(tablet.worktreeStripGlass)
        XCTAssertFalse(tablet.headerGlassControls)
        XCTAssertFalse(tablet.plainHeaderShowsBackButton(isOnboardingRoute: false))
        XCTAssertTrue(tablet.plainHeaderShowsBackButton(isOnboardingRoute: true))
    }

    func testATabletOnItsSideKeepsItsHeader() {
        let tablet = TabletBranches(isTablet: true, isLandscape: true, headerHeight: 50)
        XCTAssertFalse(tablet.chatHidesHeaderInLandscape)
        XCTAssertEqual(tablet.chatContentTop(safeTop: 24, tabStrip: 0), 74)
        XCTAssertTrue(tablet.chatShowsCliWarning)
    }

    func testAPortraitPhone() {
        let phone = TabletBranches(isTablet: false, isLandscape: false, headerHeight: 44)
        XCTAssertTrue(phone.chatShowsBackButton)
        XCTAssertTrue(phone.chatHeaderGlass)
        XCTAssertEqual(phone.chatHeaderContentHeight, 52)
        XCTAssertTrue(phone.chatShowsAvatar)
        XCTAssertTrue(phone.chatContentRunsUnderHeader)
        XCTAssertEqual(phone.chatContentTop(safeTop: 59, tabStrip: 40), 0)
        XCTAssertTrue(phone.chatFloatingDock)
        XCTAssertEqual(phone.chatInputPaddingH, 8)
        XCTAssertEqual(phone.chatOldestEndSpacer(safeTop: 59, headerAccessory: 40), 163)
        XCTAssertFalse(phone.permissionButtonsTrailing)
        XCTAssertTrue(phone.worktreeStripGlass)
        XCTAssertTrue(phone.plainHeaderShowsBackButton(isOnboardingRoute: false))
    }

    func testALandscapePhoneKeepsTheHeader() {
        let phone = TabletBranches(isTablet: false, isLandscape: true, headerHeight: 44)
        XCTAssertFalse(phone.chatHidesHeaderInLandscape)
        XCTAssertFalse(phone.chatShowsLandscapeBackButton)
        XCTAssertFalse(phone.chatContentRunsUnderHeader)
        XCTAssertEqual(phone.chatContentTop(safeTop: 0, tabStrip: 0), 52)
        XCTAssertFalse(phone.chatFloatingDock)
        XCTAssertEqual(phone.chatOldestEndSpacer(safeTop: 0, headerAccessory: 0), 12)
        XCTAssertFalse(phone.chatShowsCliWarning)
    }

    func testANarrowIPadWindowIsAPhoneWithAnIPadHeader() {
        let window = TabletBranches(isTablet: false, isLandscape: false, headerHeight: 50)
        XCTAssertEqual(window.chatHeaderContentHeight, 52)
        XCTAssertTrue(window.chatShowsBackButton)
    }

    func testTabletPermissionButtonsHugTheirLabelsAtTheTrailingEdge() {
        let labels = [text("Yes", lineHeight: 18), text(String(repeating: "a", count: 60), lineHeight: 18)]
        let phone = PermissionFooterLayout(width: 400, labels: labels)
        assertFrame(phone.buttons[0], rect(6, 4, 388, 34))
        let tablet = PermissionFooterLayout.tablet(width: 400, labels: labels)
        assertFrame(tablet.buttons[0], rect(348, 4, 46, 34))
        assertFrame(tablet.labels[0], rect(359, 12, 24, 18))
        // Two lines of 45 at 366: 360 wide, 22 of padding and border.
        assertFrame(tablet.buttons[1], rect(12, 45, 382, 52))
        assertFrame(tablet.labels[1], rect(23, 53, 360, 36))
        assertSize(tablet.size, phone.size)
        assertSize(tablet.size, CGSize(width: 400, height: 105))
    }
}
