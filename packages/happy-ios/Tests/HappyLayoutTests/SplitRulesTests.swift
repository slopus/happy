import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The iPad's split view (docs/IPAD.md): when the window splits, where the
/// main panel sits in its column, and how the one stack is rewritten.
final class SplitRulesTests: XCTestCase {
    func testTheWindowSplitsFrom768WhenRegularAndShowingAHome() {
        XCTAssertTrue(SplitRule.showsSplit(width: 768, isRegularWidth: true, showsHome: true))
        XCTAssertFalse(SplitRule.showsSplit(width: 767.5, isRegularWidth: true, showsHome: true))
        // A 13-inch iPad's half of the screen in landscape: regular, but
        // the main panel beside a sidebar would be narrower than a phone.
        XCTAssertFalse(SplitRule.showsSplit(width: 683, isRegularWidth: true, showsHome: true))
        // An iPad mini in portrait, regular at 744: a phone.
        XCTAssertFalse(SplitRule.showsSplit(width: 744, isRegularWidth: true, showsHome: true))
        // The 11-inch iPads and the 13-inch, full screen either way round.
        for width: CGFloat in [820, 834, 1032, 1180, 1194, 1376] {
            XCTAssertTrue(SplitRule.showsSplit(width: width, isRegularWidth: true, showsHome: true), "\(width)")
        }
        // Compact is a phone whatever the width.
        XCTAssertFalse(SplitRule.showsSplit(width: 1000, isRegularWidth: false, showsHome: true))
        // So is a compact height: an iPhone Pro Max on its side, regular
        // at 956 but 440 tall, stays the phone it was.
        XCTAssertFalse(SplitRule.showsSplit(width: 956, isRegularWidth: true, isRegularHeight: false, showsHome: true))
        // Onboarding, sign-in and the server confirmation own the window.
        XCTAssertFalse(SplitRule.showsSplit(width: 1376, isRegularWidth: true, showsHome: false))
    }

    /// An iPhone Duo, as the iOS 27.2 Duo simulator measures it: built with
    /// the 27.1 SDK, the window is the whole display, its status bar's
    /// column inside it. The same rule as an iPad's, by the window alone.
    func testAnIPhoneDuoSplitsOpenInLandscapeAndNowhereElse() {
        // Folded: 466 × 678 upright, compact × regular; 678 × 466 on its
        // side, compact both ways.
        XCTAssertFalse(SplitRule.showsSplit(width: 466, isRegularWidth: false, isRegularHeight: true, showsHome: true))
        XCTAssertFalse(SplitRule.showsSplit(width: 678, isRegularWidth: false, isRegularHeight: false, showsHome: true))
        // Open in portrait, 669 × 951: regular both ways, but the least
        // sidebar (340) would leave a 329 main panel, narrower than any
        // iPhone.
        XCTAssertFalse(SplitRule.showsSplit(width: 669, isRegularWidth: true, isRegularHeight: true, showsHome: true))
        // Open in landscape, 951 × 669, regular both ways: the split, the
        // least sidebar.
        XCTAssertTrue(SplitRule.showsSplit(width: 951, isRegularWidth: true, isRegularHeight: true, showsHome: true))
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 951), 340)
        // Beside it the main panel, to the window's edge: the status bar's
        // column at the right (84) is its screens' safe area, where its
        // bar's items go, as on the phone. 611, 527 of it clear of the
        // column: more than an iPhone Pro Max's 440.
        let panel = MainPanelLayout(size: CGSize(width: 951, height: 669), safeArea: LayoutInsets(top: 0, left: 340, bottom: 34, right: 84))
        XCTAssertEqual(panel.panel, CGRect(x: 340, y: 0, width: 611, height: 669))
        // The sidebar hidden: the whole window.
        let alone = MainPanelLayout(size: CGSize(width: 951, height: 669), safeArea: LayoutInsets(top: 0, left: 0, bottom: 34, right: 84))
        XCTAssertEqual(alone.panel, CGRect(x: 0, y: 0, width: 951, height: 669))
        // Right to left, the sidebar and the column swap sides.
        let rtl = MainPanelLayout(size: CGSize(width: 951, height: 669), safeArea: LayoutInsets(top: 0, left: 84, bottom: 34, right: 340), sidebarOnLeft: false)
        XCTAssertEqual(rtl.panel, CGRect(x: 0, y: 0, width: 611, height: 669))
    }

    func testTheSidebarIsAThirdOfTheWindowBetween340And360() {
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 820), 340, "an 11-inch iPad upright")
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 1180), 354, "on its side")
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 1032), 340, "a 13-inch iPad upright")
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 1376), 360, "on its side")
    }

    /// An iPhone Duo open in landscape and folded partway, as the iOS 27.2
    /// Duo simulator reports it: one active division region, 40 wide round
    /// the crease at 475.5 (20 either side for touch).
    func testOnADisplayFoldedPartwayTheSidebarMeetsTheCrease() {
        let duo = CGSize(width: 951, height: 669)
        let crease = CGRect(x: 455.5, y: 0, width: 40, height: 669)
        // The sidebar's edge on the crease, on the display's pixels.
        XCTAssertEqual(SplitRule.sidebarWidth(window: duo, divisions: [crease], scale: 3), CGFloat(1427) / 3)
        // Flat or closed there is no active region: the usual 340.
        XCTAssertEqual(SplitRule.sidebarWidth(window: duo, divisions: [], scale: 3), 340)
        // Right to left, the sidebar is the right half.
        XCTAssertEqual(SplitRule.sidebarWidth(window: duo, divisions: [crease], sidebarOnLeft: false, scale: 3), 951 - CGFloat(1427) / 3)
        // Beside it the main panel is the other half, to the window's edge.
        let half = SplitRule.sidebarWidth(window: duo, divisions: [crease], scale: 3)
        let panel = MainPanelLayout(size: duo, safeArea: LayoutInsets(top: 0, left: half, bottom: 34, right: 84))
        XCTAssertEqual(panel.panel, CGRect(x: half, y: 0, width: 951 - half, height: 669))
        // A crease across the window, not down it, isn't one to meet.
        let across = CGRect(x: 0, y: 314.5, width: 951, height: 40)
        XCTAssertEqual(SplitRule.sidebarWidth(window: duo, divisions: [across], scale: 3), 340)
        // Nor one that would leave either half under the least sidebar.
        let nearTheEdge = CGRect(x: 280, y: 0, width: 40, height: 669)
        XCTAssertEqual(SplitRule.sidebarWidth(window: duo, divisions: [nearTheEdge], scale: 3), 340)
        // An iPad has no division regions: its widths are as they were.
        for width: CGFloat in [820, 1032, 1180, 1376] {
            XCTAssertEqual(SplitRule.sidebarWidth(window: CGSize(width: width, height: 1000), divisions: [], scale: 2),
                           SplitRule.sidebarWidth(windowWidth: width), "\(width)")
        }
    }

    func testTheMainPanelSitsBesideTheFloatingSidebar() {
        let beside = MainPanelLayout(size: CGSize(width: 1032, height: 1376), safeArea: LayoutInsets(top: 32, left: 320, bottom: 20, right: 0))
        XCTAssertEqual(beside.panel, CGRect(x: 320, y: 0, width: 712, height: 1376))
        // The sidebar hidden: the whole column.
        let alone = MainPanelLayout(size: CGSize(width: 1032, height: 1376), safeArea: LayoutInsets(top: 32, bottom: 20))
        XCTAssertEqual(alone.panel, CGRect(x: 0, y: 0, width: 1032, height: 1376))
        // Right to left, the sidebar is at the right.
        let rtl = MainPanelLayout(size: CGSize(width: 1180, height: 820), safeArea: LayoutInsets(top: 24, left: 0, bottom: 20, right: 360), sidebarOnLeft: false)
        XCTAssertEqual(rtl.panel, CGRect(x: 0, y: 0, width: 820, height: 820))
        // Never negative.
        XCTAssertEqual(MainPanelLayout(size: CGSize(width: 100, height: 50), safeArea: LayoutInsets(left: 320)).panel, CGRect(x: 320, y: 0, width: 0, height: 50))
    }

    private final class Screen: CustomStringConvertible {
        let name: String
        init(_ name: String) { self.name = name }
        var description: String { name }
    }

    func testCollapsingPutsHomeFirstThenWhatTheMainPanelShowed() {
        let home = Screen("home"), chat = Screen("chat"), profile = Screen("profile"), placeholder = Screen("placeholder")
        XCTAssertTrue(SplitStack.collapsed(sidebar: [home], main: [placeholder], placeholder: placeholder).elementsEqual([home], by: ===))
        XCTAssertTrue(SplitStack.collapsed(sidebar: [home], main: [chat], placeholder: placeholder).elementsEqual([home, chat], by: ===))
        XCTAssertTrue(SplitStack.collapsed(sidebar: [home], main: [chat, profile], placeholder: placeholder).elementsEqual([home, chat, profile], by: ===))
        // Nothing in the sidebar (not a home yet): the main panel alone.
        XCTAssertTrue(SplitStack.collapsed(sidebar: [], main: [chat], placeholder: placeholder).elementsEqual([chat], by: ===))
    }

    func testExpandingPutsTheRootInTheSidebarAndTheRestInTheMainPanel() {
        let home = Screen("home"), chat = Screen("chat"), profile = Screen("profile"), placeholder = Screen("placeholder")
        let alone = SplitStack.expanded([home], placeholder: placeholder)
        XCTAssertTrue(alone.sidebar.elementsEqual([home], by: ===))
        XCTAssertTrue(alone.main.elementsEqual([placeholder], by: ===), "nothing open: the placeholder")
        let deep = SplitStack.expanded([home, chat, profile], placeholder: placeholder)
        XCTAssertTrue(deep.sidebar.elementsEqual([home], by: ===))
        XCTAssertTrue(deep.main.elementsEqual([chat, profile], by: ===))
        // Round trip: nothing made again, nothing lost.
        let back = SplitStack.collapsed(sidebar: deep.sidebar, main: deep.main, placeholder: placeholder)
        XCTAssertTrue(back.elementsEqual([home, chat, profile], by: ===))
        let empty = SplitStack.expanded([Screen](), placeholder: placeholder)
        XCTAssertTrue(empty.sidebar.isEmpty)
        XCTAssertTrue(empty.main.elementsEqual([placeholder], by: ===))
    }

    func testOpeningTheSameThingAgainGoesBackToIt() {
        XCTAssertEqual(SplitStack.opening("agent:a", current: "agent:a"), .backToRoot)
        XCTAssertEqual(SplitStack.opening("agent:a", current: "agent:b"), .replace)
        XCTAssertEqual(SplitStack.opening("agent:a", current: nil), .replace)
        XCTAssertEqual(SplitStack.opening(String?.none, current: nil), .replace, "an unnamed screen is never the same")
    }
}
