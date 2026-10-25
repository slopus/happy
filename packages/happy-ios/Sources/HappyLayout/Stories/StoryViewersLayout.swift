import Foundation

/// The sheet listing who saw one's own story, measured as Telegram's
/// (`StoryItemSetContainerComponent`, `StoryItemSetViewListComponent`): edge
/// to edge and down to the screen's foot, its top corners rounded 10; half
/// open it leaves the story 325 + 12 above its 12 pt inset, full it stops
/// 60 + 12 under the top; a 56 header with the title centred in it and the
/// list right under it.
public struct StoryViewersSheetLayout: Equatable, Sendable {
    public enum Metrics {
        public static let header: CGFloat = 56
        public static let corner: CGFloat = 10
        /// What Telegram keeps of the story above the half-open list.
        public static let story: CGFloat = 325 + 12
        public static let minimumHeight: CGFloat = 100
        /// The full list's distance from the top.
        public static let fullTop: CGFloat = 60
        /// The list's own top inset inside Telegram's container.
        public static let inset: CGFloat = 12
    }

    /// All in the sheet's own space.
    public var header: CGRect
    public var title: CGRect
    public var list: CGRect

    /// How much of the sheet shows half open and full, for a container
    /// this tall.
    public static func half(_ height: CGFloat) -> CGFloat { max(Metrics.minimumHeight, height - Metrics.story) - Metrics.inset }
    public static func full(_ height: CGFloat) -> CGFloat { height - Metrics.fullTop - Metrics.inset }

    /// The sheet in its container with `shown` of it showing: between
    /// `half` and `full` while dragged; less than `half` while it closes,
    /// when it keeps its half height and slides down.
    public static func sheet(container: CGSize, shown: CGFloat) -> CGRect {
        CGRect(x: 0, y: container.height - shown, width: container.width, height: max(shown, half(container.height)))
    }

    /// Inside a sheet this big.
    public init(size: CGSize, titleSize: CGSize) {
        typealias M = Metrics
        header = CGRect(x: 0, y: 0, width: size.width, height: M.header)
        let titleWidth = min(ceil(titleSize.width), max(0, size.width - 32))
        title = CGRect(x: floor((size.width - titleWidth) / 2), y: floor((M.header - ceil(titleSize.height)) / 2), width: titleWidth, height: ceil(titleSize.height))
        list = CGRect(x: 0, y: M.header, width: size.width, height: max(0, size.height - M.header))
    }
}

/// One row of the sheet listing who saw one's own story, measured as
/// Telegram's story view list draws its rows (`PeerListItemComponent` in its
/// `.generic` style): 60 tall with a subtitle and 50 without, 1 in from top
/// and bottom; a 40 avatar 10 in, the name in 17 pt semibold 62 in and the
/// subtitle in 15 pt 2 under it, centred together; the reaction 22 square
/// 14 from the right edge; the separator from the name to 16 short of the
/// right edge.
public struct StoryViewersRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 60
        public static let plainHeight: CGFloat = 50
        public static let inset: CGFloat = 1
        public static let avatar: CGFloat = 40
        public static let avatarLeading: CGFloat = 10
        public static let textLeading: CGFloat = 62
        public static let textTrailing: CGFloat = 8
        /// What the reaction takes from the text's width besides.
        public static let reactionRoom: CGFloat = 32
        public static let reaction: CGFloat = 22
        public static let reactionTrailing: CGFloat = 14
        public static let titleSize: CGFloat = 17
        public static let subtitleSize: CGFloat = 15
        public static let spacing: CGFloat = 2
        public static let separatorTrailing: CGFloat = 16
    }

    public var height: CGFloat
    public var avatar: CGRect
    public var title: CGRect
    public var subtitle: CGRect?
    public var reaction: CGRect?
    /// The separator's insets from the row's left and right edges.
    public var separatorLeading: CGFloat
    public var separatorTrailing: CGFloat

    /// `titleHeight` and `subtitleHeight` are one line of each font;
    /// `subtitleHeight` is nil for a viewer with nothing under their name.
    public init(width: CGFloat, titleHeight: CGFloat, subtitleHeight: CGFloat?, reacted: Bool) {
        typealias M = Metrics
        height = subtitleHeight == nil ? M.plainHeight : M.height
        let inner = height - M.inset * 2
        avatar = CGRect(x: M.avatarLeading, y: M.inset + floor((inner - M.avatar) / 2), width: M.avatar, height: M.avatar)
        let textWidth = max(0, width - M.textLeading - M.textTrailing - (reacted ? M.reactionRoom : 0))
        let titleHeight = ceil(titleHeight)
        let subtitleHeight = subtitleHeight.map { ceil($0) }
        let content = titleHeight + (subtitleHeight.map { $0 + M.spacing } ?? 0)
        title = CGRect(x: M.textLeading, y: M.inset + floor((inner - content) / 2), width: textWidth, height: titleHeight)
        subtitle = subtitleHeight.map { [title] in CGRect(x: M.textLeading, y: title.maxY + M.spacing, width: textWidth, height: $0) }
        reaction = reacted ? CGRect(x: width - M.reactionTrailing - M.reaction, y: M.inset + floor((inner - M.reaction) / 2), width: M.reaction, height: M.reaction) : nil
        separatorLeading = M.textLeading
        separatorTrailing = M.separatorTrailing
    }
}
