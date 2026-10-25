import Foundation

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
