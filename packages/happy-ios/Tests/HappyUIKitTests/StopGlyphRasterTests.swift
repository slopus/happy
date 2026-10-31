#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Stop draws a filled rounded square, centred in the round button to
/// within half a pixel at 2x and 3x, where the octagon used to be.
/// `HostedStopGlyphTests` takes the pictures.
@MainActor
final class StopGlyphRasterTests: XCTestCase {
    private func button(_ action: AgentInputPrimaryAction, style: AgentInputPrimaryStyle = .standard, busy: Bool = false, scale: CGFloat) -> ComposerPrimaryButton {
        let button = ComposerPrimaryButton(frame: CGRect(x: 0, y: 0, width: 42, height: 42))
        button.traitOverrides.displayScale = scale
        button.overrideUserInterfaceStyle = .light
        button.configure(action: action, style: style, busy: busy, accessibilityLabel: nil)
        button.layoutIfNeeded()
        return button
    }

    private func render(_ view: UIView, scale: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        return UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
            view.layer.render(in: context.cgContext)
        }
    }

    /// Which pixels are the glyph: darker than half on the light fill.
    private func glyph(_ image: UIImage) throws -> (Int, Int) -> Bool {
        let cg = try XCTUnwrap(image.cgImage)
        let width = cg.width, height = cg.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let space = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return { x, y in
            let i = (y * width + x) * 4
            return pixels[i + 3] > 200 && pixels[i] < 128
        }
    }

    private func glyphBox(_ image: UIImage) throws -> (minX: Int, maxX: Int, minY: Int, maxY: Int, count: Int) {
        let cg = try XCTUnwrap(image.cgImage)
        let isGlyph = try glyph(image)
        var box = (minX: Int.max, maxX: Int.min, minY: Int.max, maxY: Int.min, count: 0)
        for y in 0..<cg.height {
            for x in 0..<cg.width where isGlyph(x, y) {
                box.minX = min(box.minX, x); box.maxX = max(box.maxX, x)
                box.minY = min(box.minY, y); box.maxY = max(box.maxY, y)
                box.count += 1
            }
        }
        return box
    }

    func testSquareIsCentredWithinHalfAPixel() throws {
        for scale: CGFloat in [2, 3] {
            let stop = button(.stop, scale: scale)
            XCTAssertFalse(stop.stopView.isHidden, "@\(scale)x: the square is hidden")
            let square = stop.stopView.square
            XCTAssertEqual(square.frame, CGRect(x: 15, y: 15, width: 12, height: 12), "@\(scale)x")
            XCTAssertEqual(square.cornerRadius, 3, "@\(scale)x")

            let image = render(stop, scale: scale)
            let box = try glyphBox(image)
            XCTAssertGreaterThan(box.count, 0, "@\(scale)x: nothing drawn")
            let width = CGFloat(try XCTUnwrap(image.cgImage).width)
            let height = CGFloat(try XCTUnwrap(image.cgImage).height)
            // Centres in pixels, a pixel's centre being its index plus half.
            let centreX = CGFloat(box.minX + box.maxX + 1) / 2
            let centreY = CGFloat(box.minY + box.maxY + 1) / 2
            XCTAssertEqual(centreX, width / 2, accuracy: 0.5, "@\(scale)x: \(box)")
            XCTAssertEqual(centreY, height / 2, accuracy: 0.5, "@\(scale)x: \(box)")
            // 12 points across, give or take the antialiased corner pixels.
            XCTAssertEqual(CGFloat(box.maxX - box.minX + 1), 12 * scale, accuracy: 1, "@\(scale)x: \(box)")
            XCTAssertEqual(CGFloat(box.maxY - box.minY + 1), 12 * scale, accuracy: 1, "@\(scale)x: \(box)")
            // Filled, not an outline: nearly the whole square is the glyph, less
            // only the rounded corners.
            let full = 144 * scale * scale
            XCTAssertGreaterThan(CGFloat(box.count), full * 0.9, "@\(scale)x: not filled: \(box)")
        }
    }

    /// A square with round corners: its edges run straight to within the
    /// radius of each corner, and the very corner pixels are left out.
    func testCornersAreRounded() throws {
        let stop = button(.stop, scale: 3)
        let isGlyph = try glyph(render(stop, scale: 3))
        // 12 points from 15 at 3x: pixels 45 through 80, radius 9 pixels.
        for (x, y) in [(45, 45), (80, 45), (45, 80), (80, 80)] {
            XCTAssertFalse(isGlyph(x, y), "corner (\(x), \(y)) is square")
        }
        for (x, y) in [(55, 45), (70, 45), (45, 55), (45, 70), (80, 62), (62, 80)] {
            XCTAssertTrue(isGlyph(x, y), "edge (\(x), \(y)) is not straight")
        }
    }

    /// Send and stop are the one button: the same fill and tint, and a stop
    /// in flight shows only the spinner.
    func testGlyphsFollowTheAction() {
        let button = button(.send, scale: 3)
        XCTAssertTrue(button.stopView.isHidden)
        let sendFill = button.backgroundColor
        button.configure(action: .stop, style: .standard, busy: false, accessibilityLabel: nil)
        XCTAssertFalse(button.stopView.isHidden)
        XCTAssertEqual(button.accessibilityLabel, Strings.Composer.stop)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            XCTAssertEqual(button.backgroundColor?.resolvedColor(with: traits), sendFill?.resolvedColor(with: traits), "stop isn't on send's fill")
            XCTAssertEqual(button.stopView.tintColor.resolvedColor(with: traits), UIColor(Palette.text).resolvedColor(with: traits))
        }
        button.configure(action: .stop, style: .standard, busy: true, accessibilityLabel: nil)
        XCTAssertTrue(button.stopView.isHidden, "the square shows over the spinner")
        XCTAssertFalse(button.isEnabled)
        button.configure(action: .send, style: .standard, busy: false, accessibilityLabel: nil)
        XCTAssertTrue(button.stopView.isHidden)
    }

    /// On screen, send turning into stop fades and scales the glyphs over
    /// each other rather than swapping them.
    func testSendToStopAnimatesTheGlyph() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let button = button(.send, scale: 3)
        window.addSubview(button)
        window.isHidden = false
        defer { window.isHidden = true }
        UIView.setAnimationsEnabled(true)
        button.configure(action: .stop, style: .standard, busy: false, accessibilityLabel: nil)
        XCTAssertFalse(button.stopView.isHidden)
        let keys = button.stopView.layer.animationKeys() ?? []
        XCTAssertTrue(keys.contains { $0.contains("opacity") }, "the square doesn't fade in: \(keys)")
        if !UIAccessibility.isReduceMotionEnabled {
            XCTAssertTrue(keys.contains { $0.contains("transform") }, "the square doesn't grow in: \(keys)")
        }
    }
}
#endif
