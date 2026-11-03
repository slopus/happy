import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The call bar's three waves, as Telegram's call status bar moves them:
/// each is a crest across the bar, resting on its bottom edge, that morphs
/// from one random shape to the next; how loud the call is makes the next
/// shape come sooner and wilder and sinks the two lower waves further
/// below the bar. The topmost wave is the bar's own ground; the two below
/// it show through translucent.
///
/// Only the motion is here, as numbers: the view turns `crests` into paths.
/// Nothing moves without a level the call itself reported; with none, the
/// waves morph slowly at rest, and `flat` (Reduce Motion, a call not yet
/// connected) holds them still on the edge.
///
/// Adapted from Telegram-iOS `TelegramCallsUI/Sources/CallStatusBarWavesLayer.swift`
/// (the wave motions, their amplitude and travel, their timing and the
/// level's smoothing).
public struct CallWaves: Sendable {
    public enum Constants {
        public static let smoothness: CGFloat = 0.5
        /// A crest's reach above and below the bar's edge, per unit of its
        /// randomness.
        public static let amplitude: CGFloat = 20
        /// How far the lower waves sink at the full level.
        public static let travel: CGFloat = 16
        /// Per-frame smoothing of the level at 60 fps.
        public static let levelSmoothing: CGFloat = 0.93
        /// The level that counts as full.
        public static let maxLevel: CGFloat = 1.5
        public static let speedMultiplier: CGFloat = 0.85
        /// The points a crest passes through, its ends included.
        public static let points = 6
    }

    public struct Motion: Equatable, Sendable {
        public var minRandomness: CGFloat
        public var maxRandomness: CGFloat
        public var minSpeed: CGFloat
        public var maxSpeed: CGFloat
        public var minOffset: CGFloat
        public var maxOffset: CGFloat
    }

    /// Bottom to top, with how opaque each is drawn.
    public static let motions: [Motion] = [
        Motion(minRandomness: 1.2, maxRandomness: 1.7, minSpeed: 1.0, maxSpeed: 5.8, minOffset: 0.1, maxOffset: 1.0),
        Motion(minRandomness: 1.2, maxRandomness: 1.5, minSpeed: 1.0, maxSpeed: 4.4, minOffset: 0.1, maxOffset: 0.55),
        Motion(minRandomness: 1.0, maxRandomness: 1.3, minSpeed: 0.9, maxSpeed: 3.2, minOffset: 0.0, maxOffset: 0.0),
    ]
    public static let alphas: [CGFloat] = [0.35, 0.55, 1.0]

    /// How far below the bar a wave can reach: a crest's random points go a
    /// quarter of their randomness below the edge, the curve through them
    /// overshoots by up to about a third more, and the lower waves sink by
    /// their travel.
    public static let overhang: CGFloat = {
        let randomness = motions.map(\.maxRandomness).max() ?? 0
        let offset = motions.map(\.maxOffset).max() ?? 0
        return (Constants.amplitude * randomness * 0.25 * 1.3 + Constants.travel * offset).rounded(.up) + 1
    }()

    /// One cubic segment of a crest, in the waves' own points.
    public struct Segment: Equatable, Sendable {
        public var to: CGPoint
        public var control1: CGPoint
        public var control2: CGPoint
    }

    /// A crest from the bar's left edge to its right: start at `start`, then
    /// each segment. The view closes it over the bar's top.
    public struct Crest: Equatable, Sendable {
        public var start: CGPoint
        public var segments: [Segment]
    }

    /// One wave: the shape it is coming from, the one it is going to, and
    /// how far along it is.
    struct Wave: Sendable {
        let motion: Motion
        /// Normalized: x in 0...1 across the bar, y in units of amplitude.
        var from: [CGPoint]
        var to: [CGPoint]
        var elapsed: CGFloat = 0
        var duration: CGFloat = 1
        var speedLevel: CGFloat = 0

        init<R: RandomNumberGenerator>(motion: Motion, random: inout R) {
            self.motion = motion
            from = []
            to = []
            from = points(random: &random)
            next(random: &random)
        }

        mutating func advance<R: RandomNumberGenerator>(by delta: CGFloat, random: inout R) {
            elapsed += delta
            while elapsed >= duration {
                elapsed -= duration
                from = to
                next(random: &random)
            }
        }

        /// Where the crest's points are now, and how far down it has sunk.
        func current(level: CGFloat) -> (points: [CGPoint], offset: CGFloat) {
            let progress = CallWaves.easeInOut(max(0, min(1, elapsed / duration)))
            let points = zip(from, to).map { CGPoint(x: $0.x + ($1.x - $0.x) * progress, y: $0.y + ($1.y - $0.y) * progress) }
            let offset = motion.minOffset > 0 ? (motion.minOffset + (motion.maxOffset - motion.minOffset) * level) * Constants.travel : 0
            return (points, offset)
        }

        private mutating func next<R: RandomNumberGenerator>(random: inout R) {
            to = points(random: &random)
            let speed = (motion.minSpeed + (motion.maxSpeed - motion.minSpeed) * speedLevel) * Constants.speedMultiplier
            duration = 1 / max(speed, 0.05)
            speedLevel = 0
        }

        private func points<R: RandomNumberGenerator>(random: inout R) -> [CGPoint] {
            let randomness = motion.minRandomness + (motion.maxRandomness - motion.minRandomness) * speedLevel
            let count = Constants.points
            let segment = 1 / CGFloat(count - 1)
            let rangeStart = 1 / (1 + randomness / 10)
            return (0..<count).map { index in
                if index == 0 { return CGPoint(x: 0, y: 0) }
                if index == count - 1 { return CGPoint(x: 1, y: 0) }
                let pointOffset = (rangeStart + CGFloat.random(in: 0..<1, using: &random) * (1 - rangeStart)) / 2
                let x = segment * CGFloat(index) + segment - segment * pointOffset
                let y = (randomness * CGFloat.random(in: 0..<1, using: &random) - randomness * 0.5) * pointOffset
                return CGPoint(x: x, y: y)
            }
        }
    }

    private var waves: [Wave]
    private var random: SplitMix
    /// The level last reported, 0...1, and the one drawn, which follows it.
    public private(set) var level: CGFloat = 0
    public private(set) var shownLevel: CGFloat = 0

    /// `seed` makes the shapes repeatable, for tests.
    public init(seed: UInt64 = UInt64.random(in: .min ... .max)) {
        var random = SplitMix(seed: seed)
        waves = Self.motions.map { Wave(motion: $0, random: &random) }
        self.random = random
    }

    /// How loud the call is now, from what it reported: the person's voice
    /// activity or the agent speaking. 0 is silence.
    public mutating func update(level: CGFloat) {
        let normalized = min(1, max(level / Constants.maxLevel, 0))
        for index in waves.indices { waves[index].speedLevel = max(waves[index].speedLevel, normalized) }
        self.level = normalized
    }

    /// Moves the waves on by `delta` seconds.
    public mutating func advance(by delta: CGFloat) {
        let smoothing = pow(Constants.levelSmoothing, delta * 60)
        shownLevel = shownLevel * smoothing + level * (1 - smoothing)
        for index in waves.indices { waves[index].advance(by: delta, random: &random) }
    }

    /// The three crests, bottom to top, across `width`, resting on `restY`
    /// (the bar's bottom edge). Flat, each is the edge itself.
    public func crests(width: CGFloat, restY: CGFloat, flat: Bool) -> [Crest] {
        waves.map { wave in
            guard !flat else {
                let start = CGPoint(x: 0, y: restY), end = CGPoint(x: width, y: restY)
                return Crest(start: start, segments: [Segment(to: end, control1: start, control2: end)])
            }
            let (points, offset) = wave.current(level: shownLevel)
            let placed = points.map { CGPoint(x: $0.x * width, y: restY + $0.y * Constants.amplitude + offset) }
            return Self.smooth(placed, smoothness: Constants.smoothness)
        }
    }

    /// A smooth curve through `points`: each segment's controls follow the
    /// line through its neighbours, `smoothness` of the way.
    static func smooth(_ points: [CGPoint], smoothness: CGFloat) -> Crest {
        guard let first = points.first else { return Crest(start: .zero, segments: []) }
        func tangent(_ index: Int) -> CGPoint {
            let previous = points[max(index - 1, 0)], next = points[min(index + 1, points.count - 1)]
            return CGPoint(x: (next.x - previous.x) / 2, y: (next.y - previous.y) / 2)
        }
        var segments: [Segment] = []
        for index in 1..<points.count {
            let a = points[index - 1], b = points[index]
            let ta = tangent(index - 1), tb = tangent(index)
            segments.append(Segment(
                to: b,
                control1: CGPoint(x: a.x + ta.x * smoothness, y: a.y + ta.y * smoothness),
                control2: CGPoint(x: b.x - tb.x * smoothness, y: b.y - tb.y * smoothness)
            ))
        }
        return Crest(start: first, segments: segments)
    }

    /// CSS ease-in-out, (0.42, 0, 0.58, 1), solved for x.
    static func easeInOut(_ x: CGFloat) -> CGFloat {
        let p1x: CGFloat = 0.42, p2x: CGFloat = 0.58
        func bezier(_ t: CGFloat, _ p1: CGFloat, _ p2: CGFloat) -> CGFloat {
            3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
        }
        var low: CGFloat = 0, high: CGFloat = 1, t = x
        for _ in 0..<24 {
            t = (low + high) / 2
            if bezier(t, p1x, p2x) < x { low = t } else { high = t }
        }
        return bezier(t, 0, 1)
    }
}

/// A small seeded generator, so the same seed draws the same waves.
struct SplitMix: RandomNumberGenerator, Sendable {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
