import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Where the scenes drifting down the sides of Happy Cloud's welcome go
/// (desktop's SetupDrift.tsx): the first half down the left, the rest down
/// the right, each in its own band of height so two never land on each
/// other, somewhere random inside it, and each wandering back and forth by
/// its own offset.
///
/// On a tablet it is desktop's: 64–104 square, 5–19% in from its side,
/// between 14% and 80% of the height, wandering ±36 across and ±48 down.
/// On a phone they are 40–56, at most two a side, hugging the edge and up
/// to 35% off it, wandering ±8 and ±20. On either, a scene is kept clear of
/// everything in `avoid` (the slides' art and words, the dots, the buttons)
/// with its wander and 8 to spare: a side whose edge something reaches is
/// used only above and below it, and a side with no room shows fewer, or
/// none.
public struct SetupDriftLayout: Equatable, Sendable {
    public enum Metrics {
        public static let sizes: ClosedRange<CGFloat> = 64...104
        public static let wander = CGSize(width: 36, height: 48)
        /// In from each side, of the width.
        public static let across: ClosedRange<CGFloat> = 0.05...0.19
        /// Down, of the height.
        public static let down: ClosedRange<CGFloat> = 0.14...0.80
        public static let compactSizes: ClosedRange<CGFloat> = 40...56
        public static let compactWander = CGSize(width: 8, height: 20)
        public static let compactPerSide = 2
        /// How much of a phone's scene may sit off its edge.
        public static let compactTuck: CGFloat = 0.35
        /// Kept clear around a scene and its wander.
        public static let margin: CGFloat = 8
        /// From this short side (a tablet) it is desktop's.
        public static let regularShortSide: CGFloat = 600
        /// Each fades in after its delay, to this opacity, then wanders
        /// there and back, each way over its duration.
        public static let delays: ClosedRange<CGFloat> = 0.2...2.4
        public static let durations: ClosedRange<CGFloat> = 16...28
        public static let fade: TimeInterval = 1.6
        public static let opacity: CGFloat = 0.9
    }

    /// One scene's random picks, each 0..<1, drawn once so a rotation
    /// moves it without picking again.
    public struct Draw: Equatable, Sendable {
        public var size, x, y, dx, dy, delay, duration: CGFloat

        public init(size: CGFloat, x: CGFloat, y: CGFloat, dx: CGFloat, dy: CGFloat, delay: CGFloat, duration: CGFloat) {
            self.size = size; self.x = x; self.y = y; self.dx = dx; self.dy = dy; self.delay = delay; self.duration = duration
        }

        public static func random(_ next: () -> CGFloat = { CGFloat.random(in: 0..<1) }) -> Draw {
            Draw(size: next(), x: next(), y: next(), dx: next(), dy: next(), delay: next(), duration: next())
        }
    }

    public struct Item: Equatable, Sendable {
        /// Which of the scenes.
        public var scene: Int
        /// Where it rests.
        public var frame: CGRect
        /// Where it wanders to and back from.
        public var offset: CGVector
        public var delay: TimeInterval
        public var duration: TimeInterval
    }

    /// The scenes shown, left side first; a scene not here isn't shown.
    public var items: [Item]

    /// `safeArea` includes the bar; `draws` has one per scene.
    public init(size: CGSize, safeArea: LayoutInsets, avoid: [CGRect], draws: [Draw]) {
        let regular = min(size.width, size.height) >= Metrics.regularShortSide
        let left = (draws.count + 1) / 2
        let mirrored = avoid.map { CGRect(x: size.width - $0.maxX, y: $0.minY, width: $0.width, height: $0.height) }
        let leftItems = Self.side(Array(0..<left), size: size, edge: safeArea.left, safeArea: safeArea, avoid: avoid, draws: draws, regular: regular)
        let rightItems = Self.side(Array(left..<draws.count), size: size, edge: safeArea.right, safeArea: safeArea, avoid: mirrored, draws: draws, regular: regular)
            .map { item -> Item in
                var item = item
                item.frame.origin.x = size.width - item.frame.maxX
                return item
            }
        items = leftItems + rightItems
    }

    /// One side's, laid out as the left (`avoid` mirrored for the right).
    private static func side(_ scenes: [Int], size: CGSize, edge: CGFloat, safeArea: LayoutInsets, avoid: [CGRect], draws: [Draw], regular: Bool) -> [Item] {
        typealias M = Metrics
        let sizes = regular ? M.sizes : M.compactSizes
        let wander = regular ? M.wander : M.compactWander
        let tuck = regular ? 0 : M.compactTuck
        let scenes = regular ? scenes : Array(scenes.prefix(M.compactPerSide))
        let top = safeArea.top + M.margin, bottom = size.height - safeArea.bottom - M.margin
        let yTop = regular ? max(top, size.height * M.down.lowerBound) : top
        let yBottom = regular ? min(bottom, size.height * M.down.upperBound) : bottom

        // What reaches into the strip any scene here needs is passed only
        // above or below.
        let strip = sizes.upperBound * (1 - tuck) + wander.width * 2 + M.margin
        let blocked = avoid.filter { $0.minX < edge + strip && $0.height > 0 }.map { ($0.minY, $0.maxY) }.sorted { $0.0 < $1.0 }
        var gaps: [(CGFloat, CGFloat)] = []
        var cursor = yTop
        for (from, to) in blocked {
            if from > cursor { gaps.append((cursor, min(from, yBottom))) }
            cursor = max(cursor, to)
        }
        if cursor < yBottom { gaps.append((cursor, yBottom)) }
        // Where a centre may go: the largest scene and its wander stay inside.
        let reach = sizes.upperBound / 2 + wander.height + M.margin
        let room = gaps.map { ($0.0 + reach, $0.1 - reach) }.filter { $0.1 >= $0.0 }
        guard !room.isEmpty else { return [] }
        let total = room.reduce(0) { $0 + $1.1 - $1.0 }
        let spacing = sizes.upperBound + wander.height * 2
        let count = min(scenes.count, room.count + Int(total / spacing))
        guard count > 0 else { return [] }
        let band = total / CGFloat(count)

        func lerp(_ range: ClosedRange<CGFloat>, _ t: CGFloat) -> CGFloat { range.lowerBound + (range.upperBound - range.lowerBound) * t }
        func y(at position: CGFloat) -> CGFloat {
            var rest = position
            for (from, to) in room {
                if rest <= to - from { return from + rest }
                rest -= to - from
            }
            return room[room.count - 1].1
        }

        return scenes.prefix(count).enumerated().map { slot, scene in
            let draw = draws[scene]
            let side = lerp(sizes, draw.size).rounded()
            let dx = lerp(-wander.width...wander.width, draw.dx).rounded()
            let dy = lerp(-wander.height...wander.height, draw.dy).rounded()
            let centreY = y(at: band * CGFloat(slot) + (0.2 + 0.6 * draw.y) * band)
            // Clear of whatever is beside it, its wander included.
            let span = side / 2 + abs(dy) + M.margin
            let inner = avoid.filter { $0.minY < centreY + span && $0.maxY > centreY - span && $0.height > 0 }.map(\.minX).min()
            var low = edge + side * (0.5 - tuck) + abs(dx)
            var high = (inner ?? size.width / 2) - M.margin - side / 2 - abs(dx)
            if regular {
                let from = max(low, size.width * M.across.lowerBound), to = min(high, size.width * M.across.upperBound)
                if from <= to { low = from; high = to }
            } else {
                // A phone's hugs its edge.
                high = min(high, edge + strip - M.margin - side / 2 - abs(dx))
            }
            high = max(low, high)
            let centreX = lerp(low...high, draw.x)
            return Item(
                scene: scene,
                frame: CGRect(x: centreX - side / 2, y: centreY - side / 2, width: side, height: side),
                offset: CGVector(dx: dx, dy: dy),
                delay: TimeInterval(lerp(M.delays, draw.delay)),
                duration: TimeInterval(lerp(M.durations, draw.duration))
            )
        }
    }
}
