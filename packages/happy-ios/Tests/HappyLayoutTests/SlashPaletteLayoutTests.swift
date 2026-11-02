import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The agent composer's slash palette: a Happy Agent command's row and the
/// list over the card.
final class SlashPaletteLayoutTests: XCTestCase {
    func testACommandWithItsMarkDescriptionAndKind() {
        let layout = ComposerSuggestionRowLayout(
            width: 361,
            input: .agentCommand(name: CGSize(width: 110, height: 17), description: CGSize(width: 400, height: 16), label: CGSize(width: 30, height: 14.5))
        )
        XCTAssertEqual(layout.size, CGSize(width: 361, height: 48))
        assertFrame(layout.icon, rect(16, 8, 32, 32))
        assertFrame(layout.iconGlyph, rect(23, 15, 18, 18))
        // 16 + 32 + 12 = 60; the kind ends at 345, 8 after what is left.
        assertFrame(layout.name, rect(60, 15.5, 110, 17))
        assertFrame(layout.description, rect(182, 16, 125, 16))
        assertFrame(layout.label, rect(315, 16.75, 30, 14.5))
    }

    func testACommandWithNoDescriptionOrKind() {
        let layout = ComposerSuggestionRowLayout(width: 361, input: .agentCommand(name: CGSize(width: 80, height: 17), description: nil, label: nil))
        assertFrame(layout.icon, rect(16, 8, 32, 32))
        assertFrame(layout.name, rect(60, 15.5, 80, 17))
        XCTAssertNil(layout.description)
        XCTAssertNil(layout.label)
    }

    func testALongNameKeepsTheKindInView() {
        let layout = ComposerSuggestionRowLayout(
            width: 361,
            input: .agentCommand(name: CGSize(width: 300, height: 17), description: CGSize(width: 40, height: 16), label: CGSize(width: 30, height: 14.5))
        )
        assertFrame(layout.name, rect(60, 15.5, 247, 17))
        assertFrame(layout.description, rect(319, 16, 0, 16))
        assertFrame(layout.label, rect(315, 16.75, 30, 14.5))
    }

    func testTheListHangsEightAboveTheCardItsWidth() {
        let card = rect(16, 600, 361, 120)
        // Three rows in a hairline rim.
        assertFrame(SlashPaletteLayout.frame(card: card, rows: 3, border: 0.5, top: 70), rect(16, 447, 361, 145))
    }

    func testManyRowsScrollPast320() {
        assertFrame(SlashPaletteLayout.frame(card: rect(16, 600, 361, 120), rows: 10, border: 0.5, top: 70), rect(16, 272, 361, 320))
    }

    func testTheListNeverReachesAboveTop() {
        // Sideways with the keyboard up: what room there is.
        assertFrame(SlashPaletteLayout.frame(card: rect(60, 200, 600, 60), rows: 5, border: 0.5, top: 100), rect(60, 100, 600, 92))
        assertFrame(SlashPaletteLayout.frame(card: rect(60, 90, 600, 60), rows: 5, border: 0.5, top: 100), rect(60, 82, 600, 0))
    }
}
