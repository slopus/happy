import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The stand-in composer the chat ships until the real one lands: a rounded
/// card, 8 in from the sides and 8 above the dock's bottom, holding a text
/// view that grows to five lines and a send button in its bottom-right
/// corner.
///
///      8 ┌ card ───────────────────────────────── r 20 ┐ 8
///        │ 14  text (grows, then scrolls)   6 [send 32] 6│
///        └ 8 above and below the text ──────────────────┘
///      8
public struct ComposerPlaceholderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginH: CGFloat = 8
        public static let marginTop: CGFloat = 4
        public static let marginBottom: CGFloat = 8
        public static let radius: CGFloat = 20
        public static let textPaddingLeft: CGFloat = 14
        public static let textPaddingV: CGFloat = 8
        public static let buttonSize: CGFloat = 32
        public static let buttonInset: CGFloat = 6
        public static let buttonGap: CGFloat = 6
        public static let maxLines: CGFloat = 5
    }

    public var size: CGSize
    public var card: CGRect
    public var text: CGRect
    public var sendButton: CGRect
    /// True once the text is taller than the card lets it be.
    public var textScrolls: Bool

    /// `textHeight` is the text's full height at `textWidth(for:)`, and
    /// `lineHeight` one line of it.
    public init(width: CGFloat, textHeight: CGFloat, lineHeight: CGFloat) {
        typealias M = Metrics
        let width = max(0, width)
        let cardWidth = max(0, width - 2 * M.marginH)
        let maxText = lineHeight * M.maxLines
        let shownText = min(max(lineHeight, textHeight), maxText)
        textScrolls = textHeight > maxText
        let cardHeight = max(M.buttonSize + 2 * M.buttonInset, shownText + 2 * M.textPaddingV)
        card = CGRect(x: M.marginH, y: M.marginTop, width: cardWidth, height: cardHeight)
        text = CGRect(
            x: card.minX + M.textPaddingLeft,
            y: card.minY + (cardHeight - shownText) / 2,
            width: Self.textWidth(for: width),
            height: shownText
        )
        sendButton = CGRect(
            x: card.maxX - M.buttonInset - M.buttonSize,
            y: card.maxY - M.buttonInset - M.buttonSize,
            width: M.buttonSize,
            height: M.buttonSize
        )
        size = CGSize(width: width, height: M.marginTop + cardHeight + M.marginBottom)
    }

    /// The width the text wraps at in a composer `width` wide.
    public static func textWidth(for width: CGFloat) -> CGFloat {
        typealias M = Metrics
        return max(0, width - 2 * M.marginH - M.textPaddingLeft - M.buttonGap - M.buttonSize - M.buttonInset)
    }
}
