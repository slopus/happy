import Foundation

/// A row's conversation previewed by a hold, as Telegram's chat list
/// previews a chat (`ContextControllerExtractedPresentationNode`'s
/// controller content): the screen less 12 a side, at most 400 wide on a
/// regular width, and the screen's height less 12 above and below, the top
/// inset and the bottom safe area, at most 460. In it the conversation's
/// newest messages rest at the foot under its name in a capsule, 10 from
/// the top, 44 tall and 16 in on either side of the name. Above the list
/// the card's own ground covers the messages down to the capsule's foot and
/// lets them in over the next 24, so older ones go into the card unseen.
public struct StemCellsPreviewLayout: Equatable, Sendable {
    public enum Metrics {
        public static let inset: CGFloat = 12
        public static let maxWidth: CGFloat = 400
        public static let maxHeight: CGFloat = 460
        public static let pillTop: CGFloat = 10
        public static let pillHeight: CGFloat = 44
        public static let pillPadding: CGFloat = 16
        /// The least room left beside the capsule.
        public static let pillMargin: CGFloat = 16
        /// Between the capsule and the messages under it, and under the last.
        public static let listGap: CGFloat = 8
        /// How far under the capsule the messages take to come in whole.
        public static let fade: CGFloat = 24
    }

    /// The card's size on a screen this big.
    public static func size(screen: CGSize, top: CGFloat, bottom: CGFloat, regular: Bool) -> CGSize {
        typealias M = Metrics
        var width = max(0, screen.width - M.inset * 2)
        if regular { width = min(width, M.maxWidth) }
        let height = min(M.maxHeight, max(0, screen.height - M.inset * 2 - top - bottom))
        return CGSize(width: width, height: height)
    }

    public var pill: CGRect
    public var title: CGRect
    /// The messages' insets inside the card.
    public var listTop: CGFloat
    public var listBottom: CGFloat
    /// The ground over the messages: whole down to `fadeClear` (the
    /// capsule's foot), gone by `fadeOpaque`.
    public var fadeClear: CGFloat
    public var fadeOpaque: CGFloat

    public init(size: CGSize, titleSize: CGSize) {
        typealias M = Metrics
        let room = max(0, size.width - M.pillMargin * 2 - M.pillPadding * 2)
        let titleWidth = min(ceil(titleSize.width), room)
        let width = titleWidth + M.pillPadding * 2
        pill = CGRect(x: floor((size.width - width) / 2), y: M.pillTop, width: width, height: M.pillHeight)
        let titleHeight = ceil(titleSize.height)
        title = CGRect(x: pill.minX + M.pillPadding, y: pill.minY + floor((M.pillHeight - titleHeight) / 2), width: titleWidth, height: titleHeight)
        listTop = pill.maxY + M.listGap
        listBottom = M.listGap
        fadeClear = pill.maxY
        fadeOpaque = pill.maxY + M.fade
    }
}
