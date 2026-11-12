import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A machine's name and description as Settings' cards hold them, for
/// adding a machine and editing one: each field in a card of its own, its
/// name over the card and its hint under it, as Settings' groups have
/// them. The description's card is a few lines tall, and the text scrolls
/// inside it past that.
public struct ComputeFormLayout: Equatable, Sendable {
    public enum Metrics {
        public static let top: CGFloat = 24
        public static let nameCard: CGFloat = SettingsLayout.Metrics.row
        public static let descriptionCard: CGFloat = 148
        /// The description's text this far in from its card's edges.
        public static let textInset: CGFloat = 14
    }

    public var nameHeader: CGRect
    public var nameCard: CGRect
    public var nameField: CGRect
    public var nameHint: CGRect
    public var descriptionHeader: CGRect
    public var descriptionCard: CGRect
    public var descriptionText: CGRect
    /// Its first line, where the placeholder sits while it is empty.
    public var descriptionPlaceholder: CGRect
    public var descriptionHint: CGRect
    public var contentHeight: CGFloat

    /// On a page `width` wide; `header` is a group name's line height and
    /// `line` the text's, the hints are measured at
    /// `SettingsLayout.footerWidth(width)`; a hidden one is 0, and its gap
    /// goes with it.
    public init(width: CGFloat, header: CGFloat, line: CGFloat, nameHint: CGFloat, descriptionHint: CGFloat) {
        typealias M = Metrics
        typealias S = SettingsLayout.Metrics
        let cardWidth = max(0, width - 2 * S.side)
        let textX = S.side + S.footerInset
        let textWidth = SettingsLayout.footerWidth(width)
        nameHeader = CGRect(x: textX, y: M.top, width: textWidth, height: header)
        nameCard = CGRect(x: S.side, y: nameHeader.maxY + S.headerGap, width: cardWidth, height: M.nameCard)
        nameField = CGRect(x: nameCard.minX + S.plainTextX, y: nameCard.minY, width: max(0, cardWidth - S.plainTextX - S.trailing), height: M.nameCard)
        self.nameHint = CGRect(x: textX, y: nameCard.maxY + S.footerGap, width: textWidth, height: nameHint)
        let nameBottom = nameHint > 0 ? self.nameHint.maxY : nameCard.maxY
        descriptionHeader = CGRect(x: textX, y: nameBottom + S.cardGap, width: textWidth, height: header)
        descriptionCard = CGRect(x: S.side, y: descriptionHeader.maxY + S.headerGap, width: cardWidth, height: M.descriptionCard)
        descriptionText = descriptionCard.insetBy(dx: S.plainTextX, dy: M.textInset)
        descriptionPlaceholder = CGRect(x: descriptionText.minX, y: descriptionText.minY, width: descriptionText.width, height: line)
        self.descriptionHint = CGRect(x: textX, y: descriptionCard.maxY + S.footerGap, width: textWidth, height: descriptionHint)
        contentHeight = self.descriptionHint.maxY + S.bottom
    }
}
