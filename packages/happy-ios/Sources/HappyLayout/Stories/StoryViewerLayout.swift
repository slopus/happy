import Foundation

/// The full-screen viewer, as Telegram's `StoryItemSetContainerComponent`
/// lays one author out: the canvas under the status bar with 12 rounded
/// corners, the progress strip 8 inside its top (2 tall, 3 between
/// segments), the author's 32 avatar 12 in and 18 down with their name and
/// the time beside it, the 50 × 64 close button at the top right, and the
/// bar below the canvas: the heart (or, on one's own story, its views).
public struct StoryViewerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let cornerRadius: CGFloat = 12
        public static let stripInset: CGFloat = 8
        public static let stripHeight: CGFloat = 2
        public static let stripSpacing: CGFloat = 3
        public static let minSegment: CGFloat = 2
        public static let avatar: CGFloat = 32
        public static let avatarOrigin = CGPoint(x: 12, y: 18)
        public static let nameGap: CGFloat = 10
        public static let close = CGSize(width: 50, height: 64)
        public static let bar: CGFloat = 52
        public static let barButton: CGFloat = 44
        public static let barInset: CGFloat = 8
        /// The thirds a tap goes back or forward in.
        public static let backFraction: CGFloat = 1.0 / 3.0
    }

    public var canvas: CGRect
    public var strip: CGRect
    public var avatar: CGRect
    /// Name and time, left aligned from here, two lines.
    public var titleOrigin: CGPoint
    public var titleWidth: CGFloat
    public var close: CGRect
    public var more: CGRect
    /// The bar under the canvas; empty when the canvas reaches the bottom.
    public var bar: CGRect
    public var heart: CGRect
    /// One's own story: the views button at the bar's left.
    public var views: CGRect

    public init(size: CGSize, safeArea: LayoutInsets) {
        typealias M = Metrics
        let available = CGRect(x: 0, y: safeArea.top, width: size.width, height: max(0, size.height - safeArea.top - safeArea.bottom - M.bar))
        canvas = StoryCanvasLayout.fit(in: available)
        strip = CGRect(x: canvas.minX + M.stripInset, y: canvas.minY + M.stripInset, width: max(0, canvas.width - 2 * M.stripInset), height: M.stripHeight)
        avatar = CGRect(x: canvas.minX + M.avatarOrigin.x, y: canvas.minY + M.avatarOrigin.y, width: M.avatar, height: M.avatar)
        close = CGRect(x: canvas.maxX - M.close.width, y: canvas.minY + 2, width: M.close.width, height: M.close.height)
        more = close.offsetBy(dx: -M.close.width + 8, dy: 0)
        titleOrigin = CGPoint(x: avatar.maxX + M.nameGap, y: avatar.minY - 1)
        titleWidth = max(0, more.minX - titleOrigin.x)
        let barTop = canvas.maxY
        bar = CGRect(x: 0, y: barTop, width: size.width, height: max(0, size.height - safeArea.bottom - barTop))
        let buttonY = barTop + (min(bar.height, M.bar) - M.barButton) / 2
        heart = CGRect(x: canvas.maxX - M.barInset - M.barButton, y: buttonY, width: M.barButton, height: M.barButton)
        views = CGRect(x: canvas.minX + M.barInset, y: buttonY, width: max(0, canvas.width / 2), height: M.barButton)
    }

    /// The progress segments, one per frame, across `strip`.
    public static func segments(_ count: Int, in strip: CGRect) -> [CGRect] {
        typealias M = Metrics
        guard count > 0 else { return [] }
        let ideal = (strip.width - CGFloat(count - 1) * M.stripSpacing) / CGFloat(count)
        let width = max(M.minSegment, ideal)
        return (0..<count).map { CGRect(x: strip.minX + CGFloat($0) * (width + M.stripSpacing), y: strip.minY, width: width, height: strip.height) }
    }

    /// What a tap at `x` on the canvas does.
    public enum Tap: Equatable, Sendable { case back, forward }

    public func tap(at x: CGFloat) -> Tap {
        x < canvas.minX + canvas.width * Metrics.backFraction ? .back : .forward
    }
}

/// The turn between two authors: a cube, as Telegram's
/// `StoryContainerScreen` draws it, with a perspective of 500.
public enum StoryCube {
    public static let perspective: CGFloat = 500

    /// The angle a side turns for `fraction` of the way (-1…1) to the next.
    public static func angle(_ fraction: CGFloat) -> CGFloat {
        max(-1, min(1, fraction)) * .pi / 2
    }
}
