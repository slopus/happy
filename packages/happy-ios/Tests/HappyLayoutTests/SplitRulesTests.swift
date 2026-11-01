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
        // Onboarding, sign-in and the server confirmation own the window.
        XCTAssertFalse(SplitRule.showsSplit(width: 1376, isRegularWidth: true, showsHome: false))
    }

    func testTheSidebarIsAThirdOfTheWindowBetween340And360() {
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 820), 340, "an 11-inch iPad upright")
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 1180), 354, "on its side")
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 1032), 340, "a 13-inch iPad upright")
        XCTAssertEqual(SplitRule.sidebarWidth(windowWidth: 1376), 360, "on its side")
    }

    func testTheMainPanelSitsBesideTheFloatingSidebar() {
        let beside = MainPanelLayout(size: CGSize(width: 1032, height: 1376), safeArea: LayoutInsets(top: 32, left: 320, bottom: 20, right: 0))
        XCTAssertEqual(beside.panel, CGRect(x: 320, y: 0, width: 712, height: 1376))
        // The sidebar hidden: the whole column.
        let alone = MainPanelLayout(size: CGSize(width: 1032, height: 1376), safeArea: LayoutInsets(top: 32, bottom: 20))
        XCTAssertEqual(alone.panel, CGRect(x: 0, y: 0, width: 1032, height: 1376))
        // Right to left, the sidebar is at the right.
        let rtl = MainPanelLayout(size: CGSize(width: 1180, height: 820), safeArea: LayoutInsets(top: 24, left: 0, bottom: 20, right: 360))
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
