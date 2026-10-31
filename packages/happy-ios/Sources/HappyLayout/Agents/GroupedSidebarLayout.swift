import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The sidebar as iOS's inset grouped lists draw theirs, Settings' cards
/// (`SettingsLayout`): each section's heading over a quiet card of its
/// rows, 16 in from the list's edges. Rows before the first heading are a
/// card of their own, with no heading. A separator ends a card and the
/// next one starts `cardGap` on. Rows inside a card stand edge to edge,
/// a hairline between each and the next from where its title starts; a
/// nested row stays in its parent's card, its mark under the parent's
/// title. The tree's lines aren't drawn: the indent says it.
extension SidebarLayout {
    public enum Style: Equatable, Sendable {
        /// Desktop's column (`layout`).
        case plain
        /// iOS's inset grouped cards.
        case grouped
    }

    /// A row's place in its card: the card's corners it rounds (the first
    /// row its top ones, the last its bottom ones), and the hairline under
    /// it, absent under the card's last row.
    public struct Cell: Equatable, Sendable {
        public var roundsTop: Bool
        public var roundsBottom: Bool
        public var separator: CGRect?

        public init(roundsTop: Bool, roundsBottom: Bool, separator: CGRect?) {
            self.roundsTop = roundsTop
            self.roundsBottom = roundsBottom
            self.separator = separator
        }
    }

    /// One card: its frame and the rows in it, by index.
    public struct Group: Equatable, Sendable {
        public var frame: CGRect
        public var rows: Range<Int>

        public init(frame: CGRect, rows: Range<Int>) {
            self.frame = frame
            self.rows = rows
        }
    }

    static func grouped(_ rows: [Row], width: CGFloat, top: CGFloat, bottom: CGFloat, scale: CGFloat) -> Result {
        typealias G = GroupedSidebarMetrics
        let cardX = G.side
        let cardWidth = max(0, width - 2 * G.side)
        let cardRight = cardX + cardWidth
        let hairline = 1 / max(1, scale)
        // A row of a card, as opposed to a heading or a separator.
        func inCard(_ row: Row) -> Bool { row.kind == .row || row.kind == .widget }

        var frames: [Frame] = []
        frames.reserveCapacity(rows.count)
        var groups: [Group] = []
        var y = top
        var card: (start: Int, top: CGFloat)?
        func close(at index: Int) {
            guard let open = card else { return }
            groups.append(Group(frame: CGRect(x: cardX, y: open.top, width: cardWidth, height: y - open.top), rows: open.start..<index))
            card = nil
        }

        for (index, row) in rows.enumerated() {
            let afterCard = index > 0 && inCard(rows[index - 1])
            switch row.kind {
            case .section:
                close(at: index)
                if afterCard { y += G.headingGap }
                frames.append(heading(row, y: y, cardX: cardX, cardRight: cardRight, scale: scale))
                y += G.headingHeight
            case .separator:
                close(at: index)
                // Only the gap between two cards; nothing is drawn.
                let height = afterCard ? G.cardGap : 0
                frames.append(Frame(box: CGRect(x: cardX, y: y, width: cardWidth, height: height)))
                y += height
            case .row, .widget:
                if card == nil { card = (index, y) }
                let box = CGRect(x: cardX, y: y, width: cardWidth, height: height(row))
                var frame: Frame
                if row.kind == .row, let story = row.story {
                    frame = storyRow(story, hasMark: row.hasMark, in: box.insetBy(dx: G.storyInset, dy: 0), scale: scale)
                    frame.box = box
                } else {
                    frame = cellRow(row, box: box, cardRight: cardRight, scale: scale)
                }
                let last = index + 1 == rows.count || !inCard(rows[index + 1])
                let start = frame.label.minX
                frame.cell = Cell(
                    roundsTop: card?.start == index, roundsBottom: last,
                    separator: last ? nil : CGRect(x: start, y: box.maxY - hairline, width: max(0, box.maxX - start), height: hairline)
                )
                frames.append(frame)
                y += box.height
            }
        }
        close(at: rows.count)
        return Result(frames: frames, connectors: [], contentHeight: y + bottom, groups: groups)
    }

    /// A row in a card: the mark `markInset` in from the card (a nested
    /// one an `indent` further a level), the trailing square as far in
    /// from its other side, and between them the plain row's own.
    static func cellRow(_ row: Row, box: CGRect, cardRight: CGFloat, scale: CGFloat) -> Frame {
        typealias G = GroupedSidebarMetrics
        typealias M = Metrics
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        let midY = box.midY
        let trailingRect = CGRect(x: pixel(cardRight - G.endCenter - M.trailing / 2), y: pixel(midY - M.trailing / 2), width: M.trailing, height: M.trailing)
        var frame = Frame(box: box)
        var x = box.minX + G.markInset + CGFloat(row.depth) * G.indent
        if row.hasMark {
            frame.mark = CGRect(x: x, y: midY - M.mark / 2, width: M.mark, height: M.mark)
            x += M.mark + M.markGap
        }
        var right = trailingRect.maxX
        var slot = trailingRect
        if row.hasFold, row.kind == .row {
            let ink = row.foldClosed ? M.chevronRightInk : M.chevronDownInk
            let size = M.chevronGlyph
            frame.chevron = slot
            frame.chevronGlyph = CGRect(x: pixel(cardRight - G.endCenter - size / 2 - ink.dx), y: pixel(midY - size / 2 - ink.dy), width: size, height: size)
            right = slot.minX - M.trailingGap
            slot = slot.offsetBy(dx: -(M.trailing + M.trailingGap), dy: 0)
        }
        if row.hasTrailing {
            frame.trailing = slot
            right = slot.minX - M.trailingGap
        }
        // A row's title rides up to its marks' middle, as in the plain list.
        frame.label = CGRect(x: x, y: row.kind == .row ? box.minY - M.titleLift : box.minY, width: max(0, right - x), height: box.height)
        if row.hasTrailing == false, row.kind == .row, row.hasWorkingSignal {
            let signal = StoryRowMetrics.braille
            frame.corner = CGRect(x: slot.midX - signal.width / 2, y: slot.midY - signal.height / 2, width: signal.width, height: signal.height)
            frame.label.size.width = max(0, slot.minX - M.trailingGap - x)
        }
        return frame
    }

    /// A section's heading over its card: the box the card's width and
    /// `headingHeight` tall; its title from where a top-level mark starts,
    /// `headingBottom` above the card; its fold on the rows' trailing
    /// column, on the title's middle, its smaller glyph's ink centred there.
    static func heading(_ row: Row, y: CGFloat, cardX: CGFloat, cardRight: CGFloat, scale: CGFloat) -> Frame {
        typealias G = GroupedSidebarMetrics
        typealias M = Metrics
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        let box = CGRect(x: cardX, y: y, width: max(0, cardRight - cardX), height: G.headingHeight)
        var frame = Frame(box: box)
        let titleY = box.maxY - G.headingBottom - G.headingLine
        let midY = titleY + G.headingLine / 2
        let lane = CGRect(x: pixel(cardRight - G.endCenter - M.trailing / 2), y: pixel(midY - M.trailing / 2), width: M.trailing, height: M.trailing)
        let ink = row.foldClosed ? M.chevronRightInk : M.chevronDownInk
        let shrink = G.headingGlyph / M.chevronGlyph
        frame.chevron = lane
        frame.chevronGlyph = CGRect(x: pixel(cardRight - G.endCenter - G.headingGlyph / 2 - ink.dx * shrink), y: pixel(midY - G.headingGlyph / 2 - ink.dy * shrink), width: G.headingGlyph, height: G.headingGlyph)
        let x = cardX + G.markInset
        frame.label = CGRect(x: x, y: titleY, width: max(0, lane.minX - sectionFoldGap - x), height: G.headingLine)
        return frame
    }
}
