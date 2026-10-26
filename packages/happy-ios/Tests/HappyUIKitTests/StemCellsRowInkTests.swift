#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Where a sidebar row's ink really lands, drawn at 3x in the row box as
/// `StemCellsSidebarLayout` places it: the title's x-height middle and each
/// end mark's optical centre (alpha-weighted) on the row's middle, and the
/// marks half the row in from each side.
@MainActor
final class StemCellsRowInkTests: XCTestCase {
    struct Ink {
        var box: CGRect
        var centroid: CGPoint
    }

    /// `draw`'s ink in a `size` canvas at 3x, in points.
    static func ink(_ size: CGSize, _ draw: () -> Void) -> Ink {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let cg = UIGraphicsImageRenderer(size: size, format: format).image { _ in draw() }.cgImage!
        let width = cg.width, height = cg.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        var minX = width, minY = height, maxX = -1, maxY = -1
        var sum = 0.0, sx = 0.0, sy = 0.0
        for y in 0..<height {
            for x in 0..<width {
                let a = Double(data[(y * width + x) * 4 + 3]) / 255
                guard a > 0.02 else { continue }
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                sum += a; sx += a * (Double(x) + 0.5); sy += a * (Double(y) + 0.5)
            }
        }
        let box = CGRect(x: CGFloat(minX) / 3, y: CGFloat(minY) / 3, width: CGFloat(maxX - minX + 1) / 3, height: CGFloat(maxY - minY + 1) / 3)
        return Ink(box: box, centroid: CGPoint(x: sx / sum / 3, y: sy / sum / 3))
    }

    /// A glyph as the row's image view draws it: centred in `frame`.
    static func draw(_ name: String, size: CGFloat, in frame: CGRect) {
        let image = StemCellsGlyphs.image(name, size: size).withTintColor(.black, renderingMode: .alwaysOriginal)
        image.draw(at: CGPoint(x: frame.midX - image.size.width / 2, y: frame.midY - image.size.height / 2))
    }

    /// The tokens say where the chevrons' ink weighs: measured, it does.
    func testTheChevronsInkWeighsWhereTheTokensSay() {
        let size = StemCellsMetrics.chevronGlyph
        let square = CGRect(x: 0, y: 0, width: 3 * size, height: 3 * size)
        for (name, ink) in [("chevron-down", StemCellsMetrics.chevronDownInk), ("chevron-right", StemCellsMetrics.chevronRightInk)] {
            let measured = Self.ink(square.size) { Self.draw(name, size: size, in: square) }
            XCTAssertEqual(measured.centroid.x - square.midX, ink.dx, accuracy: 0.02, name)
            XCTAssertEqual(measured.centroid.y - square.midY, ink.dy, accuracy: 0.02, name)
        }
    }

    /// A row drawn where the layout puts its parts, in its own box: the
    /// title's x-height middle, the mark's ink and the fold's ink weight
    /// all on the row's middle, the marks 24 in from each side.
    func testARowsEndsAndTitleShareItsMiddle() {
        typealias M = StemCellsMetrics
        for closed in [false, true] {
            let frame = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true, foldClosed: closed)], width: 402).frames[0]
            let box = frame.box
            func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -box.minX, dy: -box.minY) }
            let middle = box.height / 2
            // The title: its x-height's ink, "xxxx" in the row's font.
            let label = UILabel(frame: local(frame.label))
            label.font = StemCellsFonts.ui(.medium, size: M.labelSize)
            label.textColor = .black
            label.text = "xxxx"
            let title = Self.ink(box.size) {
                UIGraphicsGetCurrentContext()!.translateBy(x: label.frame.minX, y: label.frame.minY)
                label.drawText(in: label.bounds)
            }
            XCTAssertEqual(title.box.midY, middle, accuracy: 1.0 / 3, "the title's x-height isn't on the row's middle")
            // The leading glyph: its ink box centred 24 in, 24 down.
            let mark = Self.ink(box.size) { Self.draw("doc", size: M.glyph, in: local(frame.mark!)) }
            XCTAssertEqual(mark.box.midX, M.endInset, accuracy: 1.0 / 3)
            XCTAssertEqual(mark.box.midY, middle, accuracy: 1.0 / 3)
            // The fold: its ink's weight 24 in from the right, 24 down.
            let fold = Self.ink(box.size) { Self.draw(closed ? "chevron-right" : "chevron-down", size: M.chevronGlyph, in: local(frame.chevronGlyph!)) }
            XCTAssertEqual(box.width - fold.centroid.x, M.endInset, accuracy: 1.0 / 6 + 0.02, "closed: \(closed)")
            XCTAssertEqual(fold.centroid.y, middle, accuracy: 1.0 / 6 + 0.02, "closed: \(closed)")
        }
    }

    /// A section heading's title starts where a top-level glyph's ink
    /// does, as desktop's 10px does over its icons.
    func testASectionsTitleStartsWhereTheGlyphsInkDoes() {
        typealias M = StemCellsMetrics
        let frames = StemCellsSidebarLayout.layout([.init(kind: .section), .init(kind: .row)], width: 402).frames
        let glyph = Self.ink(frames[1].box.size) { Self.draw("doc", size: M.glyph, in: frames[1].mark!.offsetBy(dx: -frames[1].box.minX, dy: -frames[1].box.minY)) }
        let box = frames[0].box
        let label = UILabel(frame: frames[0].label.offsetBy(dx: -box.minX, dy: -box.minY))
        label.attributedText = NSAttributedString(string: "PROJECTS", attributes: [
            .font: StemCellsFonts.mono(bold: true, size: M.sectionLabelSize),
            .kern: M.sectionLabelSize * M.sectionTracking,
        ])
        let title = Self.ink(box.size) {
            UIGraphicsGetCurrentContext()!.translateBy(x: label.frame.minX, y: label.frame.minY)
            label.drawText(in: label.bounds)
        }
        XCTAssertEqual(title.box.minX, glyph.box.minX, accuracy: 0.5, "title ink \(title.box.minX), glyph ink \(glyph.box.minX)")
    }
}
#endif
