import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Where RN 0.83 on iOS draws an @expo/vector-icons glyph. Metrics are the
/// fonts' real head/hhea/hmtx values.
final class IconLayoutTests: XCTestCase {
    /// Ionicons.ttf: 512 units, hhea 454 / -71, icons 512 wide.
    let ionicon = IconMetrics(unitsPerEm: 512, advance: 512, ascender: 454, descender: -71)
    /// Octicons.ttf: hhea 450 / -68.
    let octicon = IconMetrics(unitsPerEm: 512, advance: 512, ascender: 450, descender: -68)
    /// MaterialIcons.ttf: hhea 512 / 0.
    let materialIcon = IconMetrics(unitsPerEm: 512, advance: 512, ascender: 512, descender: 0)
    /// MaterialCommunityIcons.ttf: hhea 448 / -64.
    let mdiIcon = IconMetrics(unitsPerEm: 512, advance: 512, ascender: 448, descender: -64)

    func testIoniconBoxIsOneLineOfTheFontRoundedUpToPixels() {
        // Item.tsx's 29pt icon: the line is 525/512 * 29 = 29.736pt, which
        // RN rounds up to 90px at 3x and 60px at 2x.
        let layout = IconLayout(metrics: ionicon, size: 29, scale: 3)
        assertSize(layout.size, CGSize(width: 29, height: 30))
        XCTAssertEqual(layout.glyphScale, 29.0 / 512.0)
        XCTAssertEqual(layout.glyphOrigin, .zero)
        XCTAssertEqual(layout.baseline, 454 * 29.0 / 512.0, accuracy: 1e-9)
        assertSize(IconLayout(metrics: ionicon, size: 29, scale: 2).size, CGSize(width: 29, height: 30))
    }

    func testSmallIoniconRoundsToThirdsAt3x() {
        // Item.tsx's chevron: 17pt, 17.43pt tall, 53px at 3x.
        assertSize(IconLayout(metrics: ionicon, size: 17, scale: 3).size, CGSize(width: 17, height: 53.0 / 3))
        // 34.86px at 2x rounds up to 35px.
        assertSize(IconLayout(metrics: ionicon, size: 17, scale: 2).size, CGSize(width: 17, height: 17.5))
    }

    func testFontsWithOtherMetrics() {
        // Octicons 16: 518/512 * 16 = 16.19pt, 49px at 3x.
        assertSize(IconLayout(metrics: octicon, size: 16, scale: 3).size, CGSize(width: 16, height: 49.0 / 3))
        // MaterialIcons' line is exactly one em: no rounding at all.
        assertSize(IconLayout(metrics: materialIcon, size: 24, scale: 3).size, CGSize(width: 24, height: 24))
        XCTAssertEqual(IconLayout(metrics: materialIcon, size: 24, scale: 3).baseline, 24)
        // MaterialCommunityIcons too: 448 + 64 = 512.
        assertSize(IconLayout(metrics: mdiIcon, size: 14, scale: 3).size, CGSize(width: 14, height: 14))
    }

    func testAGlyphNarrowerThanTheEmIsItsAdvanceWide() {
        // FontAwesome 4 has 1792 units and per-glyph advances: `close` is
        // 1408 wide, 15.71pt at 20pt, 48px at 3x.
        let close = IconMetrics(unitsPerEm: 1792, advance: 1408, ascender: 1536, descender: -256)
        assertSize(IconLayout(metrics: close, size: 20, scale: 3).size, CGSize(width: 16, height: 20))
    }

    func testAWholePixelIsNotRoundedUpByFloatingPointNoise() {
        // (0.1 + 0.2) / 0.3 * 72 is 72.00000000000003: 24pt must stay
        // 24pt, not become 24.33pt.
        let metrics = IconMetrics(unitsPerEm: 0.3, advance: 0.3, ascender: 0.1, descender: -0.2)
        let layout = IconLayout(metrics: metrics, size: 24, scale: 3)
        assertSize(layout.size, CGSize(width: 24, height: 24))
    }

    func testCenteredInItsContainerTheWayYogaSnapsText() {
        // Item.tsx: a 29 x 30 box centred in the 29 x 29 icon container sits
        // half a point above it. Yoga floors a text node's offset to the
        // pixel: -1.5px becomes -2px at 3x; at 2x -1px is already whole.
        let container = rect(16, 8, 29, 29)
        assertFrame(IconLayout(metrics: ionicon, size: 29, scale: 3).frame(centeredIn: container, scale: 3),
                    rect(16, 8 - 2.0 / 3, 29, 30))
        assertFrame(IconLayout(metrics: ionicon, size: 29, scale: 2).frame(centeredIn: container, scale: 2),
                    rect(16, 7.5, 29, 30))
    }

    func testCenteringFloorsPositiveOffsetsToo() {
        // A 22pt Ionicon (22 x 22.67 at 3x) centred in a 44pt row:
        // (44 - 22.67) / 2 = 10.67pt is 32px exactly; in a 45pt row it is
        // 33.5px, floored to 33px.
        let layout = IconLayout(metrics: ionicon, size: 22, scale: 3)
        assertSize(layout.size, CGSize(width: 22, height: 68.0 / 3))
        assertFrame(layout.frame(centeredIn: rect(0, 0, 44, 44), scale: 3), rect(11, 32.0 / 3, 22, 68.0 / 3))
        assertFrame(layout.frame(centeredIn: rect(0, 0, 45, 45), scale: 3), rect(34.0 / 3, 33.0 / 3, 22, 68.0 / 3))
    }

    func testFloorToPixelTreatsAHairUnderAPixelAsOnIt() {
        // Yoga's inexactEquals: 0.0001 of a pixel.
        XCTAssertEqual(IconLayout.floorToPixel(1.0 / 3 - 1e-7, scale: 3), 1.0 / 3, accuracy: 1e-9)
        XCTAssertEqual(IconLayout.floorToPixel(-0.5, scale: 3), -2.0 / 3, accuracy: 1e-9)
        XCTAssertEqual(IconLayout.floorToPixel(0.5, scale: 2), 0.5, accuracy: 1e-9)
    }
}

final class IconTextFrameTests: XCTestCase {
    func testATextBoxPlacedByALayoutSnapsLikeYogaText() {
        // Item.tsx's chevron, 17 x 17.67, centred in a 44pt row:
        // y = 13.17pt = 39.5px, floored to 39px. Size is kept.
        let frame = CGRect(x: 350.2, y: (44 - 53.0 / 3) / 2, width: 17, height: 53.0 / 3)
        assertFrame(IconLayout.textFrame(frame, scale: 3), rect(350, 13, 17, 53.0 / 3))
        assertFrame(IconLayout.textFrame(frame, scale: 2), rect(350, 13, 17, 53.0 / 3))
    }
}
