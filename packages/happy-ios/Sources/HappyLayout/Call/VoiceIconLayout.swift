import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The voice button's glyph: three upright bars with round ends, after
/// happy-app's `icon-voice` (four bars, 5 apart, 5/3 wide, on a 24 square),
/// cut to three (short, tall, middling) and drawn a little heavier, so it
/// weighs as much as compose beside it; centred on the square.
public struct VoiceIconLayout: Equatable, Sendable {
    /// On the 24-unit square, as happy-app's asset is drawn.
    public enum Metrics {
        public static let canvas: CGFloat = 24
        public static let pitch: CGFloat = 5.25
        public static let barWidth: CGFloat = 2.4
        public static let heights: [CGFloat] = [10, 17, 12.67]
    }

    public let size: CGSize
    /// Each bar, left to right; its ends are round (radius half its width).
    public let bars: [CGRect]

    public init(size: CGFloat) {
        self.size = CGSize(width: size, height: size)
        let scale = size / Metrics.canvas
        let width = Metrics.barWidth * scale
        let count = Metrics.heights.count
        let span = Metrics.pitch * CGFloat(count - 1) * scale
        let firstMid = size / 2 - span / 2
        bars = Metrics.heights.enumerated().map { index, height in
            let h = height * scale
            return CGRect(x: firstMid + CGFloat(index) * Metrics.pitch * scale - width / 2, y: (size - h) / 2, width: width, height: h)
        }
    }
}
