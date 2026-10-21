import Foundation
import HappyLayout
import XCTest
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The composer at the person's text size, as React Native scales
/// AgentInput: the text and its line grow, the fixed rows, minimums and
/// the 120 cap do not.
final class ComposerTextSizeLayoutTests: XCTestCase {
    private let xxxl = TextScale(.extraExtraExtraLarge)
    private let largest = TextScale(.accessibilityExtraExtraExtraLarge)

    func testTheComposersStylesScaleByOneFactor() {
        let input = TextStyles.composerInput.scaled(largest)
        XCTAssertEqual(input.size, 16 * largest.multiplier, accuracy: 0.0001)
        XCTAssertEqual(input.lineHeight ?? 0, 22 * largest.multiplier, accuracy: 0.0001)
        XCTAssertEqual(TextStyles.composerChip.scaled(largest).size, 14 * largest.multiplier, accuracy: 0.0001)
        XCTAssertEqual(TextStyles.composerStatus.scaled(largest).size, 11 * largest.multiplier, accuracy: 0.0001)
        XCTAssertEqual(TextStyles.suggestionLabel.scaled(xxxl).size, 12 * xxxl.multiplier, accuracy: 0.0001)
        // No cap on any of them.
        XCTAssertEqual(TextStyles.composerInput.scaled(TextScale.standard), TextStyles.composerInput)
    }

    func testTheCardsEmptyLineGrowsWithTheText() {
        let line = 22 * xxxl.multiplier
        let card = AgentInputCardLayout(.init(width: 377, textContentHeight: 0, hasText: false, lineHeight: line))
        // One line and the text view's 4 + 4, then the container's 4 + 4:
        // past the 44 minimum.
        XCTAssertEqual(card.text.height, line + 8, accuracy: 0.0001)
        XCTAssertEqual(card.inputContainer.height, line + 16, accuracy: 0.0001)
        XCTAssertEqual(card.size.height, 8 + line + 16 + 42 + 8, accuracy: 0.0001)
        // The action row is fixed.
        XCTAssertEqual(card.actionRow.height, 42)

        // At the designed size nothing moves.
        let designed = AgentInputCardLayout(.init(width: 377, textContentHeight: 0, hasText: false))
        XCTAssertEqual(designed, AgentInputCardLayout(.init(width: 377, textContentHeight: 0, hasText: false, lineHeight: 22)))
        XCTAssertEqual(designed.inputContainer.height, 44)
    }

    func testTheCapStaysAt120() {
        let line = 22 * largest.multiplier
        // One line fits; two are past the cap and scroll.
        let one = AgentInputCardLayout(.init(width: 377, textContentHeight: line + 8, hasText: true, lineHeight: line))
        XCTAssertEqual(one.text.height, line + 8, accuracy: 0.0001)
        XCTAssertFalse(one.textScrolls)
        let two = AgentInputCardLayout(.init(width: 377, textContentHeight: 2 * line + 8, hasText: true, lineHeight: line))
        XCTAssertEqual(two.text.height, 120)
        XCTAssertTrue(two.textScrolls)
    }

    func testChipsWidenButKeepTheirRow() throws {
        // "Opus 5.5" at 14pt, then at the largest size.
        func card(model: CGSize, separator: CGSize) -> AgentInputCardLayout {
            AgentInputCardLayout(.init(
                width: 377,
                textContentHeight: 30,
                hasText: true,
                model: .init(labelSize: model),
                effort: .init(labelSize: CGSize(width: 20, height: 18)),
                separator: separator
            ))
        }
        let designed = card(model: CGSize(width: 56, height: 18), separator: CGSize(width: 4, height: 18))
        let large = card(model: CGSize(width: 150, height: 64), separator: CGSize(width: 14, height: 64))
        let designedModel = try XCTUnwrap(designed.middleContent.model)
        let model = try XCTUnwrap(large.middleContent.model)
        // As wide as its label, 40 tall in the fixed 42 row.
        XCTAssertEqual(model.frame.width - designedModel.frame.width, 94)
        XCTAssertEqual(model.frame.minY, 1)
        XCTAssertEqual(model.frame.height, 40)
        XCTAssertEqual(large.middle.height, 42)
        XCTAssertEqual(large.actionRow.height, 42)
        // The label is centred on the chip and spills past it, cut by the
        // middle box as RN's `overflow: 'hidden'` does.
        XCTAssertEqual(model.label.minY, -12)
        XCTAssertEqual(model.label.size, CGSize(width: 150, height: 64))
        XCTAssertEqual(large.middleContent.separator?.minY, -11)
        XCTAssertEqual(large.size.height, designed.size.height)
    }

    func testTheFlatPanelsLineGrowsToo() {
        let line = 22 * largest.multiplier
        let panel = AgentInputDesktopLayout(.init(width: 800, textContentHeight: 0, hasText: false, lineHeight: line, showsSettings: true))
        // One line and the text's 8 + 8, in the container's 4 + 4.
        XCTAssertEqual(panel.text.height, line + 16, accuracy: 0.0001)
        XCTAssertEqual(panel.inputContainer.height, line + 24, accuracy: 0.0001)
        // The 40-point row and the 32-point send don't grow.
        XCTAssertEqual(panel.actionRow.height, 40)
        XCTAssertEqual(panel.send.size, CGSize(width: 32, height: 32))
        XCTAssertEqual(panel.size.height, 2 + line + 24 + 40 + 8, accuracy: 0.0001)
    }

    func testTallStatusAndUsageTextOutgrowTheirRows() {
        // 11pt at the largest size, about 39 by 50 as measured.
        let status = CGSize(width: 300, height: 50)
        let layout = AgentInputLayout(.init(
            width: 393,
            statusText: status,
            card: .init(width: 0, textContentHeight: 30, hasText: true),
            usageWeek: CGSize(width: 120, height: 50),
            usageContext: CGSize(width: 150, height: 50)
        ))
        // The 20 and 18 minimums are outgrown; the 6pt dot and 14pt gauge
        // are centred on the text.
        assertFrame(layout.status?.frame, rect(8, 8, 377, 54))
        assertFrame(layout.status?.text, rect(34, 8, 300, 50))
        assertFrame(layout.status?.dot, rect(24, 30.5, 6, 6))
        assertFrame(layout.card, rect(8, 62, 377, 102))
        assertFrame(layout.usage?.frame, rect(8, 164, 377, 56))
        assertFrame(layout.usage?.contextText, rect(198, 170, 150, 50))
        assertFrame(layout.usage?.gauge, rect(353, 188, 14, 14))
        assertFrame(layout.usage?.week, rect(68, 170, 120, 50))
    }

    func testSuggestionRowsKeepTheirPitch() {
        // RN's `itemHeight` is fixed: the text grows past the row's 12 + 12.
        let row = ComposerSuggestionRowLayout(
            width: 361,
            input: .command(name: CGSize(width: 120, height: 60), description: CGSize(width: 400, height: 56))
        )
        XCTAssertEqual(row.size.height, 48)
        assertFrame(row.name, rect(16, -6, 120, 60))
        assertFrame(row.description, rect(148, -4, 197, 56))
        XCTAssertEqual(ComposerSuggestionListLayout.rows(count: 3, width: 361, border: 0).last?.minY, 96)
    }
}
