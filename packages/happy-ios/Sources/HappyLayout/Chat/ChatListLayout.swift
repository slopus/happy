import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The chat list's geometry, measured from its newest end.
///
/// The list itself stands the natural way up, the oldest row at the top and
/// the newest at the foot, but the rows are derived newest first, so this
/// measures each row from the newest end: y grows from the newest message
/// towards the oldest. Row 0 is the newest. On screen, y = 0 is the foot of
/// the content, over the composer (`ChatListPosition`).
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

/// Where the reader is in the chat list, which stands the natural way up:
/// the oldest row at the top, the newest at the foot, resting on the
/// composer (bottom gravity). The list keeps the row the reader is looking
/// at in place by itself; this turns its frames into the distance the
/// screen reasons in, and back.
///
/// "Distance from the newest" is how far the foot of the visible area
/// (above the bottom inset) is from the newest end of the content: 0 with
/// the newest message on screen. A row's `start` is its foot's distance
/// from the newest end, `ChatListLayout.frame(ofRow:).minY`.
public enum ChatListPosition {
    /// The distance from the newest, read from one row on screen: its
    /// `start`, and its foot in the list's bounds (`rowMaxY`), in a list
    /// `viewportHeight` tall with `bottomInset` over its foot.
    public static func distanceFromNewest(rowStart: CGFloat, rowMaxY: CGFloat, viewportHeight: CGFloat, bottomInset: CGFloat) -> CGFloat {
        rowStart - (viewportHeight - bottomInset - rowMaxY)
    }

    /// Where a row's top goes, down from the top inset, for the visible
    /// area's foot to be `distance` from the newest end; `visibleHeight` is
    /// the list's height less both insets.
    public static func rowTop(rowStart: CGFloat, rowHeight: CGFloat, distance: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        visibleHeight - (rowStart - distance) - rowHeight
    }
}

/// How far the list follows a message growing at its foot by itself before
/// it stops: two lines of the chat's body text, at the person's text size.
/// Past that, the message goes on growing below the fold until the reader
/// scrolls; their own sends are always brought fully into view.
public enum ChatFollow {
    public static let lines: CGFloat = 2

    /// `lines` of `body` at `scale`. A style without a fixed line height
    /// counts its font size.
    public static func budget(body: ChatTextStyle, scale: TextScale) -> CGFloat {
        let style = body.scaled(scale)
        return lines * (style.lineHeight ?? style.size)
    }
}
