#if canImport(UIKit)
import HappyIcons
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Icons drawn from outlines and the light/dark switch. They need UIKit, so
/// they run only in the simulator; the placement math is covered on Linux
/// by IconLayoutTests.
@MainActor
final class IconAndThemeTests: XCTestCase {
    func testIconImageIsRNsTextBox() throws {
        let icon = Icon.ionicons("chevron-forward")
        let image = UIImage.icon(icon, size: 29, scale: 3)
        let layout = try XCTUnwrap(icon.layout(size: 29, scale: 3))
        XCTAssertEqual(image.size, CGSize(width: 29, height: 30))
        XCTAssertEqual(image.size, layout.size)
        XCTAssertEqual(image.scale, 3)
        XCTAssertEqual(image.renderingMode, .alwaysTemplate)
    }

    /// The pixels the image covers are the outline's, scaled and placed as
    /// IconLayout says: the glyph's bounds in points, within a pixel.
    func testIconImageInkMatchesTheOutline() throws {
        let icon = Icon.ionicons("chevron-forward")
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: icon))
        let layout = glyph.layout(size: 29, scale: 3)
        let ink = try XCTUnwrap(inkBounds(UIImage.icon(icon, size: 29, scale: 3)))
        let expected = glyph.path.cgPath.boundingBoxOfPath
            .applying(CGAffineTransform(scaleX: layout.glyphScale, y: layout.glyphScale))
        XCTAssertEqual(ink.minX, expected.minX, accuracy: 1.0 / 3)
        XCTAssertEqual(ink.minY, expected.minY, accuracy: 1.0 / 3)
        XCTAssertEqual(ink.maxX, expected.maxX, accuracy: 1.0 / 3)
        XCTAssertEqual(ink.maxY, expected.maxY, accuracy: 1.0 / 3)
    }

    func testAMissingIconIsAnEmptySquare() {
        let image = UIImage.icon(.ionicons("not-an-icon"), size: 20, scale: 2)
        XCTAssertEqual(image.size, CGSize(width: 20, height: 20))
        XCTAssertNil(inkBounds(image))
    }

    func testIconViewCentresTheBoxOnYogasPixels() throws {
        let view = IconView(.ionicons("checkmark-circle"), size: 26)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        window.addSubview(view)
        view.frame = CGRect(x: 10, y: 10, width: 26, height: 26)
        view.layoutIfNeeded()
        let scale = view.layoutScale
        let layout = try XCTUnwrap(Icon.ionicons("checkmark-circle").layout(size: 26, scale: scale))
        let imageView = try XCTUnwrap(view.subviews.first as? UIImageView)
        assertSameFrame(imageView.frame, layout.frame(centeredIn: view.bounds, scale: scale))
        XCTAssertEqual(view.sizeThatFits(.zero), layout.size)
    }

    func testThemeStyles() {
        XCTAssertEqual(ThemeController.style(for: .adaptive), .unspecified)
        XCTAssertEqual(ThemeController.style(for: .light), .light)
        XCTAssertEqual(ThemeController.style(for: .dark), .dark)
    }

    func testApplyingAThemeRecoloursEveryToken() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let label = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        window.addSubview(label)

        ThemeController.apply(.dark, to: window)
        XCTAssertEqual(window.overrideUserInterfaceStyle, .dark)
        // UIKit hands a window's new style down to its views lazily, before
        // their next layout (and so before they draw); the label's traits
        // read straight after are the old ones. Ask for that update now.
        settleTraits(window, label)
        XCTAssertEqual(label.traitCollection.userInterfaceStyle, .dark)
        XCTAssertEqual(resolved(Palette.text, in: label), UIColor(Palette.text.dark))
        XCTAssertEqual(resolved(Palette.groupedBackground, in: window), UIColor(Palette.groupedBackground.dark))

        ThemeController.apply(.light, to: window)
        settleTraits(window, label)
        XCTAssertEqual(label.traitCollection.userInterfaceStyle, .light)
        XCTAssertEqual(resolved(Palette.text, in: label), UIColor(Palette.text.light))

        ThemeController.apply(.adaptive, to: window)
        XCTAssertEqual(window.overrideUserInterfaceStyle, .unspecified)
    }

    /// The trait update UIKit makes before the next layout, made now, from
    /// the window down.
    private func settleTraits(_ views: UIView...) {
        for view in views { view.updateTraitsIfNeeded() }
    }

    private func resolved(_ token: ColorToken, in view: UIView) -> UIColor {
        UIColor(token).resolvedColor(with: view.traitCollection)
    }

    /// The rect of pixels with any alpha, in points; nil for a blank image.
    private func inkBounds(_ image: UIImage) -> CGRect? {
        guard let cg = image.cgImage else { return nil }
        let width = cg.width, height = cg.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where pixels[(y * width + x) * 4 + 3] > 0 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= 0 else { return nil }
        let scale = image.scale
        return CGRect(x: CGFloat(minX) / scale, y: CGFloat(minY) / scale,
                      width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale)
    }
}
#endif
