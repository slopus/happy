import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A story row's ring as arcs (design "Sidebar v2: agent story rings"): one
/// segment per story, the seen ones first in grey and thinner, the unseen
/// ones after them in colour, `gap` between segments when there are
/// several. The first starts at twelve o'clock and they run clockwise, as
/// desktop's SVG dashes do.
public enum StoryRingLayout {
    public struct Arc: Equatable, Sendable {
        /// Radians, clockwise from three o'clock in a y-down space.
        public var start: CGFloat
        public var end: CGFloat
        public var seen: Bool
    }

    /// `segments` arcs on a circle of `radius`, the first `seen` of them seen.
    /// No segments, no arcs: the mark stands without a ring.
    public static func arcs(segments: Int, seen: Int, radius: CGFloat, gap: CGFloat) -> [Arc] {
        guard segments > 0, radius > 0 else { return [] }
        let step = 2 * CGFloat.pi / CGFloat(segments)
        let gapAngle = segments > 1 ? gap / radius : 0
        let seen = min(max(0, seen), segments)
        return (0..<segments).map { index in
            let start = -CGFloat.pi / 2 + CGFloat(index) * step + gapAngle / 2
            return Arc(start: start, end: start + step - gapAngle, seen: index < seen)
        }
    }
}
