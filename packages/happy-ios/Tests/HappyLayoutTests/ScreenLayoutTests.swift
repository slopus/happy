import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the V2 screens around the sidebar: the banner,
/// the empty state, search, a todo list and a document.
final class ScreenLayoutTests: XCTestCase {
    func testHomeStacksTheBannerOverTheList() {
        let layout = HomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 90, bannerHeight: 90)
        XCTAssertEqual(layout.banner, rect(0, 120, 390, 90))
        XCTAssertEqual(layout.listInsets, LayoutInsets(top: 210, left: 0, bottom: 90, right: 0))
        XCTAssertEqual(layout.indicatorInsets, LayoutInsets(top: 110, left: 0, bottom: 90, right: 0))
        XCTAssertEqual(layout.empty, rect(0, 120, 390, 634))
        XCTAssertEqual(layout.content, rect(0, 0, 390, 844))
    }

    /// A phone's window is narrower than the limit, so nothing moves;
    /// an iPad's is wider, so the list, the banner and the empty state
    /// are 800 in the middle. `content` is where the list and search's
    /// results go, full height, since both scroll under the header.
    func testHomeHoldsItsContentToTheWidthLimitOnAWideWindow() {
        let phone = HomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 90, bannerHeight: 90, maxWidth: 844)
        XCTAssertEqual(phone.content, rect(0, 0, 390, 844))
        XCTAssertEqual(phone.banner, rect(0, 120, 390, 90))
        XCTAssertEqual(phone.empty, rect(0, 120, 390, 634))

        // 1366 less 800 is 566, half of it 283.
        let pad = HomeLayout(size: CGSize(width: 1366, height: 1024), contentTop: 120, chromeTop: 110, listBottom: 90, bannerHeight: 90, maxWidth: ContentWidthLimit.tablet)
        XCTAssertEqual(pad.content, rect(283, 0, 800, 1024))
        XCTAssertEqual(pad.banner, rect(283, 120, 800, 90))
        XCTAssertEqual(pad.empty, rect(283, 120, 800, 814))
        // The insets are the list's own, so they stay as they were.
        XCTAssertEqual(pad.listInsets, LayoutInsets(top: 210, left: 0, bottom: 90, right: 0))
        XCTAssertEqual(pad.indicatorInsets, LayoutInsets(top: 110, left: 0, bottom: 90, right: 0))
    }

    /// Half a pixel is rounded the same way every time, so a window of
    /// an odd width doesn't blur its rows, and the stories band that
    /// follows `content.minX` lines up with the list under it.
    func testHomeRoundsAnOddWidthsMarginToAWholePoint() {
        let odd = HomeLayout(size: CGSize(width: 1001, height: 800), contentTop: 100, chromeTop: 100, listBottom: 0, bannerHeight: 0, maxWidth: 800)
        // 1001 less 800 is 201, half of it 100.5, rounded to 101.
        XCTAssertEqual(odd.content, rect(101, 0, 800, 800))
        XCTAssertEqual(odd.empty.minX, 101)
        // Stories open under the header and push the banner down; the
        // band itself follows the same left edge.
        let stories = HomeLayout(size: CGSize(width: 1001, height: 800), contentTop: 100, chromeTop: 100, listBottom: 0, bannerHeight: 40, storiesHeight: 60, maxWidth: 800)
        XCTAssertEqual(stories.banner, rect(101, 160, 800, 40))
    }

    /// A window narrower than the limit, or one of no width at all,
    /// is left where it is rather than given a negative frame.
    func testHomeNeverGivesItsContentANegativeWidth() {
        let none = HomeLayout(size: .zero, contentTop: 0, chromeTop: 0, listBottom: 0, bannerHeight: 0, maxWidth: 800)
        XCTAssertEqual(none.content, rect(0, 0, 0, 0))
        let unset = HomeLayout(size: CGSize(width: 390, height: 844), contentTop: 0, chromeTop: 0, listBottom: 0, bannerHeight: 0)
        XCTAssertEqual(unset.content, rect(0, 0, 390, 844))
    }

    func testTheBannerHoldsItsButtonAtTheRight() {
        let off = BannerLayout(width: 390, title: text("Prioritizing is off", lineHeight: 18), detail: text("Turn it on to name and place new work.", lineHeight: 17), button: CGSize(width: 80, height: 30))
        XCTAssertEqual(off.card, rect(12, 0, 366, 82))
        // 366 less 28 of padding and the button with its 12.
        XCTAssertEqual(off.title, rect(14, 14, 246, 18))
        XCTAssertEqual(off.detail, rect(14, 34, 246, 34))
        XCTAssertEqual(off.button, rect(272, 26, 80, 30))
        XCTAssertEqual(off.size, CGSize(width: 390, height: 90))
        // A refusal: the reason alone, across the card.
        let notice = BannerLayout(width: 390, title: text("The computer did not answer.", lineHeight: 18), detail: nil, button: nil)
        XCTAssertEqual(notice.title, rect(14, 14, 338, 18))
        XCTAssertNil(notice.detail)
        XCTAssertNil(notice.button)
        XCTAssertEqual(notice.size.height, 54)
    }

    func testTheEmptyStateCentresItsThree() {
        let layout = EmptyLayout(size: CGSize(width: 390, height: 600), label: text("Connect an agent to see its work.", lineHeight: 20), button: CGSize(width: 180, height: 44))
        XCTAssertEqual(layout.mark, rect(163, 214, 64, 64))
        XCTAssertEqual(layout.label, rect(24, 298, 342, 20))
        XCTAssertEqual(layout.button, rect(105, 342, 180, 44))
        // Too old: no button, the line wraps at 272 on a narrow phone.
        let old = EmptyLayout(size: CGSize(width: 320, height: 500), label: text(String(repeating: "a", count: 40), lineHeight: 20), button: nil)
        XCTAssertEqual(old.label, rect(24, 272, 272, 40))
        XCTAssertNil(old.button)
    }

    func testSearchKeepsTheListClearOfTheKeyboard() {
        let nothing = text("Nothing found", lineHeight: 22)
        // The keyboard up: 336 of it over an 874 screen.
        let up = SearchLayout(size: CGSize(width: 402, height: 874), contentTop: 126, safeBottom: 34, keyboardTop: 538, nothingFound: nothing)
        XCTAssertEqual(up.listBottom, 336)
        // 13 characters at 8 a character: 104 wide, centred.
        XCTAssertEqual(up.nothingFound, rect(149, 158, 104, 22))
        XCTAssertEqual(up.nothingFoundPill, rect(135, 150, 132, 38))
        // Down: the home indicator alone.
        let down = SearchLayout(size: CGSize(width: 402, height: 874), contentTop: 126, safeBottom: 34, keyboardTop: 874, nothingFound: nothing)
        XCTAssertEqual(down.listBottom, 34)
        // A long line wraps inside 24 from each side.
        let long = SearchLayout(size: CGSize(width: 320, height: 600), contentTop: 100, safeBottom: 0, keyboardTop: 600, nothingFound: text(String(repeating: "a", count: 40), lineHeight: 20))
        XCTAssertEqual(long.nothingFound, rect(24, 132, 272, 40))
    }

    func testTodosStackUnderTheirField() {
        let layout = TodoLayout(width: 390, todos: [text("Buy oranges", lineHeight: 20), text(String(repeating: "a", count: 60), lineHeight: 20)], empty: text("Nothing here yet.", lineHeight: 20))
        XCTAssertEqual(layout.field, rect(16, 12, 358, 44))
        XCTAssertEqual(layout.rows.map(\.frame), [rect(0, 64, 390, 44), rect(0, 108, 390, 60)])
        XCTAssertEqual(layout.rows[0].box, rect(16, 11, 22, 22))
        XCTAssertEqual(layout.rows[0].text, rect(48, 12, 326, 20))
        // 326 wide: 40 to a line, so two lines and a taller row.
        XCTAssertEqual(layout.rows[1].text, rect(48, 10, 326, 40))
        XCTAssertNil(layout.empty)
        XCTAssertEqual(layout.contentHeight, 184)
        let none = TodoLayout(width: 390, todos: [], empty: text("Nothing here yet.", lineHeight: 20))
        XCTAssertEqual(none.empty, rect(16, 88, 358, 20))
        XCTAssertEqual(none.contentHeight, 124)
    }

    func testABodyScrollsUnderTheBar() {
        let layout = SurfaceBodyLayout(width: 390, body: block(height: 300))
        XCTAssertEqual(layout.body, rect(0, 8, 390, 300))
        XCTAssertEqual(layout.contentHeight, 324)
        XCTAssertEqual(SurfaceBodyLayout(width: 390, body: block(height: 20), inset: 16).body, rect(16, 8, 358, 20))
    }

    func testChatTitleIsItsTextWideAndAllOfItWhileEdited() {
        let max = ChatTitleLayout.maxWidth(barWidth: 393)
        XCTAssertEqual(max, 265)
        let shown = ChatTitleLayout(textWidth: 41.3, maxWidth: max, editing: false)
        XCTAssertEqual(shown.size, CGSize(width: 42, height: 44))
        XCTAssertEqual(shown.text, rect(0, 0, 42, 44))
        let long = ChatTitleLayout(textWidth: 400, maxWidth: max, editing: false)
        XCTAssertEqual(long.text, rect(0, 0, 265, 44))
        let editing = ChatTitleLayout(textWidth: 41.3, maxWidth: max, editing: true)
        XCTAssertEqual(editing.text, rect(0, 0, 265, 44))
        // Before the bar is measured, the name is its own width.
        let unmeasured = ChatTitleLayout(textWidth: 41.3, maxWidth: ChatTitleLayout.maxWidth(barWidth: 0), editing: false)
        XCTAssertEqual(unmeasured.text, rect(0, 0, 42, 44))
    }

    func testTheDockIsTheNewWorkComposerWithTheKeyboardDown() {
        // iPhone 17 Pro: 402 × 874, 34 under the safe area; a 100-tall card.
        let layout = DockLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34)) { width in
            XCTAssertEqual(width, 386)
            return 100
        }
        XCTAssertEqual(layout.card, CGRect(x: 8, y: 732, width: 386, height: 100))
        XCTAssertEqual(layout.scrim, CGRect(x: 0, y: 782, width: 402, height: 92))
        // From the card's top, and 8 of room over it.
        XCTAssertEqual(layout.listBottom, 150)
        // The very frame the conversation gives its composer with the keyboard down.
        let chat = ChatScreenLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34), keyboardTop: 874) { _ in 100 }
        XCTAssertEqual(layout.card, chat.card)
    }
}
