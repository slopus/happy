import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the Stem Cells screens around the sidebar: the banner,
/// the empty state, search, a todo list and a document.
final class StemCellsScreenLayoutTests: XCTestCase {
    func testHomeStacksTheBannerOverTheList() {
        let layout = StemCellsHomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 90, bannerHeight: 90)
        XCTAssertEqual(layout.banner, rect(0, 120, 390, 90))
        XCTAssertEqual(layout.listInsets, LayoutInsets(top: 210, left: 0, bottom: 90, right: 0))
        XCTAssertEqual(layout.indicatorInsets, LayoutInsets(top: 110, left: 0, bottom: 90, right: 0))
        XCTAssertEqual(layout.empty, rect(0, 120, 390, 634))
    }

    func testTheBannerHoldsItsButtonAtTheRight() {
        let off = StemCellsBannerLayout(width: 390, title: text("Prioritizing is off", lineHeight: 18), detail: text("Turn it on to name and place new work.", lineHeight: 17), button: CGSize(width: 80, height: 30))
        XCTAssertEqual(off.card, rect(12, 0, 366, 82))
        // 366 less 28 of padding and the button with its 12.
        XCTAssertEqual(off.title, rect(14, 14, 246, 18))
        XCTAssertEqual(off.detail, rect(14, 34, 246, 34))
        XCTAssertEqual(off.button, rect(272, 26, 80, 30))
        XCTAssertEqual(off.size, CGSize(width: 390, height: 90))
        // A refusal: the reason alone, across the card.
        let notice = StemCellsBannerLayout(width: 390, title: text("The computer did not answer.", lineHeight: 18), detail: nil, button: nil)
        XCTAssertEqual(notice.title, rect(14, 14, 338, 18))
        XCTAssertNil(notice.detail)
        XCTAssertNil(notice.button)
        XCTAssertEqual(notice.size.height, 54)
    }

    func testTheEmptyStateCentresItsThree() {
        let layout = StemCellsEmptyLayout(size: CGSize(width: 390, height: 600), label: text("Pair a computer to see its Stem Cells.", lineHeight: 20), button: CGSize(width: 180, height: 44))
        XCTAssertEqual(layout.mark, rect(163, 214, 64, 64))
        XCTAssertEqual(layout.label, rect(24, 298, 342, 20))
        XCTAssertEqual(layout.button, rect(105, 342, 180, 44))
        // Too old: no button, the line wraps at 272 on a narrow phone.
        let old = StemCellsEmptyLayout(size: CGSize(width: 320, height: 500), label: text(String(repeating: "a", count: 40), lineHeight: 20), button: nil)
        XCTAssertEqual(old.label, rect(24, 272, 272, 40))
        XCTAssertNil(old.button)
    }

    func testSearchSitsUnderTheBar() {
        let layout = StemCellsSearchLayout(width: 390, safeArea: LayoutInsets(top: 103, left: 0, bottom: 34, right: 0), barHeight: 56)
        XCTAssertEqual(layout.bar, rect(4, 103, 382, 56))
        XCTAssertEqual(layout.listInsets, LayoutInsets(top: 159, left: 0, bottom: 34, right: 0))
    }

    func testTodosStackUnderTheirField() {
        let layout = StemCellsTodoLayout(width: 390, todos: [text("Buy oranges", lineHeight: 20), text(String(repeating: "a", count: 60), lineHeight: 20)], empty: text("Nothing here yet.", lineHeight: 20))
        XCTAssertEqual(layout.field, rect(16, 12, 358, 44))
        XCTAssertEqual(layout.rows.map(\.frame), [rect(0, 64, 390, 44), rect(0, 108, 390, 60)])
        XCTAssertEqual(layout.rows[0].box, rect(16, 11, 22, 22))
        XCTAssertEqual(layout.rows[0].text, rect(48, 12, 326, 20))
        // 326 wide: 40 to a line, so two lines and a taller row.
        XCTAssertEqual(layout.rows[1].text, rect(48, 10, 326, 40))
        XCTAssertNil(layout.empty)
        XCTAssertEqual(layout.contentHeight, 184)
        let none = StemCellsTodoLayout(width: 390, todos: [], empty: text("Nothing here yet.", lineHeight: 20))
        XCTAssertEqual(none.empty, rect(16, 88, 358, 20))
        XCTAssertEqual(none.contentHeight, 124)
    }

    func testABodyScrollsUnderTheBar() {
        let layout = StemCellsSurfaceBodyLayout(width: 390, body: block(height: 300))
        XCTAssertEqual(layout.body, rect(0, 8, 390, 300))
        XCTAssertEqual(layout.contentHeight, 324)
        XCTAssertEqual(StemCellsSurfaceBodyLayout(width: 390, body: block(height: 20), inset: 16).body, rect(16, 8, 358, 20))
    }

    func testChatTitleIsItsTextWideAndAllOfItWhileEdited() {
        let max = StemCellChatTitleLayout.maxWidth(barWidth: 393)
        XCTAssertEqual(max, 265)
        let shown = StemCellChatTitleLayout(textWidth: 41.3, maxWidth: max, editing: false)
        XCTAssertEqual(shown.size, CGSize(width: 42, height: 44))
        XCTAssertEqual(shown.text, rect(0, 0, 42, 44))
        let long = StemCellChatTitleLayout(textWidth: 400, maxWidth: max, editing: false)
        XCTAssertEqual(long.text, rect(0, 0, 265, 44))
        let editing = StemCellChatTitleLayout(textWidth: 41.3, maxWidth: max, editing: true)
        XCTAssertEqual(editing.text, rect(0, 0, 265, 44))
        // Before the bar is measured, the name is its own width.
        let unmeasured = StemCellChatTitleLayout(textWidth: 41.3, maxWidth: StemCellChatTitleLayout.maxWidth(barWidth: 0), editing: false)
        XCTAssertEqual(unmeasured.text, rect(0, 0, 42, 44))
    }

    func testTheDockIsTheNewWorkComposerWithTheKeyboardDown() {
        // iPhone 17 Pro: 402 × 874, 34 under the safe area; a 100-tall card.
        let layout = StemCellsDockLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34)) { width in
            XCTAssertEqual(width, 386)
            return 100
        }
        XCTAssertEqual(layout.card, CGRect(x: 8, y: 732, width: 386, height: 100))
        XCTAssertEqual(layout.scrim, CGRect(x: 0, y: 782, width: 402, height: 92))
        // From the card's top, and 8 of room over it.
        XCTAssertEqual(layout.listBottom, 150)
        // The very frame the conversation gives its composer with the keyboard down.
        let chat = StemCellChatScreenLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34), keyboardTop: 874) { _ in 100 }
        XCTAssertEqual(layout.card, chat.card)
    }
}
