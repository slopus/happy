import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The reader's place through a run of layouts made again (one text size
/// after another), so it doesn't drift.
///
/// A scroll view holds its offset on the screen's pixels, so the place put
/// at an offset and found again from it is up to half a pixel off. Found
/// again at every size, that error is scaled by the next size's rows and
/// another half pixel added: three sizes in a row drifted 0.8pt at the
/// largest. While the offset is still the one the place was put at, the
/// place is the one kept; once the reader scrolls it is found again.
public struct KeptPlace<Place: Sendable>: Sendable {
    private var kept: (place: Place, offset: CGFloat)?

    public init() {}

    /// The place at `offset`: the kept one if the offset is where it was
    /// put, otherwise `find(offset)`.
    public func place(at offset: CGFloat, find: (CGFloat) -> Place?) -> Place? {
        if let kept, kept.offset == offset { return kept.place }
        return find(offset)
    }

    /// `place` was put at `offset`, as read back from the scroll view.
    public mutating func put(_ place: Place, at offset: CGFloat) {
        kept = (place, offset)
    }

    /// Anything else laid out again: the place is found from the offset next time.
    public mutating func forget() {
        kept = nil
    }
}

public enum ScrollPlace {
    /// The content offset that puts content `y` at the top of the visible
    /// area: on the nearest of the screen's pixels (`scale`), where the
    /// scroll view would hold it anyway, then inside the scrolling range.
    public static func offset(top y: CGFloat, insetTop: CGFloat, insetBottom: CGFloat, viewport: CGFloat, contentHeight: CGFloat, scale: CGFloat) -> CGFloat {
        let offset = scale > 0 ? ((y - insetTop) * scale).rounded() / scale : y - insetTop
        let lowest = -insetTop
        let highest = max(lowest, contentHeight + insetBottom - viewport)
        return min(highest, max(lowest, offset))
    }
}
