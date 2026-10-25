import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Telegram's effect as a story is reacted to (`StandaloneReactionAnimation`,
/// not large, its centre hidden): a 120 square centred on the heart or the
/// bubble tapped, and the effect drawn in the 240 around that, once. Its
/// generic effect throws seven copies of the reaction out of the middle;
/// ours does the same here: each from the middle to a point on a ring,
/// rising as it goes, growing to its peak then shrinking and fading.
public struct StoryReactionBurst: Equatable, Sendable {
    public enum Metrics {
        public static let expanded: CGFloat = 120
        public static let effect: CGFloat = 240
        public static let count = 7
        public static let duration: Double = 0.9
        /// A copy's side at its peak.
        public static let particle: CGFloat = 30
        /// How far up each rises beyond its ring point, as the effect floats.
        public static let rise: CGFloat = 26
        /// Where they start round the ring, straight up first.
        public static let firstAngle: CGFloat = -.pi / 2
        /// Each copy's reach, of the effect's half less a copy's half, and
        /// its start, a beat after the one before.
        public static let reach: [CGFloat] = [1, 0.82, 0.94, 0.76, 0.9, 0.8, 0.96]
        public static let peak: [CGFloat] = [1, 0.8, 0.9, 0.72, 0.86, 0.78, 0.94]
        public static let stagger: Double = 0.03
    }

    public struct Particle: Equatable, Sendable {
        public var start: CGPoint
        public var end: CGPoint
        /// Of `Metrics.particle`, at the top of its arc.
        public var peakScale: CGFloat
        public var rotation: CGFloat
        public var delay: Double
        public var duration: Double
    }

    /// The effect's square, centred on what was tapped.
    public let effect: CGRect
    public let particles: [Particle]

    public init(target: CGRect) {
        let M = Metrics.self
        let center = CGPoint(x: target.midX, y: target.midY)
        effect = CGRect(x: center.x - M.effect / 2, y: center.y - M.effect / 2, width: M.effect, height: M.effect)
        let radius = M.effect / 2 - M.particle / 2
        particles = (0..<M.count).map { index in
            let angle = M.firstAngle + CGFloat(index) * 2 * .pi / CGFloat(M.count)
            let reach = radius * M.reach[index % M.reach.count]
            let end = CGPoint(x: center.x + cos(angle) * reach, y: center.y + sin(angle) * reach - M.rise)
            let delay = Double(index) * M.stagger
            return Particle(
                start: center, end: end,
                peakScale: M.peak[index % M.peak.count],
                rotation: (index % 2 == 0 ? 1 : -1) * CGFloat(index + 1) * 0.06,
                delay: delay, duration: M.duration - delay
            )
        }
    }
}
