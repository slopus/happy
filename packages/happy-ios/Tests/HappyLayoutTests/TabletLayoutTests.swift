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
        let window = CGSize(width: 820, height: 1180)
        XCTAssertEqual(ContentWidthLimit.maxWidth(deviceType: .phone, window: window), 1180)
        XCTAssertEqual(ContentWidthLimit.headerMaxWidth(deviceType: .phone, window: window), 1180)
        XCTAssertEqual(ContentWidthLimit.maxWidth(deviceType: .tablet, window: window), 800)
        XCTAssertEqual(ContentWidthLimit.headerMaxWidth(deviceType: .tablet, window: window), 800)
        XCTAssertEqual(ContentWidthLimit.maxWidth(deviceType: .tablet, window: window, isMacCatalyst: true), 1400)
        XCTAssertEqual(ContentWidthLimit.headerMaxWidth(deviceType: .tablet, window: window, isMacCatalyst: true), .greatestFiniteMagnitude)
    }
}

/// SidebarNavigator.tsx `isDesktopLayout` and firstRunOnboarding.test.ts's
/// tablet cases.
final class TabletShellRuleTests: XCTestCase {
    func testTheShellStepsAsideForInstallAndScanning() {
        XCTAssertTrue(TabletShellRule.suppressesShell(isAuthenticated: true, isTablet: true, showsInstallStep: true, isOnboardingRoute: false))
        XCTAssertTrue(TabletShellRule.suppressesShell(isAuthenticated: true, isTablet: true, showsInstallStep: false, isOnboardingRoute: true))
        XCTAssertFalse(TabletShellRule.suppressesShell(isAuthenticated: true, isTablet: true, showsInstallStep: false, isOnboardingRoute: false))
        XCTAssertFalse(TabletShellRule.suppressesShell(isAuthenticated: true, isTablet: false, showsInstallStep: true, isOnboardingRoute: false))
    }

    func testTheShellNeedsAnAccountAndATabletWideWindow() {
        XCTAssertTrue(TabletShellRule.showsShell(isAuthenticated: true, isTablet: true, showsInstallStep: false, isOnboardingRoute: false))
        XCTAssertFalse(TabletShellRule.showsShell(isAuthenticated: false, isTablet: true, showsInstallStep: false, isOnboardingRoute: false))
        XCTAssertFalse(TabletShellRule.showsShell(isAuthenticated: true, isTablet: false, showsInstallStep: false, isOnboardingRoute: false))
        XCTAssertFalse(TabletShellRule.showsShell(isAuthenticated: true, isTablet: true, showsInstallStep: true, isOnboardingRoute: false))
        XCTAssertFalse(TabletShellRule.showsShell(isAuthenticated: true, isTablet: true, showsInstallStep: false, isOnboardingRoute: true))
    }
}

final class TabletShellLayoutTests: XCTestCase {
    /// An iPad Pro 12.9-inch in landscape.
    private let landscape = CGSize(width: 1366, height: 1024)
    private let safeArea = LayoutInsets(top: 24, bottom: 20)

    private func shell(_ size: CGSize, safeArea: LayoutInsets? = nil, shows: Bool = true, zen: Bool = false) -> TabletShellLayout {
        TabletShellLayout(.init(size: size, safeArea: safeArea ?? self.safeArea, showsShell: shows, zenMode: zen, headerHeight: 50))
    }

    func testTheSidebarIsThirtyPercentHeldBetween250And360() {
        XCTAssertEqual(TabletShellLayout.sidebarWidth(windowWidth: 768), 250)
        XCTAssertEqual(TabletShellLayout.sidebarWidth(windowWidth: 834), 250)
        // 1024 * 0.3 = 307.2, floored.
        XCTAssertEqual(TabletShellLayout.sidebarWidth(windowWidth: 1024), 307)
        XCTAssertEqual(TabletShellLayout.sidebarWidth(windowWidth: 1180), 354)
        XCTAssertEqual(TabletShellLayout.sidebarWidth(windowWidth: 1366), 360)
    }

    func testAt768TheSidebarLeaves518ForContent() {
        let layout = shell(CGSize(width: 768, height: 1024))
        assertFrame(layout.sidebar, rect(0, 0, 250, 1024))
        assertFrame(layout.detail, rect(250, 0, 518, 1024))
    }

    func testSidebarStackAndHeader() {
        let layout = shell(landscape)
        assertFrame(layout.sidebar, rect(0, 0, 360, 1024))
        assertFrame(layout.detail, rect(360, 0, 1006, 1024))
        // The status bar and the 50pt header row, across the whole window.
        assertFrame(layout.header, rect(0, 0, 1366, 74))
        // 28pt controls centred in the row: 24 + (50 - 28) / 2.
        assertFrame(layout.zenButton, rect(16, 35, 28, 28))
        assertFrame(layout.zenIcon, rect(21, 40, 18, 18))
        assertFrame(layout.backButton, rect(48, 35, 28, 28))
    }

    func testOnAnIPhoneHeaderTheControlsCentreIn44() {
        let layout = TabletShellLayout(.init(size: CGSize(width: 900, height: 600), safeArea: .zero, showsShell: true, zenMode: false, headerHeight: 44))
        assertFrame(layout.header, rect(0, 0, 900, 44))
        assertFrame(layout.zenButton, rect(16, 8, 28, 28))
    }

    func testZenModeCollapsesTheSidebarAndKeepsTheControls() {
        let layout = shell(landscape, zen: true)
        XCTAssertNil(layout.sidebar)
        assertFrame(layout.detail, rect(0, 0, 1366, 1024))
        assertFrame(layout.zenButton, rect(16, 35, 28, 28))
        assertFrame(layout.backButton, rect(48, 35, 28, 28))
    }

    func testWithoutTheShellTheStackTakesTheWindow() {
        let layout = shell(landscape, shows: false)
        XCTAssertNil(layout.sidebar)
        XCTAssertNil(layout.header)
        XCTAssertNil(layout.zenButton)
        XCTAssertNil(layout.backButton)
        assertFrame(layout.detail, rect(0, 0, 1366, 1024))
    }

    func testHorizontalSafeAreaPadsTheShell() {
        let layout = shell(landscape, safeArea: LayoutInsets(top: 24, left: 10, bottom: 20, right: 20))
        // The drawer still takes 30% of the whole window.
        assertFrame(layout.sidebar, rect(10, 0, 360, 1024))
        assertFrame(layout.detail, rect(370, 0, 976, 1024))
        assertFrame(layout.header, rect(10, 0, 1336, 74))
        assertFrame(layout.zenButton, rect(26, 35, 28, 28))
    }
}

/// SidebarView.tsx and EmptySessionsTablet.tsx.
final class TabletSidebarLayoutTests: XCTestCase {
    /// `line` is one line of the labels as drawn: 18 at the designed
    /// size, taller at a larger text size.
    private func sidebar(archive: Bool, line: CGFloat = 18) -> TabletSidebarLayout {
        TabletSidebarLayout(.init(
            size: CGSize(width: 360, height: 1024),
            safeTop: 24,
            safeBottom: 20,
            headerHeight: 50,
            hairline: 0.5,
            newSessionIcon: CGSize(width: 16, height: 16.5),
            newSessionTitle: text("New session", lineHeight: line),
            archiveIcon: archive ? CGSize(width: 18, height: 18.5) : nil,
            settingsIcon: CGSize(width: 18, height: 18.5),
            settingsTitle: text("Settings", lineHeight: line),
            spinner: CGSize(width: 20, height: 20)
        ))
    }

    func testTheControlsAndSettingsGrowWithTheirText() {
        // A larger text size: a 50pt line. The glyphs and paddings keep
        // their size, as RN's do.
        let layout = sidebar(archive: true, line: 50)
        // 0.5 + 10 + 50 + 10 + 0.5 is past the 40pt archive button, which
        // centres in the row now.
        assertFrame(layout.newSessionButton, rect(16.5, 82.5, 279, 71))
        assertFrame(layout.newSessionIcon, rect(31, 109.75, 16, 16.5))
        assertFrame(layout.newSessionTitle, rect(55, 93, 88, 50))
        assertFrame(layout.archiveButton, rect(303.5, 98, 40, 40))
        // Hairline + 14 + 50 + 14.
        assertFrame(layout.settingsRow, rect(0.5, 945, 359, 78.5))
        assertFrame(layout.settingsIcon, rect(16.5, 975.25, 18, 18.5))
        assertFrame(layout.settingsTitle, rect(44.5, 959.5, 64, 50))
        // The list takes what is left between them.
        assertFrame(layout.content, rect(0.5, 157.5, 359, 787.5))
    }

    func testControlsRowWithTheArchiveButton() {
        let layout = sidebar(archive: true)
        // Under the border, the status bar, the header and 8: 0.5 + 24 +
        // 50 + 8. The 40pt archive button sets the row; the 39pt button
        // (hairlines, 10 + 18 + 10) centres in it.
        assertFrame(layout.newSessionButton, rect(16.5, 83, 279, 39))
        assertFrame(layout.newSessionIcon, rect(31, 94.25, 16, 16.5))
        assertFrame(layout.newSessionTitle, rect(55, 93.5, 88, 18))
        assertFrame(layout.archiveButton, rect(303.5, 82.5, 40, 40))
        assertFrame(layout.archiveIcon, rect(314.5, 93.25, 18, 18.5))
    }

    func testWithoutAnArchiveNewSessionTakesTheRow() {
        let layout = sidebar(archive: false)
        XCTAssertNil(layout.archiveButton)
        XCTAssertNil(layout.archiveIcon)
        assertFrame(layout.newSessionButton, rect(16.5, 82.5, 327, 39))
        // The list starts 4 under the 39pt row.
        assertFrame(layout.content, rect(0.5, 125.5, 359, 851))
    }

    func testListBetweenTheControlsAndSettings() {
        let layout = sidebar(archive: true)
        assertFrame(layout.content, rect(0.5, 126.5, 359, 850))
        XCTAssertEqual(layout.listBottomInset, 148)
        assertFrame(layout.spinner, rect(170, 541.5, 20, 20))
    }

    func testSettingsRowSitsOnTheBottomEdge() {
        let layout = sidebar(archive: true)
        // Hairline + 14 + 18.5 + 14, inside the bottom border.
        assertFrame(layout.settingsRow, rect(0.5, 976.5, 359, 47))
        assertFrame(layout.settingsDivider, rect(0.5, 976.5, 359, 0.5))
        assertFrame(layout.settingsIcon, rect(16.5, 991, 18, 18.5))
        assertFrame(layout.settingsTitle, rect(44.5, 991.25, 64, 18))
    }

    private func empty(width: CGFloat, button: Bool) -> TabletEmptySessionsLayout {
        TabletEmptySessionsLayout(.init(
            size: CGSize(width: width, height: 850),
            icon: CGSize(width: 64, height: 66),
            title: text("No sessions yet", lineHeight: 26),
            description: text("Start a new session on any of your connected machines.", lineHeight: 22),
            button: button ? .init(icon: CGSize(width: 20, height: 21), title: text("Start New Session", lineHeight: 22)) : nil
        ))
    }

    func testEmptySessionsCentresItsColumn() {
        let layout = empty(width: 359, button: true)
        // 66 + 24 + 26 + 8 + 44 + 24 + 46 = 238, centred in 850.
        assertFrame(layout.icon, rect(147.5, 306, 64, 66))
        assertFrame(layout.title, rect(119.5, 396, 120, 26))
        // 263 wide after 48 a side: two lines.
        assertFrame(layout.description, rect(51.5, 430, 256, 44))
        assertFrame(layout.button, rect(73.5, 498, 212, 46))
        assertFrame(layout.buttonIcon, rect(97.5, 510.5, 20, 21))
        assertFrame(layout.buttonTitle, rect(125.5, 510, 136, 22))
    }

    func testANarrowSidebarWrapsTheButtonsLabel() {
        // A 250pt sidebar: 153 for the column leaves 77 for the label, two
        // lines of 9, so the button stays inside the column.
        let layout = empty(width: 249, button: true)
        assertFrame(layout.icon, rect(92.5, 284, 64, 66))
        assertFrame(layout.title, rect(64.5, 374, 120, 26))
        assertFrame(layout.description, rect(48.5, 408, 152, 66))
        assertFrame(layout.button, rect(50.5, 498, 148, 68))
        assertFrame(layout.buttonIcon, rect(74.5, 521.5, 20, 21))
        assertFrame(layout.buttonTitle, rect(102.5, 510, 72, 44))
    }

    func testWithoutAComputerThereIsNoButton() {
        let layout = empty(width: 359, button: false)
        XCTAssertNil(layout.button)
        XCTAssertNil(layout.buttonIcon)
        XCTAssertNil(layout.buttonTitle)
        // 192 tall, centred.
        assertFrame(layout.icon, rect(147.5, 329, 64, 66))
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

    func testALandscapePhoneDropsTheHeader() {
        let phone = TabletBranches(isTablet: false, isLandscape: true, headerHeight: 44)
        XCTAssertTrue(phone.chatHidesHeaderInLandscape)
        XCTAssertTrue(phone.chatShowsLandscapeBackButton)
        XCTAssertFalse(phone.chatContentRunsUnderHeader)
        XCTAssertEqual(phone.chatContentTop(safeTop: 0, tabStrip: 0), 0)
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
