import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A conversation's detail, opened from its header's capsule: the legacy
/// app's session screen made over in Settings' glass style
/// (`StemCellsSettingsLayout`). Under the glass bar, scrolling:
///
///          (mark)
///       Pineapple poem ✎        ← the pencil renames it where it stands
///       Task · Working
///   FAMILY
///   ┌ the sidebar's tree ─┐     ← its parent, siblings, children
///   ┌────────┐ ┌────────┐
///   │ Opus 5 │ │ High   │       ← tiles, two to a row; an odd
///   │ Model  │ │ Effort │         last one the row's width
///   └────────┘ └────────┘
///   ┌ Today 3:41 AM ──────┐
///   MEDIA
///   ┌──┬──┬──┐                  ← what it showed, Telegram's
///   ├──┼──┼──┤                    grid, three to a row
///   │ Show more           │
///   LINKS
///   ┌ title / host ───────┐     ← the links written in it
///   ACTIVITY
///   ┌ running agents,     ┐     ← desktop's Activity: what is at
///   │ terminals           │       work, then what settled, folded
///   └─────────────────────┘
///   ┌ Completed      3  › ┐
///
/// A section with nothing in it isn't drawn: no family, no media, no
/// links, nothing at work or settled.
public struct StemCellSessionDetailLayout: Equatable, Sendable {
    public enum Metrics {
        public static let top: CGFloat = 12
        public static let mark: CGFloat = 88
        public static let nameGap: CGFloat = 14
        public static let subtitleGap: CGFloat = 2
        /// The pencil after the name, its glyph's box; a finger's room
        /// around it takes the tap.
        public static let pencil: CGFloat = 20
        public static let pencilGap: CGFloat = 6
        public static let pencilTouch: CGFloat = 44
        public static let textSide: CGFloat = StemCellsSettingsLayout.Metrics.textSide
        public static let side: CGFloat = StemCellsSettingsLayout.Metrics.side
        public static let radius: CGFloat = StemCellsSettingsLayout.Metrics.radius
        public static let tilesTop: CGFloat = 24
        public static let tileGap: CGFloat = 10
        public static let tileHeight: CGFloat = 80
        public static let tileRadius: CGFloat = 22
        public static let tileInset: CGFloat = 16
        public static let valueTop: CGFloat = 14
        public static let valueHeight: CGFloat = 30
        public static let labelHeight: CGFloat = 18
        public static let cardGap: CGFloat = StemCellsSettingsLayout.Metrics.cardGap
        /// A section's heading over its card: Settings' footnote caps, a
        /// card's text start in.
        public static let headingHeight: CGFloat = 18
        public static let headingGap: CGFloat = 8
        public static let headingInset: CGFloat = 16
        /// The media grid: three to a row, square, 2 apart, as Telegram's.
        public static let mediaColumns = 3
        public static let mediaGap: CGFloat = 2
        /// A link, an agent or a terminal: what it is over a quieter line.
        public static let activityRow: CGFloat = 62
        public static let activityTitleTop: CGFloat = 10
        public static let activityTitleHeight: CGFloat = 22
        public static let activityMetaHeight: CGFloat = 18
        public static let bottom: CGFloat = 32
    }

    public struct Tile: Equatable, Sendable {
        public var frame: CGRect
        /// In the tile's own space.
        public var value: CGRect
        public var label: CGRect
    }

    /// One link, agent or terminal, in its card's space.
    public struct ActivityRow: Equatable, Sendable {
        public var box: CGRect
        public var icon: CGRect
        public var title: CGRect
        public var meta: CGRect
        public var separator: CGRect?
    }

    public struct ActivityCard: Equatable, Sendable {
        public var frame: CGRect
        /// The fold's row on the settled card: "Completed", its count, its chevron.
        public var disclosure: StemCellsSettingsLayout.Row?
        public var rows: [ActivityRow]
    }

    /// The media grid's card: its cells, and "Show more" under them, in
    /// the card's space.
    public struct MediaCard: Equatable, Sendable {
        public var frame: CGRect
        public var cells: [CGRect]
        public var more: StemCellsSettingsLayout.Row?
    }

    /// The links' card: a row each, and "Show more" under them.
    public struct LinksCard: Equatable, Sendable {
        public var frame: CGRect
        public var rows: [ActivityRow]
        public var more: StemCellsSettingsLayout.Row?
    }

    /// What a shared section shows: `count` of it, and whether there is more.
    public struct Shown: Equatable, Sendable {
        public var count: Int
        public var more: Bool
        public init(count: Int, more: Bool) {
            self.count = count
            self.more = more
        }
    }

    public var mark: CGRect
    /// The name, as wide as it reads, centred.
    public var name: CGRect
    /// The pencil just after it, and where its tap lands; nil when it
    /// can't be renamed.
    public var pencil: CGRect?
    public var pencilTouch: CGRect?
    /// The field the name becomes while renamed: the row's width.
    public var field: CGRect
    public var subtitle: CGRect
    public var familyHeading: CGRect?
    public var family: CGRect?
    public var tiles: [Tile]
    public var mediaHeading: CGRect?
    public var media: MediaCard?
    public var linksHeading: CGRect?
    public var links: LinksCard?
    public var activityHeading: CGRect?
    /// What is at work: the children, then the terminals.
    public var running: ActivityCard?
    public var completed: ActivityCard?
    public var contentHeight: CGFloat

    /// `nameWidth` the name's single line, nil for the row's width;
    /// `renames` puts the pencil after it. The family's tree is
    /// `family` tall (nil: not drawn); `media` and `links` what the
    /// shared sections show (nil or none: not drawn); `running` rows at
    /// work, `completed` settled (shown under the fold while `open`, its
    /// count `countWidth` wide).
    public init(
        width: CGFloat, nameHeight: CGFloat, nameWidth: CGFloat? = nil, renames: Bool = false, subtitleHeight: CGFloat, tiles count: Int,
        media: Shown? = nil, links: Shown? = nil, family familyHeight: CGFloat?,
        running: Int, completed: Int, countWidth: CGFloat = 0, open: Bool
    ) {
        typealias M = Metrics
        let cardWidth = max(0, width - 2 * M.side)
        let textWidth = max(0, width - 2 * M.textSide)
        mark = CGRect(x: ((width - M.mark) / 2).rounded(), y: M.top, width: M.mark, height: M.mark)
        let nameTop = mark.maxY + M.nameGap
        field = CGRect(x: M.textSide, y: nameTop, width: textWidth, height: nameHeight)
        // The name stays centred under the mark; the pencil hangs after
        // it, as much room kept on the other side.
        let hang = renames ? M.pencilGap + M.pencil : 0
        let text = min((nameWidth ?? textWidth).rounded(.up), max(0, textWidth - 2 * hang))
        name = CGRect(x: ((width - text) / 2).rounded(), y: nameTop, width: text, height: nameHeight)
        if renames {
            let pencil = CGRect(x: name.maxX + M.pencilGap, y: (name.midY - M.pencil / 2).rounded(), width: M.pencil, height: M.pencil)
            self.pencil = pencil
            let grow = (M.pencilTouch - M.pencil) / 2
            pencilTouch = pencil.insetBy(dx: -grow, dy: -grow)
        } else {
            pencil = nil
            pencilTouch = nil
        }
        subtitle = CGRect(x: M.textSide, y: name.maxY + M.subtitleGap, width: textWidth, height: subtitleHeight)

        var y = subtitle.maxY + M.tilesTop
        func heading() -> CGRect {
            let frame = CGRect(x: M.side + M.headingInset, y: y, width: max(0, cardWidth - 2 * M.headingInset), height: M.headingHeight)
            y = frame.maxY + M.headingGap
            return frame
        }

        // Where it sits first, right under its name.
        if let familyHeight {
            familyHeading = heading()
            family = CGRect(x: M.side, y: y, width: cardWidth, height: familyHeight)
            y += familyHeight + M.cardGap
        } else {
            familyHeading = nil
            family = nil
        }
        let tileWidth = max(0, ((cardWidth - M.tileGap) / 2).rounded(.down))
        var tiles: [Tile] = []
        let count = max(0, count)
        for index in 0..<count {
            let column = index % 2
            let row = index / 2
            // An odd last tile takes the row; the right column ends on the
            // cards' edge, whatever the rounding.
            let alone = index == count - 1 && column == 0
            let x = column == 0 ? M.side : M.side + cardWidth - tileWidth
            let frameWidth = alone ? cardWidth : tileWidth
            let frame = CGRect(x: x, y: y + CGFloat(row) * (M.tileHeight + M.tileGap), width: frameWidth, height: M.tileHeight)
            let inner = max(0, frameWidth - 2 * M.tileInset)
            tiles.append(Tile(
                frame: frame,
                value: CGRect(x: M.tileInset, y: M.valueTop, width: inner, height: M.valueHeight),
                label: CGRect(x: M.tileInset, y: M.valueTop + M.valueHeight, width: inner, height: M.labelHeight)
            ))
        }
        self.tiles = tiles
        if let last = tiles.last { y = last.frame.maxY + M.cardGap }

        /// "Show more" at `top`, the card's last row.
        func more(_ shown: Shown, top: CGFloat) -> StemCellsSettingsLayout.Row? {
            shown.more ? StemCellsSettingsLayout.row(.init(hasIcon: false, accessory: .none), y: top, width: cardWidth, last: true) : nil
        }
        /// `followed`, the last row keeps its hairline for what comes under it.
        func listRows(_ count: Int, from top: CGFloat, followed: Bool = false) -> [ActivityRow] {
            let textX = StemCellsSettingsLayout.Metrics.textX
            let tile = StemCellsSettingsLayout.Metrics.tile
            return (0..<max(0, count)).map { index in
                let rowY = top + CGFloat(index) * M.activityRow
                let titleY = rowY + M.activityTitleTop
                let textWidth = max(0, cardWidth - textX - StemCellsSettingsLayout.Metrics.trailing)
                let last = index == count - 1 && !followed
                return ActivityRow(
                    box: CGRect(x: 0, y: rowY, width: cardWidth, height: M.activityRow),
                    icon: CGRect(x: (textX - tile) / 2, y: rowY + (M.activityRow - tile) / 2, width: tile, height: tile),
                    title: CGRect(x: textX, y: titleY, width: textWidth, height: M.activityTitleHeight),
                    meta: CGRect(x: textX, y: titleY + M.activityTitleHeight, width: textWidth, height: M.activityMetaHeight),
                    separator: last ? nil : CGRect(x: textX, y: rowY + M.activityRow - StemCellsSettingsLayout.Metrics.separator, width: cardWidth - textX, height: StemCellsSettingsLayout.Metrics.separator)
                )
            }
        }

        if let media, media.count > 0 {
            mediaHeading = heading()
            let columns = M.mediaColumns
            let cell = max(0, ((cardWidth - CGFloat(columns - 1) * M.mediaGap) / CGFloat(columns)).rounded(.down))
            var cells: [CGRect] = []
            for index in 0..<media.count {
                let column = index % columns
                let row = index / columns
                // The last column ends on the card's edge.
                let x = column == columns - 1 ? cardWidth - cell : CGFloat(column) * (cell + M.mediaGap)
                cells.append(CGRect(x: x, y: CGFloat(row) * (cell + M.mediaGap), width: cell, height: cell))
            }
            let grid = cells.last?.maxY ?? 0
            let moreRow = more(media, top: grid)
            let card = MediaCard(frame: CGRect(x: M.side, y: y, width: cardWidth, height: moreRow?.box.maxY ?? grid), cells: cells, more: moreRow)
            self.media = card
            y = card.frame.maxY + M.cardGap
        } else {
            mediaHeading = nil
            self.media = nil
        }

        if let links, links.count > 0 {
            linksHeading = heading()
            let shown = listRows(links.count, from: 0, followed: links.more)
            let end = shown.last?.box.maxY ?? 0
            let moreRow = more(links, top: end)
            let card = LinksCard(frame: CGRect(x: M.side, y: y, width: cardWidth, height: moreRow?.box.maxY ?? end), rows: shown, more: moreRow)
            self.links = card
            y = card.frame.maxY + M.cardGap
        } else {
            linksHeading = nil
            self.links = nil
        }

        activityHeading = running > 0 || completed > 0 ? heading() : nil
        if running > 0 {
            let card = ActivityCard(frame: CGRect(x: M.side, y: y, width: cardWidth, height: CGFloat(running) * M.activityRow), disclosure: nil, rows: listRows(running, from: 0))
            self.running = card
            y = card.frame.maxY + M.cardGap
        } else {
            self.running = nil
        }
        if completed > 0 {
            let row = StemCellsSettingsLayout.Metrics.row
            // The count sits before the chevron, as a settings value does.
            let disclosure = StemCellsSettingsLayout.row(.init(hasIcon: true, valueWidth: countWidth, accessory: .chevron), y: 0, width: cardWidth, last: !open)
            let shown = open ? completed : 0
            let card = ActivityCard(frame: CGRect(x: M.side, y: y, width: cardWidth, height: row + CGFloat(shown) * M.activityRow), disclosure: disclosure, rows: listRows(shown, from: row))
            self.completed = card
            y = card.frame.maxY + M.cardGap
        } else {
            self.completed = nil
        }
        contentHeight = y - M.cardGap + M.bottom
    }

    /// Pulled past either end, top or bottom: the content's offset
    /// `offset` in a viewport `viewport` tall, inset `top` and `bottom`,
    /// over content `contentHeight` tall. A short page still has its top
    /// as its end.
    public static func stretched(offset: CGFloat, top: CGFloat, bottom: CGFloat, contentHeight: CGFloat, viewport: CGFloat) -> Bool {
        let first = -top
        let last = max(first, contentHeight + bottom - viewport)
        return offset < first || offset > last
    }

    /// A content size laid out while a finger holds the scroll stretched
    /// past an end, kept back until the scroll is back or at rest: a new
    /// size mid-stretch moves the content under the finger.
    public struct HeldSize: Equatable {
        public private(set) var held: CGSize?

        public init() {}

        /// Laid out at `size` over the scroll's `current`: the size to
        /// give it now, if any. Laid out back at `current`, nothing is
        /// held any more.
        public mutating func laidOut(_ size: CGSize, current: CGSize, holding: Bool) -> CGSize? {
            if size == current { held = nil; return nil }
            if holding { held = size; return nil }
            held = nil
            return size
        }

        /// The held size, once nothing holds it.
        public mutating func release(current: CGSize, holding: Bool) -> CGSize? {
            guard let size = held, !holding else { return nil }
            held = nil
            return size == current ? nil : size
        }
    }
}
