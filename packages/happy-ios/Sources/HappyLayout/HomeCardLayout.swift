import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Home's session list in the modern home's inset cards
/// (`GroupedSidebarMetrics`): a row's content is laid out at the card's
/// width and stands in the card, `side` in from the list's edges. The
/// card's first row rounds its top corners and its last row the bottom
/// ones; a hairline runs under a row from where its text starts to the
/// card's edge, but not under the card's last row.
///
///     |16| card ………………………………………………………………………… |16|
///         |16| avatar |12| title ………………… |16|
///         ………………… hairline from the title to the card's edge
public struct HomeCardLayout: Equatable, Sendable {
    public enum Metrics {
        public static let side: CGFloat = GroupedSidebarMetrics.side
        public static let radius: CGFloat = GroupedSidebarMetrics.radius
        /// Between two cards: a section's gap.
        public static let gap: CGFloat = GroupedSidebarMetrics.cardGap
        /// A flat session's avatar in a card, smaller than the plain list's
        /// 60 (`FlatSessionRowLayout.Metrics.avatarSize`).
        public static let sessionAvatar: CGFloat = 40
    }

    /// The card's part in the row, in the row's coordinates.
    public var card: CGRect
    public var roundsTop: Bool
    public var roundsBottom: Bool
    /// In the card's coordinates.
    public var separator: CGRect?

    /// The width a row's content is laid out at in a list this wide.
    public static func contentWidth(_ width: CGFloat) -> CGFloat {
        max(0, width - 2 * Metrics.side)
    }

    /// `separatorX` is where the row's text starts in the card; nil for no
    /// hairline. A `side` of 0 makes the card the whole row.
    public init(width: CGFloat, height: CGFloat, roundsTop: Bool, roundsBottom: Bool, separatorX: CGFloat?, hairline: CGFloat, side: CGFloat = Metrics.side) {
        let cardWidth = max(0, width - 2 * side)
        card = CGRect(x: side, y: 0, width: cardWidth, height: max(0, height))
        self.roundsTop = roundsTop
        self.roundsBottom = roundsBottom
        separator = separatorX.map { x in
            CGRect(x: x, y: max(0, height) - hairline, width: max(0, cardWidth - x), height: hairline)
        }
    }
}
