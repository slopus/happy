import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The chat list's geometry, in the list's own (flipped) content space.
///
/// The list is inverted, as happy-app's ChatList.tsx and Telegram's history
/// list are: content y grows from the newest message towards the oldest, and
/// the view is flipped so y = 0 is the bottom of the screen. Row 0 is the
/// newest. That makes the newest edge the scroll origin, so the keyboard,
/// the composer and history loading never have to move what the reader sees.
///
///     y = 0            newer end (ChatFooter)
///     newerEnd         row 0   (newest)
///     …                row 1 …
///     contentHeight    older end (spinner / Load more), then the far edge
///
/// Every row's height is known before it is inserted: rows are measured off
/// the main thread first, so nothing here is an estimate.
public struct ChatListLayout: Equatable, Sendable {
    public private(set) var width: CGFloat
    public private(set) var heights: [CGFloat]
    public private(set) var newerEndHeight: CGFloat
    public private(set) var olderEndHeight: CGFloat
    /// `starts[i]` is row i's minY; `starts[count]` is where the older end starts.
    private var starts: [CGFloat]

    public init(width: CGFloat, heights: [CGFloat], newerEndHeight: CGFloat = 0, olderEndHeight: CGFloat = 0) {
        self.width = max(0, width)
        self.heights = heights.map { max(0, $0) }
        self.newerEndHeight = max(0, newerEndHeight)
        self.olderEndHeight = max(0, olderEndHeight)
        self.starts = []
        rebuild()
    }

    private mutating func rebuild() {
        var starts = [CGFloat]()
        starts.reserveCapacity(heights.count + 1)
        var y = newerEndHeight
        for height in heights {
            starts.append(y)
            y += height
        }
        starts.append(y)
        self.starts = starts
    }

    public var count: Int { heights.count }

    public var contentHeight: CGFloat { (starts.last ?? newerEndHeight) + olderEndHeight }

    public var contentSize: CGSize { CGSize(width: width, height: contentHeight) }

    public func frame(ofRow index: Int) -> CGRect {
        CGRect(x: 0, y: starts[index], width: width, height: heights[index])
    }

    public var newerEndFrame: CGRect {
        CGRect(x: 0, y: 0, width: width, height: newerEndHeight)
    }

    public var olderEndFrame: CGRect {
        CGRect(x: 0, y: starts.last ?? newerEndHeight, width: width, height: olderEndHeight)
    }

    /// Rows that intersect `minY..<maxY`, found by binary search so a long
    /// chat costs O(log n) per scroll frame.
    public func rows(from minY: CGFloat, to maxY: CGFloat) -> Range<Int> {
        guard !heights.isEmpty, maxY > minY else { return 0..<0 }
        let first = firstRow(endingAfter: minY)
        var last = first
        while last < heights.count, starts[last] < maxY { last += 1 }
        return first..<max(first, last)
    }

    /// The first row whose bottom is past `y`.
    public func firstRow(endingAfter y: CGFloat) -> Int {
        var low = 0
        var high = heights.count
        while low < high {
            let mid = (low + high) / 2
            if starts[mid] + heights[mid] <= y {
                low = mid + 1
            } else {
                high = mid
            }
        }
        return low
    }

    /// A copy with one row's height changed, rebuilt in O(n).
    public func replacingHeight(at index: Int, with height: CGFloat) -> ChatListLayout {
        var copy = self
        copy.heights[index] = max(0, height)
        copy.rebuild()
        return copy
    }
}

/// Keeps what the reader is looking at in place across a list update.
///
/// Telegram keeps a "stationary" row fixed while it applies a transaction.
/// This is the same rule for a flipped UICollectionView:
///   - a reader at the newest edge (within `followThreshold`, happy-app's
///     `autoscrollToTopThreshold`) stays at the newest edge, so new and
///     streaming messages carry them along;
///   - a reader further back keeps the row at the bottom of their screen at
///     the same distance from that edge, whatever was inserted, removed or
///     resized before it.
///
/// Offsets here are "visible min y": the content y at the bottom edge of
/// the visible area, `contentOffset.y + adjustedContentInset.top` in the
/// flipped collection view. 0 means the newest edge is showing.
public struct ChatScrollAnchor: Equatable, Sendable {
    public static let followThreshold: CGFloat = 200

    public enum Kind: Equatable, Sendable {
        case newest
        /// The row's near edge (its bottom on screen) stays this far from
        /// the visible min y.
        case row(id: String, distance: CGFloat)
        /// The row's far edge (its top on screen) stays this far from the
        /// visible min y.
        case rowEnd(id: String, distance: CGFloat)
    }

    public var kind: Kind

    public init(kind: Kind) {
        self.kind = kind
    }

    /// Notes where the reader is before an update. `follow` is false while
    /// the reader's finger is on the list: snapping to the newest edge then
    /// would fight the drag, so even near it the row under them holds.
    public static func capture(layout: ChatListLayout, ids: [String], visibleMinY: CGFloat, follow: Bool = true) -> ChatScrollAnchor {
        if layout.count == 0 || (follow && visibleMinY <= followThreshold) {
            return ChatScrollAnchor(kind: .newest)
        }
        let index = min(layout.firstRow(endingAfter: visibleMinY), layout.count - 1)
        let frame = layout.frame(ofRow: index)
        return ChatScrollAnchor(kind: .row(id: ids[index], distance: frame.minY - visibleMinY))
    }

    /// Holds one row's top on screen where it is: a row the reader just
    /// opened grows down towards the newest messages, under their finger,
    /// as a table row would, instead of pushing what they tapped up. A
    /// reader at the newest edge stays there and the row grows upwards, so
    /// what opened is on screen. Nil when the row isn't there.
    public static func pinning(_ id: String, layout: ChatListLayout, ids: [String], visibleMinY: CGFloat) -> ChatScrollAnchor? {
        guard let index = ids.firstIndex(of: id), index < layout.count else { return nil }
        if visibleMinY <= 0.5 { return ChatScrollAnchor(kind: .newest) }
        return ChatScrollAnchor(kind: .rowEnd(id: id, distance: layout.frame(ofRow: index).maxY - visibleMinY))
    }

    /// Where the visible min y goes when the inset at the newest edge
    /// changes by `delta` (the keyboard, the dock growing).
    ///
    /// Left alone, the reader keeps what they see at the newest edge: it
    /// rides up or down with the dock, inside the keyboard's animation.
    /// Under the reader's finger the content stays where the finger has it:
    /// the offset doesn't move, so the change only adds or takes away that
    /// much to scroll back. Telegram's list keeps its anchor only when not
    /// tracking, too. During an interactive dismiss the keyboard follows the
    /// finger, and keeping the anchor would add the keyboard's travel to the
    /// drag's: the conversation would run at twice the finger's speed.
    public static func visibleMinY(afterNewestInsetChange delta: CGFloat, from visibleMinY: CGFloat, maxVisibleMinY: CGFloat, tracking: Bool) -> CGFloat {
        if tracking { return visibleMinY + delta }
        return min(max(0, visibleMinY), max(0, maxVisibleMinY))
    }

    /// Where the visible min y must be after the update. `maxVisibleMinY`
    /// is the furthest the list can scroll (content height minus the
    /// visible height), so the anchor never asks for an overscroll.
    public func visibleMinY(in layout: ChatListLayout, ids: [String], current: CGFloat, maxVisibleMinY: CGFloat) -> CGFloat {
        switch kind {
        case .newest:
            return 0
        case .row(let id, let distance):
            guard let index = ids.firstIndex(of: id) else { return min(current, max(0, maxVisibleMinY)) }
            let target = layout.frame(ofRow: index).minY - distance
            return min(max(0, target), max(0, maxVisibleMinY))
        case .rowEnd(let id, let distance):
            guard let index = ids.firstIndex(of: id) else { return min(current, max(0, maxVisibleMinY)) }
            let target = layout.frame(ofRow: index).maxY - distance
            return min(max(0, target), max(0, maxVisibleMinY))
        }
    }
}
