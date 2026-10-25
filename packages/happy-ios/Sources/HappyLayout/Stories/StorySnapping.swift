import Foundation

/// Where an overlay being dragged or turned settles, as Telegram's media
/// editor snaps entities and API.md "Haptics" sets the lines: its centre
/// onto the canvas's centre lines, a sticker's edges onto lines 1/20 of the
/// width in from the canvas's edges, and its angle onto a multiple of 45°.
/// It snaps within 2% of the width (2° for the angle) and stays until
/// pulled twice as far, so a finger near a line isn't nudged back and forth.
public struct StorySnapper: Equatable, Sendable {
    public enum Guide: Equatable, Hashable, Sendable {
        case centerX, centerY, left, right, top, bottom
    }

    public struct Result: Equatable, Sendable {
        public var center: CGPoint
        public var rotation: CGFloat
        /// The lines it sits on, to draw.
        public var guides: Set<Guide>
        /// Its angle is held on a multiple of 45°, to draw.
        public var turned: Bool
        /// It reached a line or an angle it wasn't on before: a tick.
        public var snapped: Bool
    }

    public static let distance: CGFloat = 0.02
    public static let inset: CGFloat = 1.0 / 20
    public static let angle: CGFloat = 2 * .pi / 180
    public static let step: CGFloat = .pi / 4

    private var x: (guide: Guide, value: CGFloat)?
    private var y: (guide: Guide, value: CGFloat)?
    private var turn: CGFloat?

    public init() {}

    public static func == (a: StorySnapper, b: StorySnapper) -> Bool {
        a.x?.guide == b.x?.guide && a.x?.value == b.x?.value && a.y?.guide == b.y?.guide && a.y?.value == b.y?.value && a.turn == b.turn
    }

    /// Lets go of every line, as lifting the finger does.
    public mutating func reset() { x = nil; y = nil; turn = nil }

    /// Holds the lines an overlay already sits on as a finger lands on it,
    /// so the first move doesn't tick for them.
    public mutating func begin(center: CGPoint, half: CGSize, rotation: CGFloat, canvas: CGSize, edges: Bool) {
        reset()
        _ = snap(center: center, half: half, rotation: rotation, canvas: canvas, edges: edges)
    }

    /// The settled place for a proposed `center` and `rotation` (canvas
    /// points and radians) of an overlay whose box, turned, reaches `half`
    /// out from its centre. `edges` snaps its edges too (stickers).
    public mutating func snap(center: CGPoint, half: CGSize, rotation: CGFloat, canvas: CGSize, edges: Bool) -> Result {
        let reach = canvas.width * Self.distance
        let inset = canvas.width * Self.inset
        var xs: [(Guide, CGFloat)] = [(.centerX, canvas.width / 2)]
        var ys: [(Guide, CGFloat)] = [(.centerY, canvas.height / 2)]
        if edges {
            xs += [(.left, inset + half.width), (.right, canvas.width - inset - half.width)]
            ys += [(.top, inset + half.height), (.bottom, canvas.height - inset - half.height)]
        }
        var snapped = false
        let settledX = Self.settle(center.x, held: &x, candidates: xs, reach: reach, snapped: &snapped)
        let settledY = Self.settle(center.y, held: &y, candidates: ys, reach: reach, snapped: &snapped)
        let settledTurn = Self.settle(rotation, held: &turn, reach: Self.angle, snapped: &snapped)
        var guides = Set<Guide>()
        if let x { guides.insert(x.guide) }
        if let y { guides.insert(y.guide) }
        return Result(center: CGPoint(x: settledX, y: settledY), rotation: settledTurn, guides: guides, turned: turn != nil, snapped: snapped)
    }

    private static func settle(_ value: CGFloat, held: inout (guide: Guide, value: CGFloat)?, candidates: [(Guide, CGFloat)], reach: CGFloat, snapped: inout Bool) -> CGFloat {
        if let current = held {
            // The line may have moved with the overlay's size; follow it.
            let line = candidates.first { $0.0 == current.guide }?.1 ?? current.value
            if abs(value - line) <= 2 * reach {
                held = (current.guide, line)
                return line
            }
            held = nil
        }
        guard let nearest = candidates.min(by: { abs(value - $0.1) < abs(value - $1.1) }), abs(value - nearest.1) <= reach else { return value }
        held = nearest
        snapped = true
        return nearest.1
    }

    private static func settle(_ rotation: CGFloat, held: inout CGFloat?, reach: CGFloat, snapped: inout Bool) -> CGFloat {
        if let current = held {
            if abs(rotation - current) <= 2 * reach { return current }
            held = nil
        }
        let nearest = (rotation / step).rounded() * step
        guard abs(rotation - nearest) <= reach else { return rotation }
        held = nearest
        snapped = true
        return nearest
    }

    /// How far a box of `size`, turned by `rotation`, reaches from its centre.
    public static func half(_ size: CGSize, rotation: CGFloat) -> CGSize {
        let c = abs(cos(rotation)), s = abs(sin(rotation))
        return CGSize(width: (size.width * c + size.height * s) / 2, height: (size.width * s + size.height * c) / 2)
    }
}
