import Foundation

/// A held row's preview and menu over the blurred sidebar, measured as
/// Telegram's context controller places a controller's preview and its
/// actions (`ContextControllerExtractedPresentationNode`,
/// `ContextControllerActionsStackNode`).
///
/// The preview is centred on the screen with the menu 10 under it, its
/// right edge on the preview's; when the two overrun the foot (10 above
/// the bottom safe area) both move up, and when that would take the
/// preview above the top (8 under the top safe area) the preview gives up
/// height instead. A row with no preview keeps its place, its menu under
/// it, or over it when there is no room under.
///
/// The menu is 220–240 wide; each item is 11 above and below its title,
/// its icon in a 32 column 20 in and its title 60 in; groups are parted by
/// a 20 tall separator, and the whole is 10 in from the top and bottom.
public struct StemCellsHoldLayout: Equatable, Sendable {
    public enum Metrics {
        public static let spacing: CGFloat = 10
        public static let edgeInset: CGFloat = 12
        public static let bottomInset: CGFloat = 10
        public static let topInset: CGFloat = 8
        public static let cardCorner: CGFloat = 30
        public static let menuMinWidth: CGFloat = 220
        public static let menuMaxWidth: CGFloat = 240
        public static let menuPadding: CGFloat = 10
        public static let menuMaxCorner: CGFloat = 30
        public static let itemVerticalInset: CGFloat = 11
        public static let itemSideInset: CGFloat = 18
        public static let iconSideInset: CGFloat = 20
        public static let iconColumn: CGFloat = 32
        public static let iconSpacing: CGFloat = 8
        public static let titleLeading: CGFloat = 60
        public static let separatorHeight: CGFloat = 20
        public static let separatorInset: CGFloat = 18
        public static let iconSize: CGFloat = 24
    }

    /// The menu, in its own space.
    public struct Menu: Equatable, Sendable {
        public var size: CGSize
        /// Each item's row, icon and title, by group.
        public var items: [[Item]]
        /// The lines between groups.
        public var separators: [CGRect]
        public var corner: CGFloat

        public struct Item: Equatable, Sendable {
            public var frame: CGRect
            public var icon: CGRect
            public var title: CGRect
        }

        /// `titles` are each item's title width by group; `titleHeight` one line.
        public init(titles: [[CGFloat]], titleHeight: CGFloat) {
            typealias M = Metrics
            let widest = titles.flatMap { $0 }.max() ?? 0
            let natural = ceil(widest) + M.itemSideInset + M.iconColumn + M.iconSideInset + M.iconSpacing
            let width = min(M.menuMaxWidth, max(M.menuMinWidth, natural))
            let lineHeight = ceil(titleHeight)
            let itemHeight = lineHeight + M.itemVerticalInset * 2
            var y = M.menuPadding
            var items: [[Item]] = []
            var separators: [CGRect] = []
            for (index, group) in titles.enumerated() {
                if index > 0 {
                    separators.append(CGRect(x: M.separatorInset, y: y + floor((M.separatorHeight - 1) / 2), width: width - M.separatorInset * 2, height: 1))
                    y += M.separatorHeight
                }
                items.append(group.map { titleWidth in
                    let frame = CGRect(x: 0, y: y, width: width, height: itemHeight)
                    y += itemHeight
                    let icon = CGRect(x: M.iconSideInset + floor((M.iconColumn - M.iconSize) / 2), y: frame.minY + floor((itemHeight - M.iconSize) / 2), width: M.iconSize, height: M.iconSize)
                    let title = CGRect(x: M.titleLeading, y: frame.minY + M.itemVerticalInset, width: min(ceil(titleWidth), width - M.titleLeading - M.itemSideInset), height: lineHeight)
                    return Item(frame: frame, icon: icon, title: title)
                })
            }
            y += M.menuPadding
            size = CGSize(width: width, height: y)
            corner = min(M.menuMaxCorner, y / 2)
            self.items = items
            self.separators = separators
        }
    }

    /// Where the preview (or the held row, with none) shows.
    public var card: CGRect
    public var menu: CGRect

    /// `card` is the preview's size, nil for a row without one, which then
    /// stays at `source`.
    public init(screen: CGSize, top: CGFloat, bottom: CGFloat, source: CGRect, card: CGSize?, menu: CGSize) {
        typealias M = Metrics
        let ceiling = top + M.topInset
        let floorY = screen.height - bottom - M.bottomInset
        guard let card else {
            self.card = source
            let right = min(screen.width - M.edgeInset, source.maxX)
            let x = max(M.edgeInset, right - menu.width)
            let under = source.maxY + M.spacing
            let y = under + menu.height <= floorY ? under : max(ceiling, source.minY - M.spacing - menu.height)
            self.menu = CGRect(x: x, y: y, width: menu.width, height: menu.height)
            return
        }
        let room = max(0, floorY - ceiling - M.spacing - menu.height)
        let height = min(card.height, room)
        var cardFrame = CGRect(x: floor((screen.width - card.width) / 2), y: floor((screen.height - height) / 2), width: card.width, height: height)
        let overrun = cardFrame.maxY + M.spacing + menu.height - floorY
        if overrun > 0 { cardFrame.origin.y -= overrun }
        cardFrame.origin.y = max(ceiling, cardFrame.minY)
        self.card = cardFrame
        let x = max(M.edgeInset, min(screen.width - M.edgeInset, cardFrame.maxX) - menu.width)
        self.menu = CGRect(x: x, y: cardFrame.maxY + M.spacing, width: menu.width, height: menu.height)
    }
}
