#if canImport(UIKit)
import HappyLayout
import UIKit
import UltraView

/// A row's plan made again at another width, for UltraView's in-place
/// resize (`ListRow.prepareInPlace`): a width change lays the rows on screen
/// out again in the frame it shows, before the screen has planned them at
/// that width. The node row's factory makes the plan off the main thread
/// and leaves it here; the row's view takes it with the drawing, so its
/// fills and live views stand where the new drawing puts things. The
/// screen's own plan at that width replaces it.
final class ReplannedAtWidth<Plan: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var made: (width: Double, plan: Plan)?

    func store(_ plan: Plan, width: Double) { lock.withLock { made = (width, plan) } }

    /// The plan made at `width`, if one was.
    func plan(at width: Double) -> Plan? {
        lock.withLock { made.flatMap { abs($0.width - width) <= 0.5 ? $0.plan : nil } }
    }
}

/// A list's rows made again at another width all at once, for rows that are
/// laid out together (a sidebar's cards, a screen's card list): the first
/// row to ask at a width makes them all, off the main thread, and the
/// others take theirs.
final class ListReplan<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private let make: @Sendable (CGFloat) -> [String: Value]
    private var made: (width: CGFloat, values: [String: Value])?

    init(_ make: @escaping @Sendable (CGFloat) -> [String: Value]) { self.make = make }

    func value(_ id: String, width: CGFloat) -> Value? {
        lock.withLock {
            if let made, abs(made.width - width) <= 0.5 { return made.values[id] }
            let values = make(width)
            made = (width, values)
            return values[id]
        }
    }

    /// The value made at `width`, if the rows were made there; never makes
    /// them, so the main thread can ask.
    func made(_ id: String, width: CGFloat) -> Value? {
        lock.withLock { made.flatMap { abs($0.width - width) <= 0.5 ? $0.values[id] : nil } }
    }
}

extension UltraListView {
    /// Gives the list `frame` and lays it out now: a change of width alone
    /// relays the rows out in place, at the new width in this frame and on
    /// the curve of the animation the change is in. Called before an apply
    /// that also brings rows or insets, which would take an ordinary pass
    /// instead and show the rows at the new width only once they are
    /// measured there.
    func resize(to frame: CGRect) {
        if self.frame != frame { self.frame = frame }
        layoutIfNeeded()
    }
}

extension UltraListView {
    /// Where a touch that lands on a list's container, in the margins it
    /// leaves beside the list (`UIView.sidesBand`), goes: to the list's own
    /// drag, so the list scrolls from the screen's edge as from its rows.
    /// The container returns this from `hitTest`.
    func takingMargins(_ hit: UIView?, of container: UIView) -> UIView? {
        hit === container ? scrollGestureHostView : hit
    }
}

extension UIView {
    /// This view less the safe area's sides (`LayoutInsets.sides(of:)`):
    /// where a list it holds stands, so a phone held sideways keeps the
    /// rows off the camera and the corners while the view runs edge to edge.
    var sidesBand: CGRect { LayoutInsets(safeAreaInsets).sides(of: bounds.size) }
}
#endif
