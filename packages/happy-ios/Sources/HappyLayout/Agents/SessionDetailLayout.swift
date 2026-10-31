import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A chat's profile, opened from its header's capsule, the agent chat's
/// and the legacy session's alike: the legacy app's session screen made
/// over in Settings' glass style (`SettingsLayout`). Under the glass bar,
/// scrolling:
///
///          (mark)               ← `ProfileHeaderLayout`
///       Pineapple poem ✎        ← the pencil renames it where it stands
///       Task · Working
///   FAMILY
///   ┌ the sidebar's tree ─┐     ← its parent, siblings, children
///   ┌────────┐ ┌────────┐
///   │ Opus 5 │ │ High   │       ← tiles, two to a row; an odd
///   │ Model  │ │ Effort │         last one the row's width
///   └────────┘ └────────┘
///   ┌ Today 3:41 AM ──────┐
///   ┌ Permission mode  Ask ┐   ← sections: the chat's controls, a
///   QUICK ACTIONS                 legacy session's groups; Settings'
///   ┌ Changes          +3 › ┐     cards, a heading over some
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
public struct SessionDetailLayout: Equatable, Sendable {
    public enum Metrics {
        public static let mark: CGFloat = ProfileHeaderLayout.Metrics.mark
        public static let side: CGFloat = SettingsLayout.Metrics.side
        public static let radius: CGFloat = SettingsLayout.Metrics.radius
        public static let tilesTop: CGFloat = 24
        public static let tileGap: CGFloat = 10
        public static let tileHeight: CGFloat = 80
        public static let tileRadius: CGFloat = 22
        public static let tileInset: CGFloat = 16
        public static let valueTop: CGFloat = 14
        public static let valueHeight: CGFloat = 30
        public static let labelHeight: CGFloat = 18
        public static let cardGap: CGFloat = SettingsLayout.Metrics.cardGap
        /// A section's heading over its card: Settings' footnote caps, a
        /// card's text start in.
        public static let headingHeight: CGFloat = 18
        public static let headingGap: CGFloat = 8
        public static let headingInset: CGFloat = 16
        /// The media grid: three to a row, square, 2 apart, as Telegram's.
        public static let mediaColumns = 3
        public static let mediaGap: CGFloat = 2
        /// A link, an agent or a terminal: what it is over a quieter line.
        public static let activityRow: CGFloat = SettingsLayout.Metrics.subtitledRow
        public static let activityTitleTop: CGFloat = SettingsLayout.Metrics.subtitledTitleTop
        public static let activityTitleHeight: CGFloat = SettingsLayout.Metrics.titleHeight
        public static let activityMetaHeight: CGFloat = SettingsLayout.Metrics.subtitleHeight
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
        public var disclosure: SettingsLayout.Row?
        public var rows: [ActivityRow]
    }

    /// The media grid's card: its cells, and "Show more" under them, in
    /// the card's space.
    public struct MediaCard: Equatable, Sendable {
        public var frame: CGRect
        public var cells: [CGRect]
        public var more: SettingsLayout.Row?
    }

    /// The links' card: a row each, and "Show more" under them.
    public struct LinksCard: Equatable, Sendable {
        public var frame: CGRect
        public var rows: [ActivityRow]
        public var more: SettingsLayout.Row?
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

    /// A card of Settings' rows under the tiles: the chat's controls, or
    /// one of a legacy session's groups. Some have a heading over them; a
    /// block (raw JSON) goes under its rows, the card's width. Every
    /// section has rows or a block.
    public struct Section: Equatable, Sendable {
        public var heading: Bool
        public var rows: [SettingsLayout.RowSpec]
        /// The block's height under the rows.
        public var block: CGFloat?
        public init(heading: Bool = false, rows: [SettingsLayout.RowSpec], block: CGFloat? = nil) {
            self.heading = heading
            self.rows = rows
            self.block = block
        }
    }

    public struct SectionFrames: Equatable, Sendable {
        public var heading: CGRect?
        public var card: SettingsLayout.Card
        /// In the card's space.
        public var block: CGRect?
    }

    /// The avatar, the name and what it is, on top.
    public var header: ProfileHeaderLayout
    public var mark: CGRect { header.mark }
    public var name: CGRect { header.name }
    public var pencil: CGRect? { header.pencil }
    public var pencilTouch: CGRect? { header.pencilTouch }
    public var field: CGRect { header.field }
    public var subtitle: CGRect { header.subtitle }
    public var familyHeading: CGRect?
    public var family: CGRect?
    public var tiles: [Tile]
    /// Under the tiles, by `sections`' order.
    public var sections: [SectionFrames]
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
        sections: [Section] = [],
        media: Shown? = nil, links: Shown? = nil, family familyHeight: CGFloat?,
        running: Int, completed: Int, countWidth: CGFloat = 0, open: Bool
    ) {
        typealias M = Metrics
        let cardWidth = max(0, width - 2 * M.side)
        header = ProfileHeaderLayout(width: width, nameHeight: nameHeight, nameWidth: nameWidth, renames: renames, subtitleHeight: subtitleHeight)

        var y = header.bottom + M.tilesTop
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
        self.sections = sections.map { section in
            let heading = section.heading ? heading() : nil
            var rows: [SettingsLayout.Row] = []
            var rowY: CGFloat = 0
            for (index, spec) in section.rows.enumerated() {
                // The last row keeps its hairline over a block under it.
                let row = SettingsLayout.row(spec, y: rowY, width: cardWidth, last: index == section.rows.count - 1 && section.block == nil)
                rows.append(row)
                rowY = row.box.maxY
            }
            let block = section.block.map { CGRect(x: 0, y: rowY, width: cardWidth, height: $0) }
            let card = SettingsLayout.Card(frame: CGRect(x: M.side, y: y, width: cardWidth, height: block?.maxY ?? rowY), rows: rows)
            y = card.frame.maxY + M.cardGap
            return SectionFrames(heading: heading, card: card, block: block)
        }

        /// "Show more" at `top`, the card's last row.
        func more(_ shown: Shown, top: CGFloat) -> SettingsLayout.Row? {
            shown.more ? SettingsLayout.row(.init(hasIcon: false, accessory: .none), y: top, width: cardWidth, last: true) : nil
        }
        /// `followed`, the last row keeps its hairline for what comes under it.
        func listRows(_ count: Int, from top: CGFloat, followed: Bool = false) -> [ActivityRow] {
            let textX = SettingsLayout.Metrics.textX
            let tile = SettingsLayout.Metrics.tile
            return (0..<max(0, count)).map { index in
                let rowY = top + CGFloat(index) * M.activityRow
                let titleY = rowY + M.activityTitleTop
                let textWidth = max(0, cardWidth - textX - SettingsLayout.Metrics.trailing)
                let last = index == count - 1 && !followed
                return ActivityRow(
                    box: CGRect(x: 0, y: rowY, width: cardWidth, height: M.activityRow),
                    icon: CGRect(x: (textX - tile) / 2, y: rowY + (M.activityRow - tile) / 2, width: tile, height: tile),
                    title: CGRect(x: textX, y: titleY, width: textWidth, height: M.activityTitleHeight),
                    meta: CGRect(x: textX, y: titleY + M.activityTitleHeight, width: textWidth, height: M.activityMetaHeight),
                    separator: last ? nil : CGRect(x: textX, y: rowY + M.activityRow - SettingsLayout.Metrics.separator, width: cardWidth - textX, height: SettingsLayout.Metrics.separator)
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
            let row = SettingsLayout.Metrics.row
            // The count sits before the chevron, as a settings value does.
            let disclosure = SettingsLayout.row(.init(hasIcon: true, valueWidth: countWidth, accessory: .chevron), y: 0, width: cardWidth, last: !open)
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
