import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A seedling hatching into its picture, desktop's `V2Growth`: the
/// cell divides (8 cells in a 20-point lane, 16 where it has room), the
/// daughters converge onto the picture, and the picture takes over. Its
/// timing is desktop's `timeline` exactly; the drawing is a
/// Core Animation stand-in for desktop's shader. The haptic that plays with
/// it is sampled from the same timeline, so what is felt is what is seen.
public enum Hatch {
    /// Every hatch takes this long (`STEM_CELL_VARIANTS.*.total`).
    public static let total: Double = 2.5
    /// Share of a generation's window a cell waits before dividing, and the share one division takes.
    static let stagger = 0.3
    static let divide = 0.7

    /// `variantFor`: 8 cells where the mark is a lane, 16 where it has room.
    public static func generations(size: CGFloat) -> Int { size <= 32 ? 3 : 4 }

    // MARK: Timeline

    public struct Timeline: Equatable, Sendable {
        public var intro: Double
        public var starts: [Double]
        public var durations: [Double]
        public var divisionsEnd: Double
        public var end: Double

        /// `timeline`: divisions take the first 62% (the first cleavage
        /// the most room, since it is the one people see); the rest converges.
        public init(depth: Int, total: Double = Hatch.total) {
            intro = total * 0.04
            divisionsEnd = total * 0.62
            end = total
            let budget = divisionsEnd - intro
            let weights = (0..<depth).map { g -> Double in
                let k = depth <= 1 ? 0 : Double(g) / Double(depth - 1)
                return g == 0 ? 1.5 : 1 - 0.6 * k.squareRoot()
            }
            let sum = weights.reduce(0, +)
            var t = intro
            var starts: [Double] = []
            var durations: [Double] = []
            for weight in weights {
                let d = weight / (sum == 0 ? 1 : sum) * budget
                starts.append(t)
                durations.append(d)
                t += d
            }
            self.starts = starts
            self.durations = durations
        }

        /// 0…1 through the convergence after the last division.
        public func converge(_ t: Double) -> Double {
            clamp((t - divisionsEnd) / (end - divisionsEnd))
        }

        /// When the picture has fully taken over (`morph` reaches 1 at 0.96 of convergence).
        public var formed: Double { divisionsEnd + 0.96 * (end - divisionsEnd) }

        /// When generation `g`'s cells tear in two: halfway through a division
        /// started at the middle of the stagger.
        public func cleavage(_ g: Int) -> Double {
            starts[g] + stagger * 0.5 * durations[g] + 0.5 * divide * durations[g]
        }
    }

    // MARK: Frames

    public struct Cell: Equatable, Sendable {
        public var center: CGPoint
        public var radius: CGFloat
    }

    public struct Frame: Equatable, Sendable {
        /// Always 2^generations cells; before they divide, sisters stand on one another.
        public var cells: [Cell]
        public var cellAlpha: CGFloat
        /// The cores dissolve before the picture reaches them.
        public var coreAlpha: CGFloat
        /// 0…1, how far the membranes have taken the picture's colour.
        public var tint: CGFloat
        public var pictureAlpha: CGFloat
        public var pictureScale: CGFloat
    }

    /// The leaves' regions: the mark halved along alternating axes, the
    /// first cut's direction seeded so sister rows don't divide alike.
    static func regions(size: CGFloat, generations: Int, seed: String) -> [[CGRect]] {
        let vertical = seed.unicodeScalars.reduce(UInt32(2_166_136_261)) { ($0 ^ $1.value) &* 16_777_619 } & 1 == 0
        var levels: [[CGRect]] = [[CGRect(x: 0, y: 0, width: size, height: size)]]
        for g in 0..<generations {
            let splitX = (g % 2 == 0) == vertical
            levels.append(levels[g].flatMap { rect -> [CGRect] in
                splitX
                    ? [CGRect(x: rect.minX, y: rect.minY, width: rect.width / 2, height: rect.height), CGRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height)]
                    : [CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height / 2), CGRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2)]
            })
        }
        return levels
    }

    /// The hatch at `t` seconds, for a mark `size` across.
    public static func frame(at t: Double, size: CGFloat, seed: String) -> Frame {
        frames(at: [t], size: size, seed: seed)[0]
    }

    /// The hatch at each of `times`, its cells split once for them all.
    public static func frames(at times: [Double], size: CGFloat, seed: String) -> [Frame] {
        let generations = generations(size: size)
        let time = Timeline(depth: generations)
        let levels = regions(size: size, generations: generations, seed: seed)
        return times.map { frame(at: $0, size: size, generations: generations, time: time, levels: levels) }
    }

    private static func frame(at t: Double, size: CGFloat, generations: Int, time: Timeline, levels: [[CGRect]]) -> Frame {
        let leaves = 1 << generations
        func circle(_ rect: CGRect, scale: CGFloat) -> Cell {
            Cell(center: CGPoint(x: rect.midX, y: rect.midY), radius: min(rect.width, rect.height) * 0.5 * scale)
        }
        // Each leaf follows its ancestor at the deepest generation that has divided.
        var cells: [Cell] = []
        for leaf in 0..<leaves {
            var cell = circle(levels[0][0], scale: 0.9)
            for g in 0..<generations {
                let p = clamp((t - time.starts[g] - stagger * 0.5 * time.durations[g]) / (divide * time.durations[g]))
                guard p > 0 else { break }
                let child = levels[g + 1][leaf >> (generations - g - 1)]
                let target = circle(child, scale: 0.92)
                let m = easeInOut(smoothstep(0.22, 0.92, p))
                // The mother rounds up a little before she tears.
                let swell = 1 + 0.08 * smoothstep(0, 0.2, p) * (1 - smoothstep(0.4, 0.7, p))
                cell = Cell(
                    center: CGPoint(x: lerp(cell.center.x, target.center.x, m), y: lerp(cell.center.y, target.center.y, m)),
                    radius: lerp(cell.radius * swell, target.radius, m)
                )
            }
            cells.append(cell)
        }
        let q = time.converge(t)
        let converge = 1 - pow(1 - q, 2.2)
        // Converging, the daughters draw in on the picture's middle as they fade into it.
        let middle = CGPoint(x: size / 2, y: size / 2)
        let pull = CGFloat(converge) * 0.35
        cells = cells.map { Cell(center: CGPoint(x: lerp($0.center.x, middle.x, pull), y: lerp($0.center.y, middle.y, pull)), radius: $0.radius * (1 + 0.25 * CGFloat(converge))) }
        let last = time.durations.last ?? 0
        let coreFade = 1 - smoothstep(time.divisionsEnd - last * 0.3, time.divisionsEnd + 0.1 * (time.end - time.divisionsEnd), t)
        let morph = smoothstep(0.82, 0.96, q)
        return Frame(
            cells: cells,
            cellAlpha: CGFloat(1 - smoothstep(0.3, 0.9, q)),
            coreAlpha: CGFloat(coreFade),
            tint: CGFloat(smoothstep(0.3, 1, clamp((t - time.intro) / (time.divisionsEnd - time.intro)))),
            pictureAlpha: CGFloat(max(smoothstep(0.04, 0.55, q) * 0.85, morph)),
            pictureScale: CGFloat(0.82 + 0.18 * converge)
        )
    }

    // MARK: Haptics

    /// What the hatch feels like: a wave that swells once per cleavage and
    /// grows sharper as the cells get smaller, then a damped ripple that
    /// settles as they converge, and a crisp tap where the picture forms.
    public struct Haptics: Equatable, Sendable {
        public struct Tap: Equatable, Sendable {
            public var time: Double
            public var intensity: Double
            public var sharpness: Double
        }

        public var taps: [Tap]
        /// The continuous wave: from `start`, for `duration`.
        public var start: Double
        public var duration: Double
        /// Its envelope sampled every `step`, from `start`.
        public var intensity: [(time: Double, value: Double)]
        public var sharpness: [(time: Double, value: Double)]

        public static func == (a: Haptics, b: Haptics) -> Bool {
            a.taps == b.taps && a.start == b.start && a.duration == b.duration
                && a.intensity.map(\.time) == b.intensity.map(\.time) && a.intensity.map(\.value) == b.intensity.map(\.value)
                && a.sharpness.map(\.time) == b.sharpness.map(\.time) && a.sharpness.map(\.value) == b.sharpness.map(\.value)
        }
    }

    public static let hapticStep = 0.05

    /// The wave's intensity at `t`: a sine crest over each division, rising
    /// generation to generation, on a low floor; then `0.55·e^(−3q)·|cos 3πq|`
    /// through the convergence, settling to nothing as the picture forms.
    public static func intensity(at t: Double, generations: Int) -> Double {
        let time = Timeline(depth: generations)
        if t < time.intro || t >= time.formed { return 0 }
        if t < time.divisionsEnd {
            var value = 0.12
            for g in 0..<generations {
                let from = time.starts[g] + stagger * 0.5 * time.durations[g]
                let p = (t - from) / (divide * time.durations[g])
                guard p > 0, p < 1 else { continue }
                value = max(value, (0.35 + 0.5 * Double(g) / Double(max(1, generations - 1))) * sin(.pi * p))
            }
            return value
        }
        let q = time.converge(t)
        return 0.55 * exp(-3 * q) * abs(cos(3 * .pi * q))
    }

    /// Sharpness rises as the cells get smaller.
    public static func sharpness(at t: Double, generations: Int) -> Double {
        0.2 + 0.4 * clamp(t / Timeline(depth: generations).divisionsEnd)
    }

    public static func haptics(size: CGFloat) -> Haptics {
        let generations = generations(size: size)
        let time = Timeline(depth: generations)
        var taps: [Haptics.Tap] = (0..<generations).map { g in
            let share = Double(g) / Double(max(1, generations - 1))
            return Haptics.Tap(time: round3(time.cleavage(g)), intensity: round3(0.45 + 0.25 * share), sharpness: round3(0.35 + 0.4 * share))
        }
        taps.append(Haptics.Tap(time: round3(time.formed), intensity: 0.8, sharpness: 0.9))
        var intensity: [(Double, Double)] = []
        var sharpness: [(Double, Double)] = []
        var t = time.intro
        while t < time.formed {
            intensity.append((round3(t - time.intro), round3(Self.intensity(at: t, generations: generations))))
            sharpness.append((round3(t - time.intro), round3(Self.sharpness(at: t, generations: generations))))
            t += hapticStep
        }
        return Haptics(taps: taps, start: round3(time.intro), duration: round3(time.formed - time.intro), intensity: intensity, sharpness: sharpness)
    }

    // MARK: Curves

    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    static func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
        let t = clamp((x - a) / (b - a))
        return t * t * (3 - 2 * t)
    }
    static func easeInOut(_ t: Double) -> Double { t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ t: Double) -> CGFloat { a + (b - a) * CGFloat(t) }
    static func round3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }
}
