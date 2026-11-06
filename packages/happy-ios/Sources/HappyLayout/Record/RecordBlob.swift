import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The waves round the recording circle (Telegram's recording blob): two
/// outlines of eight points that keep morphing to new random shapes, faster
/// and wider the louder the voice was, and swell with its level. The middle
/// one sits between the circle and the outer one, so the three grow as one
/// ripple.
///
/// Sizes are of the blob's square, `Metrics.side`, centred on the circle;
/// a point's radius of 0.5 reaches that square's edge.
///
/// Adapted from Telegram-iOS `ChatRecordingBlobMotion.swift` and
/// `VoiceBlobView.swift`.
public struct RecordBlob: Equatable, Sendable {
    public enum Metrics {
        /// The blob's square: the circle is 0.45 of it, as Telegram's.
        public static let side: CGFloat = 244
        public static let centreScale: CGFloat = RecordMotion.Metrics.innerDiameter / side
        public static let pointCount = 8
        /// A morph's speed, in shapes a second, from silence to full voice.
        public static let minSpeed: CGFloat = 0.9
        public static let maxSpeed: CGFloat = 4
        /// How far a point may fall inside the outline: 1/(1 + r/10).
        public static let randomness: CGFloat = 1
        static let goldenRatio: CGFloat = (1 + 5.0.squareRoot()) / 2
        /// The outer wave from silence to full voice: Telegram's 0.57 of the
        /// square times 1.1, and the circle times φ², so the three circles
        /// grow by φ each at full voice.
        public static let outerScales: ClosedRange<CGFloat> = (0.57 * 1.1)...(centreScale * goldenRatio * goldenRatio)
        /// The waves at rest, against their size at the level; they grow
        /// from it as recording starts.
        public static let restingPresence: CGFloat = 0.75
        public static let presenceDuration: Double = 0.35
        /// A closed cubic curve through the points: the handle of the
        /// standard circle approximation for eight.
        public static let smoothness: CGFloat = {
            let angle = 2 * Double.pi / Double(pointCount)
            return CGFloat(((4.0 / 3.0) * tan(angle / 4)) / sin(angle / 2) / 2)
        }()
    }

    /// One piece of an outline: a cubic curve from the last piece's end.
    public struct Curve: Equatable, Sendable {
        public var to: CGPoint
        public var control1: CGPoint
        public var control2: CGPoint
    }

    /// Normalized offsets from the centre.
    public private(set) var from: [CGPoint]
    public private(set) var to: [CGPoint]
    public private(set) var duration: CGFloat = 1
    public private(set) var elapsed: CGFloat = 0
    private var speedLevel: CGFloat = 0
    private var random: RecordRandom

    public init(seed: UInt64) {
        random = RecordRandom(seed: seed)
        from = []
        to = []
        from = nextPoints()
        startNext()
    }

    /// The loudest level since the shape began sets the next one's speed.
    public mutating func hear(_ level: CGFloat) {
        speedLevel = max(speedLevel, min(1, max(0, level)))
    }

    public mutating func advance(by seconds: CGFloat) {
        elapsed += max(0, seconds)
        while elapsed >= duration {
            elapsed -= duration
            from = to
            startNext()
        }
    }

    /// The morph's eased progress, Telegram's (0.42, 0, 0.58, 1) curve.
    public var progress: CGFloat {
        RecordBlob.ease(min(1, max(0, elapsed / duration)))
    }

    /// The outline now, `scale` of the square of `side`, round `center`.
    /// It starts at the last curve's `to`.
    public func outline(scale: CGFloat, side: CGFloat = Metrics.side, center: CGPoint) -> [Curve] {
        let t = progress
        let points = zip(from, to).map { a, b in
            CGPoint(x: center.x + (a.x + (b.x - a.x) * t) * scale * side, y: center.y + (a.y + (b.y - a.y) * t) * scale * side)
        }
        return RecordBlob.smooth(points)
    }

    /// How far a voice swells the waves, 0 to 1, from its loudness on
    /// `RecordMotion.level`'s scale. Telegram's level is the microphone's
    /// peak over 4, which speech held at the phone seldom lifts past a
    /// tenth or so; loudness in decibels reads speech near half, so it is
    /// squared and halved to swell the same.
    public static func swell(_ level: CGFloat) -> CGFloat {
        let level = min(1, max(0, level))
        return level * level / 2
    }

    /// The outer and middle waves' scales for a swell and presence; the
    /// middle is the geometric mean of the circle and the outer.
    public static func scales(level: CGFloat, presence: CGFloat) -> (outer: CGFloat, middle: CGFloat) {
        let range = Metrics.outerScales
        let outer = (range.lowerBound + (range.upperBound - range.lowerBound) * min(1, max(0, level))) * presence
        return (outer, (Metrics.centreScale * outer).squareRoot())
    }

    /// The waves' presence `elapsed` seconds into recording, from resting.
    public static func presence(at elapsed: Double) -> CGFloat {
        let t = CGFloat(min(1, max(0, elapsed / Metrics.presenceDuration)))
        return Metrics.restingPresence + (1 - Metrics.restingPresence) * ease(t)
    }

    /// A closed smooth curve through `points`: each point's handles lie
    /// along the line from its previous to its next point.
    public static func smooth(_ points: [CGPoint]) -> [Curve] {
        let count = points.count
        guard count > 2 else { return [] }
        func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }
        let handles: [(into: CGPoint, out: CGPoint)] = (0..<count).map { index in
            let previous = points[(index + count - 1) % count]
            let point = points[index]
            let next = points[(index + 1) % count]
            let length = distance(previous, next)
            let direction = length > 0 ? CGPoint(x: (next.x - previous.x) / length, y: (next.y - previous.y) / length) : .zero
            let back = Metrics.smoothness * distance(point, previous)
            let forward = Metrics.smoothness * distance(point, next)
            return (CGPoint(x: point.x - direction.x * back, y: point.y - direction.y * back),
                    CGPoint(x: point.x + direction.x * forward, y: point.y + direction.y * forward))
        }
        return (0..<count).map { index in
            let next = (index + 1) % count
            return Curve(to: points[next], control1: handles[index].out, control2: handles[next].into)
        }
    }

    static func ease(_ t: CGFloat) -> CGFloat {
        // cubic-bezier(0.42, 0, 0.58, 1): x(s) solved by bisection, then y(s).
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        func bezier(_ s: CGFloat, _ p1: CGFloat, _ p2: CGFloat) -> CGFloat {
            let u = 1 - s
            return 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s
        }
        var low: CGFloat = 0
        var high: CGFloat = 1
        for _ in 0..<24 {
            let middle = (low + high) / 2
            if bezier(middle, 0.42, 0.58) < t { low = middle } else { high = middle }
        }
        return bezier((low + high) / 2, 0, 1)
    }

    private mutating func startNext() {
        to = nextPoints()
        let speed = Metrics.minSpeed + (Metrics.maxSpeed - Metrics.minSpeed) * speedLevel
        duration = 1 / max(speed, 0.05)
        speedLevel = 0
    }

    private mutating func nextPoints() -> [CGPoint] {
        let count = Metrics.pointCount
        let angle = 2 * CGFloat.pi / CGFloat(count)
        let rangeStart = 1 / (1 + Metrics.randomness / 10)
        let start = angle * random.next()
        return (0..<count).map { index in
            let radius = (rangeStart + random.next() * (1 - rangeStart)) / 2
            let jitter = angle * 0.1
            let step = angle + angle * (jitter * random.next() - jitter / 2)
            let pointAngle = start + CGFloat(index) * step
            return CGPoint(x: sin(pointAngle) * radius, y: cos(pointAngle) * radius)
        }
    }
}

/// SplitMix64: the blob's shapes, the same for the same seed.
struct RecordRandom: Equatable, Sendable {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    /// 0 up to 1.
    mutating func next() -> CGFloat {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return CGFloat(z >> 11) / CGFloat(1 << 53)
    }
}
