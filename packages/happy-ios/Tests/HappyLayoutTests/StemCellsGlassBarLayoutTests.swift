import CoreGraphics
@testable import HappyLayout
import XCTest

/// The glass bar of settings, the link sheet and the pages pushed from
/// them, on a 390-wide phone: its circle is a conversation's back, its
/// actions are home's capsule, its title is a conversation's.
final class StemCellsGlassBarLayoutTests: XCTestCase {
    /// A conversation's capsule runs to the edge; the bar's hugs its title.
    func testBackIsTheConversationsBackAndTheTitleCentredInACapsule() {
        let bar = StemCellsGlassBarLayout(width: 390, safeTop: 47, hairline: 1, hasLeading: true, actions: 0, titleWidth: 99.4)
        let chat = StemCellChatHeaderLayout(width: 390, safeTop: 47, titleWidth: 99.4, statusWidth: nil)
        XCTAssertEqual(bar.leading, CGRect(x: 16, y: 51, width: 44, height: 44))
        XCTAssertEqual(bar.leading, chat.back)
        XCTAssertEqual(bar.pill, CGRect(x: 129, y: 51, width: 132, height: 44))
        XCTAssertEqual(bar.pill?.minY, chat.pill.minY)
        XCTAssertEqual(bar.title, CGRect(x: 145, y: 62, width: 100, height: 22))
        XCTAssertEqual(bar.title?.minY, chat.title.minY)
        XCTAssertEqual(bar.backdrop, CGRect(x: 0, y: 0, width: 390, height: 107))
        XCTAssertEqual(bar.backdrop, chat.backdrop)
        XCTAssertEqual(bar.contentTop, 99)
        XCTAssertEqual(bar.contentTop, chat.listTop)
        XCTAssertNil(bar.actions)
        XCTAssertNil(bar.searchPill)
    }

    func testTwoActionsShareHomesCapsuleSplitByAHairline() {
        let bar = StemCellsGlassBarLayout(width: 390, safeTop: 47, hairline: 1, hasLeading: true, actions: 2, titleWidth: nil)
        XCTAssertEqual(bar.actions, CGRect(x: 283, y: 50, width: 91, height: 46))
        XCTAssertEqual(bar.buttons, [CGRect(x: 284, y: 51, width: 44, height: 44), CGRect(x: 329, y: 51, width: 44, height: 44)])
        XCTAssertEqual(bar.dividers, [CGRect(x: 328, y: 62, width: 1, height: 22)])
        XCTAssertNil(bar.pill)
        XCTAssertNil(bar.title)
        // Home's own capsule, at a device's real hairline.
        let third: CGFloat = 1.0 / 3
        let glass = StemCellsGlassBarLayout(width: 390, safeTop: 47, hairline: third, hasLeading: true, actions: 2, titleWidth: nil)
        let home = HomeHeaderLayout(.init(width: 390, safeTop: 47, hairline: third, title: .fixed(CGSize(width: 80, height: 20)), status: nil))
        XCTAssertEqual(glass.actions, home.actions)
        XCTAssertEqual(glass.buttons, [home.filterButton, home.settingsButton])
        XCTAssertEqual(glass.dividers, [home.actionDivider])
        XCTAssertEqual(glass.leading, home.logoControl)
    }

    func testBesideActionsTheTitleKeepsAsClearOfBothSidesAndStaysCentred() {
        let short = StemCellsGlassBarLayout(width: 390, safeTop: 47, hairline: 1, hasLeading: true, actions: 2, titleWidth: 100)
        XCTAssertEqual(short.titleMaxWidth, 128)
        XCTAssertEqual(short.pill, CGRect(x: 129, y: 51, width: 132, height: 44))
        let long = StemCellsGlassBarLayout(width: 390, safeTop: 47, hairline: 1, hasLeading: true, actions: 2, titleWidth: 300)
        XCTAssertEqual(long.pill, CGRect(x: 115, y: 51, width: 160, height: 44))
        XCTAssertEqual(long.title, CGRect(x: 131, y: 62, width: 128, height: 22))
        // One action: the same 8 to its left as to the circle's right.
        let one = StemCellsGlassBarLayout(width: 390, safeTop: 47, hairline: 1, hasLeading: true, actions: 1, titleWidth: 300)
        XCTAssertEqual(one.actions, CGRect(x: 328, y: 50, width: 46, height: 46))
        XCTAssertEqual(one.buttons, [CGRect(x: 329, y: 51, width: 44, height: 44)])
        XCTAssertEqual(one.dividers, [])
        XCTAssertEqual(one.pill, CGRect(x: 70, y: 51, width: 250, height: 44))
    }

    func testWithNothingAtTheLeftTheTitleIsStillCentred() {
        let bar = StemCellsGlassBarLayout(width: 390, safeTop: 0, hairline: 1, hasLeading: false, actions: 0, titleWidth: 100)
        XCTAssertNil(bar.leading)
        XCTAssertEqual(bar.pill, CGRect(x: 129, y: 4, width: 132, height: 44))
        XCTAssertEqual(bar.contentTop, 52)
    }

    func testSearchingAFieldCapsuleTakesTheRowBesideACircleThatEndsIt() {
        let bar = StemCellsGlassBarLayout(width: 390, safeTop: 47, hairline: 1, hasLeading: true, actions: 2, titleWidth: 100, searching: true)
        XCTAssertNil(bar.leading)
        XCTAssertNil(bar.actions)
        XCTAssertNil(bar.pill)
        XCTAssertEqual(bar.cancel, CGRect(x: 330, y: 51, width: 44, height: 44))
        XCTAssertEqual(bar.searchPill, CGRect(x: 16, y: 51, width: 306, height: 44))
        XCTAssertEqual(bar.field, CGRect(x: 28, y: 51, width: 282, height: 44))
        XCTAssertEqual(bar.contentTop, 99)
    }
}
