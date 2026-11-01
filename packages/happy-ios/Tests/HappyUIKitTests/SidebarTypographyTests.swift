#if canImport(UIKit)
import CoreText
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class SidebarTypographyTests: XCTestCase {
    func testFlatDigitsMatchTheTitleXHeightOnOneBaseline() {
        let counts = SidebarLineChanges.font
        let box = CGRect(x: 0, y: 0, width: 300, height: 48)
        for weight in [Fonts.Weight.medium, .semiBold, .bold] {
            let title = Fonts.ui(weight, size: Metrics.labelSize)
            XCTAssertEqual(counts.capHeight, title.xHeight, accuracy: 0.001)
            for scale: CGFloat in [2, 3] {
                let baseline = SidebarTypography.baseline(in: box, scale: scale)
                XCTAssertEqual(baseline - title.xHeight / 2, box.midY, accuracy: 0.5 / scale)
                let digits = CTLineCreateWithAttributedString(NSAttributedString(string: "0123456789", attributes: [.font: counts]))
                let ink = CTLineGetBoundsWithOptions(digits, .useGlyphPathBounds)
                // Round digits' natural overshoot stays inside one physical pixel.
                XCTAssertEqual(ink.maxY, title.xHeight, accuracy: 1 / scale)
                XCTAssertEqual(ink.minY, 0, accuracy: 1 / scale)
            }
        }
    }
}
#endif