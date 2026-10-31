import CoreGraphics
@testable import HappyLayout
import XCTest

/// Settings' cards with a line under them, and a row that holds a block
/// of text (a secret key), frame by frame on a 402-wide phone.
final class SettingsFooterLayoutTests: XCTestCase {
    typealias L = SettingsLayout

    func testAFooterSitsUnderItsCardAndPushesTheNextOneDown() {
        let row = L.RowSpec(hasIcon: true, accessory: .chevron)
        let layout = L(width: 402, nameHeight: 0, subtitleHeight: 0, cards: [[row, row], [row]], footers: [40, nil], searching: true)
        XCTAssertEqual(L.footerWidth(402), 338)
        XCTAssertEqual(layout.cards[0].frame, CGRect(x: 16, y: 8, width: 370, height: 104))
        // 8 under the card, 16 in from its sides.
        XCTAssertEqual(layout.cards[0].footer, CGRect(x: 32, y: 120, width: 338, height: 40))
        // The next card a gap under the footer, not under the card.
        XCTAssertEqual(layout.cards[1].frame, CGRect(x: 16, y: 184, width: 370, height: 52))
        XCTAssertNil(layout.cards[1].footer)
        XCTAssertEqual(layout.contentHeight, 236 + 32)
    }

    func testTheLastCardsFooterEndsThePage() {
        let row = L.RowSpec(hasIcon: false, accessory: .none)
        let layout = L(width: 402, nameHeight: 0, subtitleHeight: 0, cards: [[row]], footers: [60], searching: true)
        XCTAssertEqual(layout.cards[0].footer?.maxY, 8 + 52 + 8 + 60)
        XCTAssertEqual(layout.contentHeight, 128 + 32)
        // A zero height is no footer.
        XCTAssertNil(L(width: 402, nameHeight: 0, subtitleHeight: 0, cards: [[row]], footers: [0], searching: true).cards[0].footer)
    }

    func testATextRowGrowsToItsTextTheCardsWidth() {
        let text = L.RowSpec(hasIcon: false, accessory: .none, textHeight: 66)
        let row = L.RowSpec(hasIcon: true, accessory: .none)
        let layout = L(width: 402, nameHeight: 0, subtitleHeight: 0, cards: [[text, row]], searching: true)
        XCTAssertEqual(L.textWidth(402), 338)
        let card = layout.cards[0]
        // 66 of text, 14 above and below.
        XCTAssertEqual(card.rows[0].box, CGRect(x: 0, y: 0, width: 370, height: 94))
        XCTAssertEqual(card.rows[0].title, CGRect(x: 16, y: 14, width: 338, height: 66))
        XCTAssertNil(card.rows[0].icon)
        XCTAssertEqual(card.rows[0].separator, CGRect(x: 16, y: 94 - 1.0 / 3, width: 354, height: 1.0 / 3))
        // The row under it starts where it ends.
        XCTAssertEqual(card.rows[1].box, CGRect(x: 0, y: 94, width: 370, height: 52))
        XCTAssertEqual(card.frame.height, 146)
        // A short text keeps a row's height.
        let short = L(width: 402, nameHeight: 0, subtitleHeight: 0, cards: [[L.RowSpec(hasIcon: false, accessory: .none, textHeight: 20)]], searching: true)
        XCTAssertEqual(short.cards[0].rows[0].box.height, 52)
        XCTAssertEqual(short.cards[0].rows[0].title.minY, 16)
    }
}
