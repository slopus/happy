import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The duplicate sheet with its text at each size, as its labels measure it
/// scaled by RN's multiplier: the header and buttons grow with their
/// lines, and the list shrinks first, so the card stays inside 85% of the
/// window at every size.
final class DuplicateSheetTextSizeLayoutTests: XCTestCase {
    private typealias M = DuplicateSheetLayout.Metrics
    private let window = CGSize(width: 393, height: 852)
    private let hairline: CGFloat = 1.0 / 3

    /// Up to the next of the screen's pixels, as a label measures itself.
    private func ceiled(_ value: CGFloat) -> CGFloat {
        (value * 3).rounded(.up) / 3
    }

    /// The system font's line at 17, 13, 12 and 15 as designed (UIKit's
    /// `lineHeight`, rounded up to pixels), × the multiplier; the preview's
    /// fixed 19 line × the multiplier, three lines of it.
    private func layout(_ scale: TextScale, points: Int, window: CGSize? = nil) -> (DuplicateSheetLayout, title: CGFloat, preview: CGFloat, meta: CGFloat, button: CGFloat) {
        let m = scale.multiplier
        let title = ceiled(20.29 * m)
        let subtitle = ceiled(15.52 * m)
        let preview = ceiled(3 * 19 * m)
        let meta = ceiled(14.32 * m)
        let button = ceiled(17.9 * m)
        let rows = (0..<points).map { _ in
            (text: Measurable.fixed(width: 200, height: preview), meta: Measurable.fixed(width: 60, height: meta))
        }
        let layout = DuplicateSheetLayout(.init(
            window: window ?? self.window,
            title: .fixed(width: 150, height: title),
            subtitle: .fixed(width: 250, height: subtitle),
            body: .rows(rows),
            buttonTextHeight: button,
            hairline: hairline
        ))
        return (layout, title, preview, meta, button)
    }

    func testTheHeaderAndButtonsGrowWithTheirLinesAtEverySize() {
        for category in TextSizeCategory.allCases {
            let scale = TextScale(category)
            let (layout, title, preview, meta, button) = layout(scale, points: 1)
            let at = "\(category)"
            XCTAssertEqual(layout.title, CGRect(x: hairline + 20, y: hairline + 20, width: 361 - 2 * hairline - 40, height: title), at)
            XCTAssertEqual(layout.subtitle.minY, layout.title.maxY + 4, at)
            XCTAssertEqual(layout.headerDivider.minY, layout.subtitle.maxY + 12, at)
            let row = layout.rows[0]
            XCTAssertEqual(row.text.height, preview, at)
            XCTAssertEqual(row.meta.minY, row.text.maxY + 4, at)
            XCTAssertEqual(row.frame.height, 12 * 2 + preview + 4 + meta + hairline, accuracy: 1e-9, at)
            // 11 above and below the button's one line.
            XCTAssertEqual(layout.cancel.height, 22 + button, at)
            XCTAssertEqual(layout.confirm.height, layout.cancel.height, at)
            XCTAssertEqual(layout.card.height, layout.cancel.maxY + 16 + hairline, accuracy: 1e-9, at)
        }
    }

    func testTheListShrinksFirstSoTheCardFitsTheWindow() {
        // Portrait and landscape: 85% of each height, rounded.
        let landscape = CGSize(width: 852, height: 393)
        for (window, maxHeight) in [(self.window, 724), (landscape, 334)] as [(CGSize, CGFloat)] {
            for category in TextSizeCategory.allCases {
                let (layout, _, _, _, _) = layout(TextScale(category), points: 12, window: window)
                let at = "\(category) in \(window)"
                let fixed = layout.headerDivider.maxY + hairline + 16 * 2 + layout.cancel.height + hairline
                XCTAssertEqual(layout.list.height, max(0, min(layout.listContentSize.height, 420, maxHeight - fixed)), accuracy: 1e-9, at)
                XCTAssertLessThanOrEqual(layout.card.height, max(maxHeight, fixed) + 1e-9, at)
                // Twelve points never fit: the list scrolls.
                XCTAssertLessThan(layout.list.height, layout.listContentSize.height, at)
                XCTAssertEqual(layout.card.midY, window.height / 2, accuracy: 1e-9, at)
            }
        }
        // Upright, the 420 cap holds the list even at the largest size.
        let (designed, _, _, _, _) = layout(.standard, points: 12)
        XCTAssertEqual(designed.list.height, 420)
        let (largest, _, _, _, _) = layout(TextScale(.accessibilityExtraExtraExtraLarge), points: 12)
        XCTAssertEqual(largest.list.height, 420)
        XCTAssertLessThan(largest.card.height, 724)
        // On its side the window does: the card is exactly its 85%.
        let (side, _, _, _, _) = layout(TextScale(.accessibilityExtraExtraExtraLarge), points: 12, window: landscape)
        XCTAssertLessThan(side.list.height, 420)
        XCTAssertGreaterThan(side.list.height, 0)
        XCTAssertEqual(side.card.height, 334, accuracy: 1e-9)
    }
}
