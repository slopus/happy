import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A bot's or task's row carried by a finger in home's list: its picture
/// lifted over the list follows the finger up and down, never out of the
/// list's view; it passes a peer when its middle passes the peer's; and
/// held near the view's top or bottom it scrolls the list that way, faster
/// the nearer the edge.
public enum SidebarCarryLayout {
    /// The lifted picture's growth, as iOS lifts a dragged cell.
    public static let liftScale: CGFloat = 1.03
    /// The lifted picture's shadow.
    public static let shadowRadius: CGFloat = 14
    public static let shadowOpacity: Float = 0.18
    public static let shadowOffset: CGFloat = 6
    /// How far into the view from its top or bottom a held row scrolls it,
    /// and how fast at the very edge (points a second).
    public static let edgeZone: CGFloat = 72
    public static let edgeSpeed: CGFloat = 900
    /// A finger held on a row moves this far before the row lifts.
    public static let liftDistance: CGFloat = 10

    /// The lifted picture's frame: the row's `box` (its frame in the view
    /// when lifted, `grab` the finger's height in it) under the finger at
    /// `finger`, kept between `top` and `bottom`, the part of the view the
    /// list shows.
    public static func frame(box: CGRect, grab: CGFloat, finger: CGFloat, top: CGFloat, bottom: CGFloat) -> CGRect {
        let highest = top, lowest = max(top, bottom - box.height)
        return CGRect(x: box.minX, y: min(max(finger - grab, highest), lowest), width: box.width, height: box.height)
    }

    /// The carried row's place among its peers (0: first), with its middle
    /// at `center`: past every peer whose middle it is below. `peers`: each
    /// other peer's span (its row and what nests under it), top first, in
    /// the same coordinates.
    public static func place(center: CGFloat, peers: [ClosedRange<CGFloat>]) -> Int {
        peers.filter { ($0.lowerBound + $0.upperBound) / 2 < center }.count
    }

    /// How fast the list scrolls under a carried row at `frame` (points a
    /// second, negative toward its top) in a view showing the list between
    /// `top` and `bottom`.
    public static func scrollSpeed(frame: CGRect, top: CGFloat, bottom: CGFloat) -> CGFloat {
        let into = { (depth: CGFloat) in min(1, max(0, depth / edgeZone)) }
        let up = into(top + edgeZone - frame.minY)
        let down = into(frame.maxY - (bottom - edgeZone))
        if up > 0, up >= down { return -(edgeSpeed * up * up).rounded() }
        if down > 0 { return (edgeSpeed * down * down).rounded() }
        return 0
    }
}
