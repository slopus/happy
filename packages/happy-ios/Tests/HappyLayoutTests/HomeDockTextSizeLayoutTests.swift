import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Home's dock and the new-session screen at the person's text size: the
/// text grows by RN's multiplier, each line up to the screen's pixel, and
/// the fixed sizes (the 56 capsule, the 42 rows, the 44 field, the 120 cap,
/// the 36 harness capsule, the 40 action row) stay.
final class HomeDockTextSizeLayoutTests: XCTestCase {
    /// A line of `size` with no line height (Plex's 1.3 em) or a fixed
    /// `lineHeight`, scaled by `category`, up to a 3x pixel.
    private func line(_ category: TextSizeCategory, size: CGFloat? = nil, lineHeight: CGFloat? = nil, scale: CGFloat = 3) -> CGFloat {
        let m = TextScale(category).multiplier
        let value = lineHeight.map { $0 * m } ?? (size ?? 0) * 1.3 * m
        return (value * scale).rounded(.up) / scale
    }

    // MARK: The resting capsule

    func testTheCapsuleKeepsItsHeightAndCentresItsTextAtEverySize() {
        for category in TextSizeCategory.allCases {
            let entryLine = line(category, size: 17)
            let layout = HomeDockLayout(.init(size: phone, safeBottom: 34, hairline: 0.5, entry: text("Plan, ask, build…", lineHeight: entryLine, maxLines: 1)))
            assertFrame(layout.composer, rect(16, 762, 361, 56))
            assertFrame(layout.send, rect(327.5, 769, 42, 42))
            XCTAssertEqual(layout.entryText.height, entryLine, "\(category)")
            XCTAssertEqual(layout.entryText.midY, layout.composer.midY, accuracy: 0.0001, "\(category)")
        }
        // At the largest size the line, 79, is taller than the capsule,
        // which cuts it (`overflow: 'hidden'`).
        let largest = line(.accessibilityExtraExtraExtraLarge, size: 17)
        XCTAssertEqual(largest, 79)
        let layout = HomeDockLayout(.init(size: phone, safeBottom: 34, hairline: 0.5, entry: text("Plan, ask, build…", lineHeight: largest, maxLines: 1)))
        assertFrame(layout.entryText, rect(44.5, 750.5, 136, 79))
    }

    // MARK: The open composer's pickers

    private func focus(triggerLine: CGFloat, valueLine: CGFloat) -> HomeDockFocusLayout {
        HomeDockFocusLayout(.init(
            size: phone,
            safeBottom: 34,
            composerHeight: 102,
            rows: ["MacBook Pro", "~/happy", "No worktree", "Claude Code"].map { text($0, lineHeight: valueLine, maxLines: 1) },
            triggerLine: triggerLine
        ))
    }

    func testTheRowsKeepTheir42UntilTheTriggersLinePassesIt() {
        XCTAssertEqual(HomeDockFocusLayout.Metrics.triggerLine, 22.1)
        for category in TextSizeCategory.allCases {
            let trigger = line(category, size: 17)
            let layout = focus(triggerLine: trigger, valueLine: 22)
            let expected = max(42, trigger)
            for (index, row) in layout.rows.enumerated() {
                XCTAssertEqual(row.frame.height, expected, "\(category) row \(index)")
                XCTAssertEqual(row.icon.size, CGSize(width: 24, height: 24), "\(category)")
                XCTAssertEqual(row.icon.midY, row.frame.midY, accuracy: 0.0001)
            }
            // 1 apart, 22 clear of the composer at 708.
            XCTAssertEqual(layout.rows[3].frame.maxY, 708 - 22, accuracy: 0.0001, "\(category)")
            XCTAssertEqual(layout.rows[1].frame.minY - layout.rows[0].frame.maxY, 1, accuracy: 0.0001)
        }
    }

    func testTheLargestSizeGrowsTheRowsToTheTriggersLine() {
        // 17 × 3.571 × 1.3 = 78.92, 79 at a 3x pixel.
        let layout = focus(triggerLine: 79, valueLine: 22)
        assertFrame(layout.rows[0].frame, rect(24, 367, 345, 79))
        assertFrame(layout.rows[3].frame, rect(24, 607, 345, 79))
        assertFrame(layout.rows[0].icon, rect(30, 394.5, 24, 24))
        assertFrame(layout.rows[0].trigger, rect(66, 367, 297, 79))
        // The menu's own label, whatever its height, is centred.
        assertFrame(layout.rows[0].value, rect(66, 395.5, 88, 22))
    }

    /// The row's height is the trigger's line, never the menu's value:
    /// the system's body font, measured on the main thread, places the
    /// value and changes no height.
    func testTheValuesHeightNeverMovesARow() {
        let short = focus(triggerLine: 22.1, valueLine: 20)
        let tall = focus(triggerLine: 22.1, valueLine: 60)
        XCTAssertEqual(short.rows.map(\.frame), tall.rows.map(\.frame))
    }

    func testTheLedesLane() {
        XCTAssertEqual(HomeDockHeaderLayout.ledeWidth(width: 393), 340)
        XCTAssertEqual(HomeDockHeaderLayout.ledeWidth(width: 320), 272)
        XCTAssertEqual(HomeDockHeaderLayout.ledeWidth(width: 1024, maxWidth: 300), 300)
        // The lede is laid out in exactly that lane.
        for width in [CGFloat(320), 393, 430] {
            var asked: [CGFloat] = []
            _ = HomeDockHeaderLayout(.init(width: width, safeTop: 59, lede: Measurable { lane in
                asked.append(lane)
                return CGSize(width: lane, height: 54)
            }))
            XCTAssertEqual(asked, [HomeDockHeaderLayout.ledeWidth(width: width)])
        }
    }

    // MARK: The new-session composer

    private let h: CGFloat = 1.0 / 3

    private func composer(textHeight: CGFloat, lineHeight: CGFloat) -> NewSessionComposerLayout {
        NewSessionComposerLayout(.init(
            width: 369,
            hairline: h,
            textHeight: textHeight,
            agentLabel: text("codex", lineHeight: 18, maxLines: 1),
            showsSettings: true,
            lineHeight: lineHeight
        ))
    }

    func testThePromptsLineFollowsTheTextSize() {
        for category in TextSizeCategory.allCases {
            let promptLine = line(category, lineHeight: 22)
            let layout = composer(textHeight: promptLine, lineHeight: promptLine)
            XCTAssertEqual(layout.input.height, promptLine, "\(category)")
            // Centred in the field, which keeps its 44 until the line
            // passes it, to the pixel above: it starts on a pixel, so its
            // snapped frame keeps the line's height.
            let field = max(44, promptLine)
            XCTAssertEqual(layout.input.midY, 6 + h + field / 2, accuracy: h / 2 + 0.0001, "\(category)")
            XCTAssertLessThanOrEqual(layout.input.midY, 6 + h + field / 2 + 0.0001, "\(category)")
            XCTAssertEqual(layout.input.minY / h, (layout.input.minY / h).rounded(), accuracy: 0.001, "\(category)")
            XCTAssertEqual(layout.actionRow.height, 40)
            XCTAssertEqual(layout.agent.height, 36)
            XCTAssertEqual(layout.send.size, CGSize(width: 38, height: 38))
            XCTAssertEqual(layout.size.height, max(98, 6 + h + field + 40 + 6 + h), accuracy: 0.0001, "\(category)")
            XCTAssertFalse(layout.textScrolls)
        }
    }

    func testTheSmallestSizeIsShorterThanTheDesigned22() {
        // 22 × 0.823 = 18.11, 18⅓ at a 3x pixel.
        let promptLine = line(.extraSmall, lineHeight: 22)
        XCTAssertEqual(promptLine, 55.0 / 3)
        let layout = composer(textHeight: promptLine, lineHeight: promptLine)
        // Centred, 12⅚ above, is half a pixel; it starts on the pixel
        // above, 12⅔, so its snapped frame stays 18⅓ tall.
        assertFrame(layout.input, rect(18 + h, 6 + h + 38.0 / 3, 338 + h, 55.0 / 3))
        assertSize(layout.size, CGSize(width: 369, height: 98))
        // The designed default stays the 22 line.
        XCTAssertEqual(composer(textHeight: 0, lineHeight: NewSessionComposerLayout.Metrics.lineHeight).input.height, 22)
    }

    func testTheLargestSizeGrowsTheFieldAndScrollsPastTheCap() {
        // 22 × 3.571 = 78.56, 78⅔ at a 3x pixel.
        let promptLine = line(.accessibilityExtraExtraExtraLarge, lineHeight: 22)
        XCTAssertEqual(promptLine, 236.0 / 3)
        let one = composer(textHeight: promptLine, lineHeight: promptLine)
        assertFrame(one.input, rect(18 + h, 6 + h, 338 + h, 236.0 / 3))
        assertSize(one.size, CGSize(width: 369, height: 6 + h + 236.0 / 3 + 40 + 6 + h))
        // Two lines pass the 120 cap, which stays: the text scrolls.
        let two = composer(textHeight: 2 * promptLine, lineHeight: promptLine)
        XCTAssertEqual(two.input.height, 120)
        XCTAssertTrue(two.textScrolls)
    }
}
