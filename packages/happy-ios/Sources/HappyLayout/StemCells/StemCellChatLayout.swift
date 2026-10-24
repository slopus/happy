import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// MakeStuffView.tsx's intro, the first row of new work's conversation: the
/// 64px mark centred over one line, 16 apart and 16 inside the row
/// (`.happy-make-stuff__empty`, `__lead`). Once the conversation has begun
/// (`settled`) the line keeps its place, hidden, and the row ends right
/// under it (`[data-settled] { padding-bottom: 0 }`), where the first
/// message lands.
public struct MakeStuffIntroLayout: Equatable, Sendable {
    public enum Metrics {
        public static let inset: CGFloat = 16
        public static let mark: CGFloat = 64
        public static let gap: CGFloat = 16
    }

    public var size: CGSize
    public var mark: CGRect
    public var line: CGRect

    /// `line` is the intro line's text, centred, wrapping inside the row.
    public init(width: CGFloat, line: Measurable, settled: Bool = false) {
        typealias M = Metrics
        let measure = max(0, width - 2 * M.inset)
        let lineSize = line.size(fitting: measure)
        mark = CGRect(x: (width - M.mark) / 2, y: M.inset, width: M.mark, height: M.mark)
        self.line = CGRect(x: M.inset, y: mark.maxY + M.gap, width: measure, height: lineSize.height)
        // Nothing is offered here on the phone: before the conversation the
        // row ends 16 under its line, as an intro with no options does.
        size = CGSize(width: max(0, width), height: self.line.maxY + (settled ? 0 : M.inset))
    }
}

/// The conversation screen: the transcript under the bar, and the composer
/// card 8 in from the sides and 8 above the keyboard, or above the safe
/// area while the keyboard is down.
public struct StemCellChatScreenLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 8
        public static let paddingBottom: CGFloat = 8
        /// Room between the newest row and the card.
        public static let listGap: CGFloat = 8
    }

    public var card: CGRect
    /// The transcript's insets inside the whole screen.
    public var listTop: CGFloat
    public var listBottom: CGFloat
    /// The height between those insets, which short content rests at the foot of.
    public var viewport: CGFloat

    /// `keyboardTop` is the keyboard guide's top in the screen.
    public init(size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat, cardHeight: (CGFloat) -> CGFloat) {
        typealias M = Metrics
        let width = max(0, size.width - 2 * M.paddingH)
        let height = cardHeight(width)
        let foot = min(keyboardTop, size.height - safeArea.bottom)
        card = CGRect(x: M.paddingH, y: foot - M.paddingBottom - height, width: width, height: height)
        listTop = safeArea.top
        listBottom = max(0, size.height - card.minY + M.listGap)
        viewport = max(0, size.height - listTop - listBottom)
    }
}

/// The conversation's rows stacked in a scroll view: newest last, resting
/// on the composer while they are shorter than the screen, as a chat does.
public struct StemCellChatStackLayout: Equatable, Sendable {
    public var frames: [CGRect]
    public var contentHeight: CGFloat

    /// `heights` top to bottom; `viewport` is the height between the top
    /// inset and the composer, which short content rests at the foot of.
    public init(heights: [CGFloat], width: CGFloat, viewport: CGFloat) {
        let total = heights.reduce(0, +)
        var y = max(0, viewport - total)
        var frames: [CGRect] = []
        frames.reserveCapacity(heights.count)
        for height in heights {
            frames.append(CGRect(x: 0, y: y, width: width, height: height))
            y += height
        }
        self.frames = frames
        contentHeight = max(viewport, total)
    }
}
