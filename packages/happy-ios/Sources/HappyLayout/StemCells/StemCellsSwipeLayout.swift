import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A sidebar row swiped open from the trailing edge: its actions stand
/// side by side at the box's right, each `actionWidth` wide and as tall as
/// the box, in the order given (the last at the edge); the row slides left
/// by how far it was pulled, and a pull past them stretches with a third of
/// the extra.
public struct StemCellsSwipeLayout: Equatable, Sendable {
    public static let actionWidth: CGFloat = 76
    /// Pulled past this share of the actions, a release opens them.
    public static let opensAt: CGFloat = 0.5
    public static let rubber: CGFloat = 1.0 / 3

    /// The actions in the row box's own space.
    public var actions: [CGRect]
    /// How far the row slides, left.
    public var offset: CGFloat

    public init(box: CGSize, actions count: Int, pull: CGFloat) {
        let total = CGFloat(count) * Self.actionWidth
        let pulled = max(0, pull)
        offset = (pulled > total ? total + (pulled - total) * Self.rubber : pulled).rounded()
        // The actions share whatever the row uncovers, so a stretched pull widens them.
        let width = count == 0 ? 0 : max(total, offset) / CGFloat(count)
        actions = (0..<count).map { index in
            CGRect(x: (box.width - CGFloat(count - index) * width).rounded(), y: 0, width: width.rounded(), height: box.height)
        }
    }

    public static func width(actions count: Int) -> CGFloat { CGFloat(count) * actionWidth }

    /// Whether a release at `pull` moving at `velocity` (points a second,
    /// leftward positive) leaves the actions open.
    public static func opens(pull: CGFloat, velocity: CGFloat, actions count: Int) -> Bool {
        if velocity > 400 { return true }
        if velocity < -400 { return false }
        return pull >= width(actions: count) * opensAt
    }
}
