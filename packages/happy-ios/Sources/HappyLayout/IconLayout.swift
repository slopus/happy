import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One glyph's metrics in font units: what `IconLayout` needs to place it.
public struct IconMetrics: Equatable, Sendable {
    public var unitsPerEm: CGFloat
    /// The glyph's advance width (hmtx).
    public var advance: CGFloat
    /// The font's hhea ascender, positive.
    public var ascender: CGFloat
    /// The font's hhea descender, negative.
    public var descender: CGFloat

    public init(unitsPerEm: CGFloat, advance: CGFloat, ascender: CGFloat, descender: CGFloat) {
        self.unitsPerEm = unitsPerEm
        self.advance = advance
        self.ascender = ascender
        self.descender = descender
    }
}

/// Where React Native on iOS draws `<Ionicons name=… size={size} />`, so an
/// icon here lands on the same pixels.
///
/// @expo/vector-icons renders an icon as a `<Text>` holding one character
/// of the icon font, styled only with `fontSize: size` (no line height, no
/// width, `allowFontScaling` false). RN 0.83's iOS text layout
/// (`RCTTextLayoutManager.mm`) then:
///
/// - lays the text out with TextKit 1, `lineFragmentPadding` 0 and
///   `usesFontLeading = NO`, so the one line is `ascender - descender` tall
///   with no line gap, and its baseline sits `ascender` below the top;
/// - measures the used rect (the glyph's advance by that line height) and
///   rounds both sides up to whole device pixels;
/// - draws the glyph with its pen at the box's top-left corner, baseline
///   `ascender` down.
///
/// The ascender and descender are the font's hhea values, which is what
/// CoreText reports for a TrueType font; it ignores OS/2's typo metrics
/// even when `USE_TYPO_METRICS` is set, as it is in Ionicons (hhea 454/-71,
/// typo 448/-64 on 512 units). So a 29pt Ionicon is a 29 x 30 box (29.74
/// rounded up), and its glyph is not centred in it.
///
/// Yoga places that box like any measured node, then snaps it to the pixel
/// grid the way it snaps text: the position is floored, never rounded.
/// `frame(centeredIn:scale:)` is that placement for the common case of an
/// icon centred in a container.
public struct IconLayout: Equatable, Sendable {
    /// The `<Text>` box RN measures, in points, whole device pixels.
    public var size: CGSize
    /// Points per font unit: `size / unitsPerEm`.
    public var glyphScale: CGFloat
    /// Where the outline's origin lands in the box. Outlines here are y-down
    /// with the origin on the ascender line at the pen position, so this is
    /// the top-left corner of the line.
    public var glyphOrigin: CGPoint
    /// The baseline's distance from the top of the box: the ascender.
    public var baseline: CGFloat

    public init(metrics: IconMetrics, size fontSize: CGFloat, scale: CGFloat) {
        let glyphScale = metrics.unitsPerEm > 0 ? fontSize / metrics.unitsPerEm : 0
        let lineHeight = (metrics.ascender - metrics.descender) * glyphScale
        self.size = CGSize(
            width: Self.ceilToPixel(metrics.advance * glyphScale, scale: scale),
            height: Self.ceilToPixel(lineHeight, scale: scale)
        )
        self.glyphScale = glyphScale
        self.glyphOrigin = .zero
        self.baseline = metrics.ascender * glyphScale
    }

    /// The box centred in `container` by `alignItems` and `justifyContent:
    /// 'center'`, at the position Yoga snaps a text node to: the offset into
    /// the container is floored to device pixels. The container's own origin
    /// is assumed to be on the grid already, as Yoga's are.
    public func frame(centeredIn container: CGRect, scale: CGFloat) -> CGRect {
        CGRect(
            x: container.minX + Self.floorToPixel((container.width - size.width) / 2, scale: scale),
            y: container.minY + Self.floorToPixel((container.height - size.height) / 2, scale: scale),
            width: size.width,
            height: size.height
        )
    }

    /// A text box Yoga has placed at `frame` (centred in a row, say), snapped
    /// the way Yoga snaps text: the origin floored to device pixels, the
    /// size, already whole pixels, kept.
    public static func textFrame(_ frame: CGRect, scale: CGFloat) -> CGRect {
        CGRect(
            x: floorToPixel(frame.minX, scale: scale),
            y: floorToPixel(frame.minY, scale: scale),
            width: frame.width,
            height: frame.height
        )
    }

    /// RN's `ceil(value * scale) / scale`. A value a hair over a whole pixel
    /// from floating-point noise stays on that pixel.
    static func ceilToPixel(_ value: CGFloat, scale: CGFloat) -> CGFloat {
        guard scale > 0 else { return value }
        return (value * scale - 1e-9).rounded(.up) / scale
    }

    /// Yoga's `roundValueToPixelGrid` with `forceFloor`: down to the pixel,
    /// except that a value within 0.0001 of the next pixel counts as on it.
    static func floorToPixel(_ value: CGFloat, scale: CGFloat) -> CGFloat {
        guard scale > 0 else { return value }
        let scaled = value * scale
        let floor = scaled.rounded(.down)
        let fraction = scaled - floor
        return (fraction > 1 - 0.0001 ? floor + 1 : floor) / scale
    }
}
