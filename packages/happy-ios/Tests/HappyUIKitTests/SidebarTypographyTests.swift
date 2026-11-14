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

    /// A title too long for its box keeps its letters and fades out over
    /// the box's last `titleFade`; one that fits draws whole, as before.
    func testATitleThatOverflowsFadesOutAtItsEndAndOneThatFitsDoesNot() {
        let font = Fonts.ui(.medium, size: Metrics.labelSize)
        let box = CGRect(x: 10, y: 0, width: 120, height: 48)
        func title(_ string: String) -> NSAttributedString {
            NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: UIColor.black])
        }
        let long = title(String(repeating: "M", count: 40))
        let short = title("MMM")
        XCTAssertTrue(SidebarTypography.fades(long, width: box.width))
        XCTAssertFalse(SidebarTypography.fades(short, width: box.width))
        XCTAssertFalse(SidebarTypography.fades(title("MMM"), width: short.size().width.rounded(.up)))

        let faded = ink(long, in: box)
        // Whole before the fade, fainter through it, nearly clear at the end.
        let before = faded(box.maxX - Metrics.titleFade - 4)
        let middle = faded(box.maxX - Metrics.titleFade / 2)
        let end = faded(box.maxX - 1.5)
        XCTAssertGreaterThan(before, 0.9)
        XCTAssertLessThan(middle, before * 0.8)
        XCTAssertGreaterThan(middle, before * 0.2)
        XCTAssertLessThan(end, before * 0.3)
        // Nothing past the box.
        XCTAssertEqual(faded(box.maxX + 1.5), 0)

        // A title that fits keeps its last letter whole.
        let width = short.size().width
        let whole = ink(short, in: box)
        let lastStem = box.minX + width - font.pointSize * 0.1
        XCTAssertGreaterThan(whole(lastStem), 0.9)
    }

    /// The darkest pixel's alpha within a point of `x` (points) of `text`
    /// drawn as a title in `box`, at 3x.
    private func ink(_ text: NSAttributedString, in box: CGRect) -> (CGFloat) -> CGFloat {
        let scale: CGFloat = 3
        let size = CGSize(width: box.maxX + 20, height: box.maxY)
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            SidebarTypography.draw(text, in: box, scale: scale)
        }.cgImage!
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        func alpha(_ column: Int) -> UInt8 {
            (0..<height).map { pixels[($0 * width + min(width - 1, max(0, column))) * 4 + 3] }.max() ?? 0
        }
        // A point either side, so a gap between two letters doesn't read as faded.
        return { x in CGFloat((-3...3).map { alpha(Int(x * scale) + $0) }.max() ?? 0) / 255 }
    }
}
#endif