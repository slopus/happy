import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Stories' frames: the outline around a row's icon, which never moves
/// or resizes the row, and the full-screen viewer.
public enum StoryLayout {
    public enum Metrics {
        /// The outline stands this far outside the icon, and is this thick.
        public static let ringGap: CGFloat = 2.5
        public static let ringWidth: CGFloat = 2
        /// A tap this close to the icon opens its story.
        public static let ringSlop: CGFloat = 8
        public static let segmentHeight: CGFloat = 2
        public static let segmentGap: CGFloat = 4
        public static let inset: CGFloat = 8
        public static let mark: CGFloat = 32
        public static let markRadius: CGFloat = 8
        public static let close: CGFloat = 44
        public static let captionInset: CGFloat = 16
        /// How long a picture shows before the next story.
        public static let imageDuration: Double = 5
    }

    /// The outline's box around `mark` (its border drawn inside), a
    /// rounded square following the icon's corners.
    public static func ring(around mark: CGRect, markRadius: CGFloat) -> (frame: CGRect, radius: CGFloat) {
        let outset = Metrics.ringGap + Metrics.ringWidth
        return (mark.insetBy(dx: -outset, dy: -outset), markRadius + outset)
    }

    /// Where a tap opens the story rather than the chat: around the icon,
    /// stopping where the title (at `labelX`) starts.
    public static func ringTarget(around mark: CGRect, labelX: CGFloat) -> CGRect {
        let outset = Metrics.ringGap + Metrics.ringWidth + Metrics.ringSlop, target = mark.insetBy(dx: -outset, dy: -outset)
        return CGRect(x: target.minX, y: target.minY, width: max(0, min(target.maxX, labelX) - target.minX), height: target.height)
    }

    /// A tap at `x` in the viewer: back a story in its first third, on past it.
    public static func step(atX x: CGFloat, width: CGFloat) -> Int { x < width / 3 ? -1 : 1 }

    public struct Viewer: Equatable, Sendable {
        public var segments: [CGRect]
        public var mark: CGRect
        public var name: CGRect
        public var close: CGRect
        public var caption: CGRect
    }

    /// `nameHeight` and `captionHeight` are measured; a caption is at most `size.width - 2 × captionInset` wide.
    public static func viewer(size: CGSize, safeArea: LayoutInsets, count: Int, nameHeight: CGFloat, captionHeight: CGFloat) -> Viewer {
        typealias M = Metrics
        let top = safeArea.top + M.inset
        let lane = size.width - 2 * M.inset
        let n = CGFloat(max(count, 1))
        let segment = ((lane - (n - 1) * M.segmentGap) / n).rounded(.down)
        let segments = (0..<max(count, 1)).map { CGRect(x: M.inset + CGFloat($0) * (segment + M.segmentGap), y: top, width: segment, height: M.segmentHeight) }
        let mark = CGRect(x: M.inset + 4, y: top + M.segmentHeight + 10, width: M.mark, height: M.mark)
        let close = CGRect(x: size.width - M.inset - M.close, y: mark.midY - M.close / 2, width: M.close, height: M.close)
        let name = CGRect(x: mark.maxX + 10, y: (mark.midY - nameHeight / 2).rounded(), width: max(0, close.minX - 14 - mark.maxX), height: nameHeight)
        let caption = CGRect(x: M.captionInset, y: size.height - safeArea.bottom - M.captionInset - captionHeight, width: size.width - 2 * M.captionInset, height: captionHeight)
        return Viewer(segments: segments, mark: mark, name: name, close: close, caption: caption)
    }
}

extension Palette {
    /// A row's outline while one of its stories is unseen, and once all are.
    public static let storyUnseen = ColorToken("#007aff", "#0a84ff")
    public static let storySeen = ColorToken("#c7c7cc", "#48484a")
}
