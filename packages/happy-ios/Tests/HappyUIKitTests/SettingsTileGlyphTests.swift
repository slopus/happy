#if canImport(UIKit)
import HappyIcons
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The pencil-on-a-square glyph (create-outline) on a settings tile is
/// centred by its square, as the bar's compose button is
/// (`ComposeIconLayout`), not by its ink, which the pencil's overhang
/// pulls up and to the right. A before/after crop goes to the
/// repository's `.context/evidence/profile`.
@MainActor
final class SettingsTileGlyphTests: XCTestCase {
    private typealias M = SettingsLayout.Metrics

    /// RGBA bytes of `image`, drawn into a context of known layout.
    private struct Pixels {
        let width: Int, height: Int
        let bytes: [UInt8]

        init(_ image: UIImage) throws {
            let cg = try XCTUnwrap(image.cgImage)
            width = cg.width; height = cg.height
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            let space = CGColorSpaceCreateDeviceRGB()
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(data: buffer.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                context?.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            }
            self.bytes = bytes
        }

        /// White glyph over the blue tile: red is high only on the glyph.
        func glyph(_ x: Int, _ y: Int) -> Bool { bytes[(y * width + x) * 4] > 127 }
    }

    /// A tile as a settings row draws it: the square filled, the glyph's
    /// image centred in it.
    private func tile(_ glyph: UIImage, scale: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        let size = CGSize(width: M.tile, height: M.tile)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor(SettingsCardView.RowView.color(.blue)).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: M.tileRadius).fill()
            // As `contentMode = .center` puts it in a tile-sized image view.
            let origin = CGPoint(x: (size.width - glyph.size.width) / 2, y: (size.height - glyph.size.height) / 2)
            glyph.withTintColor(.white, renderingMode: .alwaysOriginal).draw(at: origin)
        }
    }

    /// The square's middle in pixels: a row below the pencil's tip crosses
    /// only its left and right sides, a column left of the pencil only its
    /// top and bottom.
    private func squareCentre(_ pixels: Pixels, scale: CGFloat) throws -> CGPoint {
        let inset = Int(scale)
        let row = Int(((M.tile - M.glyph) / 2 + M.glyph * 0.65) * scale)
        let column = Int(((M.tile - M.glyph) / 2 + M.glyph * 0.25) * scale)
        let across = (inset..<(pixels.width - inset)).filter { pixels.glyph($0, row) }
        let down = (inset..<(pixels.height - inset)).filter { pixels.glyph(column, $0) }
        let left = try XCTUnwrap(across.first), right = try XCTUnwrap(across.last)
        let top = try XCTUnwrap(down.first), bottom = try XCTUnwrap(down.last)
        return CGPoint(x: CGFloat(left + right + 1) / 2, y: CGFloat(top + bottom + 1) / 2)
    }

    func testTheSquareIsCentredOnTheTileWithinHalfAPixel() throws {
        for scale: CGFloat in [2, 3] {
            let glyph = UIImage.composeIcon(size: M.glyph, scale: scale)
            let pixels = try Pixels(tile(glyph, scale: scale))
            let centre = try squareCentre(pixels, scale: scale)
            XCTAssertEqual(centre.x, M.tile / 2 * scale, accuracy: 0.5, "\(scale)x: the square is off the tile's middle across")
            XCTAssertEqual(centre.y, M.tile / 2 * scale, accuracy: 0.5, "\(scale)x: the square is off the tile's middle down")
            // The pencil stays inside the 20-point glyph: nothing on its edges.
            let ink = try Pixels(glyph)
            let alpha = { (x: Int, y: Int) in ink.bytes[(y * ink.width + x) * 4 + 3] > 20 }
            XCTAssertFalse((0..<ink.width).contains { alpha($0, 0) || alpha($0, ink.height - 1) }, "\(scale)x: the pencil is clipped at the top or bottom")
            XCTAssertFalse((0..<ink.height).contains { alpha(0, $0) || alpha(ink.width - 1, $0) }, "\(scale)x: the pencil is clipped at a side")

            // What it was: centred by the font's box, the square sat a
            // point and more to the left.
            let before = try squareCentre(Pixels(tile(UIImage.icon(.ionicons("create-outline"), size: M.glyph, scale: scale), scale: scale)), scale: scale)
            XCTAssertGreaterThan(abs(before.x - M.tile / 2 * scale), scale, "the old glyph was already centred: this test proves nothing")
        }
    }

    /// Every V2 place that draws create-outline by name gets the square-
    /// centred image: Settings' tiles, their search results, and home's
    /// "New work" quick action (`compose`).
    func testEveryCreateOutlineByNameIsTheComposeImage() {
        XCTAssertTrue(Glyphs.image("create-outline", size: M.glyph) === UIImage.composeIcon(size: M.glyph))
        XCTAssertTrue(Glyphs.image("compose", size: 18) === UIImage.composeIcon(size: 18))
        XCTAssertEqual(SettingsIndex.changeAgentName.glyph, "create-outline")
    }

    /// A settings row puts that image in the middle of its tile.
    func testARowDrawsItCentredInItsTile() throws {
        LegacyFonts.registerBundledFonts()
        let card = SettingsCardView()
        let layout = SettingsLayout(width: 393, nameHeight: 0, subtitleHeight: 0, cards: [[SettingsLayout.RowSpec(hasIcon: true, accessory: .chevron)]], searching: true)
        card.frame = layout.cards[0].frame
        card.show([SettingsRow(SettingsIndex.changeAgentName)], layout: layout.cards[0])
        let row = try XCTUnwrap(card.subviews.first)
        let tile = try XCTUnwrap(row.subviews.first { $0.frame == layout.cards[0].rows[0].icon })
        let glyph = try XCTUnwrap(tile.subviews.first as? UIImageView)
        XCTAssertEqual(glyph.frame, tile.bounds)
        XCTAssertEqual(glyph.contentMode, .center)
        XCTAssertTrue(glyph.image === UIImage.composeIcon(size: M.glyph))
    }

    /// The tile before and after, at 3x, side by side, for the report.
    func testWritesTheBeforeAndAfterCrop() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return }
        let folder = context.appendingPathComponent("evidence/profile")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let scale: CGFloat = 3
        let before = tile(UIImage.icon(.ionicons("create-outline"), size: M.glyph, scale: scale), scale: scale)
        let after = tile(UIImage.composeIcon(size: M.glyph, scale: scale), scale: scale)
        // Each at 4x its size, with a hairline through the tile's middle.
        let side = M.tile * 4, gap: CGFloat = 24
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        let image = UIGraphicsImageRenderer(size: CGSize(width: side * 2 + gap * 3, height: side + gap * 2), format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side * 2 + gap * 3, height: side + gap * 2))
            for (index, picture) in [before, after].enumerated() {
                let frame = CGRect(x: gap + CGFloat(index) * (side + gap), y: gap, width: side, height: side)
                context.cgContext.interpolationQuality = .none
                picture.draw(in: frame)
                UIColor.red.withAlphaComponent(0.8).setFill()
                context.fill(CGRect(x: frame.midX - 0.5, y: frame.minY, width: 1, height: side))
                context.fill(CGRect(x: frame.minX, y: frame.midY - 0.5, width: side, height: 1))
            }
        }
        try XCTUnwrap(image.pngData()).write(to: folder.appendingPathComponent("tile-before-after.png"))
    }
}
#endif
