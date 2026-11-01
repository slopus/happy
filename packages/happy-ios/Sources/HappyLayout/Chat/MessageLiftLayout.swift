import Foundation

/// A held message lifted over the blurred chat, placed as Telegram's
/// context controller places an extracted message and its actions
/// (`ContextControllerExtractedPresentationNode.update`).
///
/// The message stays where it was, its menu 7 under it. When the two run
/// past the foot (10 above the bottom safe area) both move up, and never
/// above the top (8 under the top safe area). A message taller than the
/// room left by the menu is cut to that room, at least 200, centred on
/// where it was, and scrolls inside it: its viewport starts on the part
/// of it that was at the viewport's top.
///
/// The menu (`HoldLayout.Menu`) hangs from the message's leading edge,
/// 2 in, for a message on the leading half; from its trailing edge, 7 in,
/// for one on the trailing half; and keeps 12 from the screen's sides.
public struct MessageLiftLayout: Equatable, Sendable {
    public enum Metrics {
        /// `contentActionsSpacing`.
        public static let spacing: CGFloat = 7
        public static let topInset: CGFloat = 8
        public static let bottomInset: CGFloat = 10
        /// `actionsEdgeInset` for extracted content.
        public static let edgeInset: CGFloat = 12
        /// `actionsSideInset`, less 4 on the leading side and plus 1 on the trailing.
        public static let leadingInset: CGFloat = 2
        public static let trailingInset: CGFloat = 7
        /// The least a message cut to the room is given.
        public static let minimumHeight: CGFloat = 200
        /// The spring all of it comes in on (`makeSpringBounceAnimation`, run
        /// over 0.42 s), and the ease it goes back on.
        public static let springMass: CGFloat = 5
        public static let springStiffness: CGFloat = 900
        public static let springDamping: CGFloat = 104
        public static let springDuration: TimeInterval = 0.42
        public static let backdropDuration: TimeInterval = 0.2
        public static let menuFadeDuration: TimeInterval = 0.05
        public static let dismissDuration: TimeInterval = 0.2
    }

    /// Where the message's centre is on its row.
    public enum Side: Equatable, Sendable { case leading, trailing }

    /// The message's window: all of it, or the part a tall one shows.
    public var viewport: CGRect
    /// How far into the message the viewport starts.
    public var offset: CGFloat
    /// The whole message's height, which the viewport scrolls through.
    public var contentHeight: CGFloat
    public var menu: CGRect

    /// `source` is the message where it rests on screen; `menu` the menu's
    /// size, zero for none.
    public init(screen: CGSize, top: CGFloat, bottom: CGFloat, source: CGRect, menu: CGSize, side: Side) {
        typealias M = Metrics
        let ceiling = top + M.topInset
        let floorY = screen.height - bottom - M.bottomInset
        let menuRoom = menu.height > 0 ? M.spacing + menu.height : 0
        let room = floorY - ceiling - menuRoom
        var frame = source
        if source.height > room {
            frame.size.height = max(room, min(source.height, M.minimumHeight))
            frame.origin.y = floor(source.midY - frame.height / 2)
        }
        if frame.minY < ceiling { frame.origin.y = ceiling }
        let combined = frame.height + menuRoom
        if frame.minY + combined > floorY { frame.origin.y = floorY - combined }
        if frame.minY < ceiling { frame.origin.y = ceiling }
        viewport = frame
        contentHeight = source.height
        offset = min(max(0, frame.minY - source.minY), max(0, source.height - frame.height))

        var x: CGFloat
        switch side {
        case .leading: x = frame.minX + M.leadingInset
        case .trailing: x = frame.maxX - M.trailingInset - menu.width
        }
        x = max(M.edgeInset, min(screen.width - M.edgeInset - menu.width, x))
        self.menu = CGRect(x: x, y: frame.maxY + M.spacing, width: menu.width, height: menu.height)
    }

    /// The side of a row `width` wide that a message at `frame` sits on.
    public static func side(of frame: CGRect, in width: CGFloat) -> Side {
        frame.midX <= width / 2 + 0.5 ? .leading : .trailing
    }
}
