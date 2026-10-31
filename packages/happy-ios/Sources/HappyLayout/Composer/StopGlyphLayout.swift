import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Stop's glyph: a filled rounded square, the stop every chat and recorder
/// draws, in place of Octicons' octagon. It takes the glyph box the arrow it
/// replaces had, so send and stop read as one button changing its glyph.
public enum StopGlyphLayout {
    public enum Metrics {
        /// The square's side against the glyph box: 12 in send's 16.
        public static let sideRatio: CGFloat = 0.75
        /// The corner radius against the side: 3 on a 12 square.
        public static let cornerRatio: CGFloat = 0.25
    }

    public struct Square: Equatable, Sendable {
        public var frame: CGRect
        public var cornerRadius: CGFloat

        public init(frame: CGRect, cornerRadius: CGFloat) {
            self.frame = frame
            self.cornerRadius = cornerRadius
        }
    }

    /// The square for a `glyphSize` box, centred in `bounds`. Its side is a
    /// whole number of pixels as odd or even as the bounds' width, so it
    /// lands on the grid exactly centred: a pixel bigger rather than half a
    /// pixel off.
    public static func square(in bounds: CGRect, glyphSize: CGFloat, scale: CGFloat) -> Square {
        let scale = scale > 0 ? scale : 1
        var pixels = (glyphSize * Metrics.sideRatio * scale).rounded()
        let across = (bounds.width * scale).rounded()
        if pixels.truncatingRemainder(dividingBy: 2) != across.truncatingRemainder(dividingBy: 2) { pixels += 1 }
        let side = pixels / scale
        let origin = CGPoint(
            x: PixelGrid.round(bounds.midX - side / 2, scale: scale),
            y: PixelGrid.round(bounds.midY - side / 2, scale: scale)
        )
        return Square(
            frame: CGRect(origin: origin, size: CGSize(width: side, height: side)),
            cornerRadius: PixelGrid.round(side * Metrics.cornerRatio, scale: scale)
        )
    }
}

/// Send turning into stop and back: the old glyph shrinks and fades as the
/// new one grows in from the same size, while the fill changes.
public enum AgentInputPrimaryGlyphMotion {
    /// Seconds.
    public static let duration: Double = 0.2
    /// Where the glyph going away ends and the one coming in starts. Reduce
    /// Motion keeps the fade and drops the scale.
    public static let scale: CGFloat = 0.5
}
