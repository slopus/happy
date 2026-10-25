import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Telegram's one-time "Tap above to view stories from …" under the avatars
/// closed into the title (`TooltipScreen`, default style, arrow at the
/// top): a bubble 12 in from the screen's sides at most, 11 × 8 around 14pt
/// text wrapped as evenly as its lines allow, 12.5 rounded, with a 29 × 10
/// arrow pointing up from it, its tip at `tip`.
public struct StoriesTooltipLayout: Equatable, Sendable {
    public enum Metrics {
        public static let sideInset: CGFloat = 12
        public static let contentInset = CGSize(width: 11, height: 8)
        public static let cornerRadius: CGFloat = 12.5
        public static let arrow = CGSize(width: 29, height: 10)
        public static let maxWidth: CGFloat = 614
        public static let fontSize: CGFloat = 14
    }

    /// The bubble, without its arrow.
    public let bubble: CGRect
    public let text: CGRect
    /// The arrow's box above the bubble; its tip is the top middle.
    public let arrow: CGRect

    /// Pointing at `tip` on a screen `width` wide; `measure` gives the
    /// text's size for a width.
    public init(tip: CGPoint, width: CGFloat, measure: (CGFloat) -> CGSize) {
        let M = Metrics.self
        let room = max(0, min(width - 2 * M.sideInset, M.maxWidth) - 2 * M.contentInset.width)
        let size = Self.balanced(room: room, measure: measure)
        let textSize = CGSize(width: ceil(min(room, size.width)), height: ceil(size.height))
        let bubbleSize = CGSize(width: textSize.width + 2 * M.contentInset.width, height: textSize.height + 2 * M.contentInset.height)
        let top = tip.y + M.arrow.height
        let x = max(M.sideInset, min(width - M.sideInset - bubbleSize.width, tip.x - bubbleSize.width / 2))
        bubble = CGRect(origin: CGPoint(x: x, y: top), size: bubbleSize)
        text = CGRect(origin: CGPoint(x: x + M.contentInset.width, y: top + M.contentInset.height), size: textSize)
        // The arrow stays over the bubble, clear of its rounded corners.
        let low = bubble.minX + M.cornerRadius + M.arrow.width / 2
        let high = bubble.maxX - M.cornerRadius - M.arrow.width / 2
        let middle = low <= high ? max(low, min(high, tip.x)) : bubble.midX
        arrow = CGRect(x: middle - M.arrow.width / 2, y: tip.y, width: M.arrow.width, height: M.arrow.height)
    }

    /// The text at `room`, or as much narrower as it goes without taking
    /// another line, so a wrapped last line isn't left short.
    static func balanced(room: CGFloat, measure: (CGFloat) -> CGSize) -> CGSize {
        let full = measure(room)
        guard full.width > 0 else { return full }
        var low: CGFloat = 0
        var high = min(room, ceil(full.width))
        while high - low > 1 {
            let mid = floor((low + high) / 2)
            if measure(mid).height <= full.height { high = mid } else { low = mid }
        }
        return measure(high)
    }
}
