import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The Stem Cells sidebar's frames: one column of rows, each a fixed height
/// by its kind, so folding a section moves only the rows after it and no row
/// ever changes size.
public enum StemCellsSidebarLayout {
    public enum Kind: Equatable, Sendable {
        case row, section, separator, widget
    }

    /// What the layout needs to know about a row.
    public struct Row: Equatable, Sendable {
        public var kind: Kind
        public var depth: Int
        public var hasMark: Bool
        /// A status mark or an unread dot in the trailing square.
        public var hasTrailing: Bool
        public var hasWorkingSignal: Bool
        /// Rows nested under it fold: its chevron takes the trailing square,
        /// and a status or dot stands just before it.
        public var hasFold: Bool
        /// A section heading's "+", which makes new work in it: one square
        /// before its fold, always shown.
        public var hasAdd: Bool
        /// The fold points right ("›"), not down ("⌄"): its ink weighs elsewhere.
        public var foldClosed: Bool
        /// Drawn as sidebar v2's story row (Stories on): two lines, the
        /// mark in its story ring, one signal in the bottom-right corner.
        public var story: StoryRow?

        public init(kind: Kind, depth: Int = 0, hasMark: Bool = true, hasTrailing: Bool = false, hasWorkingSignal: Bool = false, hasFold: Bool = false, hasAdd: Bool = false, foldClosed: Bool = false, story: StoryRow? = nil) {
            self.kind = kind
            self.depth = depth
            self.hasMark = hasMark
            self.hasTrailing = hasTrailing
            self.hasWorkingSignal = hasWorkingSignal
            self.hasFold = hasFold
            self.hasAdd = hasAdd
            self.foldClosed = foldClosed
            self.story = story
        }
    }

    /// The one signal a story row shows in its bottom-right corner, where
    /// Telegram puts its unread dot: a dot while it waits on the person, a
    /// braille loader while it works, nothing otherwise.
    public enum Corner: Equatable, Sendable {
        case none, dot, braille
    }

    /// What a story row draws beside its title.
    public struct StoryRow: Equatable, Sendable {
        /// One fixed status line under the title, blank when no status is available.
        public var hasSubtitle: Bool
        public var corner: Corner
        /// The time at the end of the first line, as measured; 0 for none.
        public var timeWidth: CGFloat

        public init(hasSubtitle: Bool = true, corner: Corner = .none, timeWidth: CGFloat = 0) {
            self.hasSubtitle = hasSubtitle
            self.corner = corner
            self.timeWidth = timeWidth
        }
    }

    public struct Frame: Equatable, Sendable {
        /// The row box: the tap target and its fill, in content coordinates.
        public var box: CGRect
        /// The leading mark, absent for a row without one; then the label starts there.
        public var mark: CGRect?
        public var label: CGRect
        /// The status mark or unread dot.
        public var trailing: CGRect?
        /// A section's fold chevron, on the same trailing column: its lane.
        public var chevron: CGRect?
        /// The chevron's image (`chevronGlyph` square), placed so its ink's
        /// optical centre is the fold's: `trailingCenter` from the right,
        /// on the row's middle. On whole pixels at `scale`.
        public var chevronGlyph: CGRect?
        /// A section's "+", one square before its fold.
        public var add: CGRect?
        /// A separator's hairline, across the row box's whole width.
        public var rule: CGRect?
        /// A story row's ring, around its mark (the mark sits inside on its plate).
        public var ring: CGRect?
        /// A story row's second line.
        public var subtitle: CGRect?
        /// A story row's corner signal: the dot or braille loader.
        public var corner: CGRect?
        /// A story row's time, at the end of its first line.
        public var time: CGRect?
        /// The hairline under a story row followed by another, from its
        /// text's start to the box's end, on whole pixels.
        public var separator: CGRect?

        public init(box: CGRect, mark: CGRect? = nil, label: CGRect = .zero, trailing: CGRect? = nil, chevron: CGRect? = nil, chevronGlyph: CGRect? = nil, add: CGRect? = nil, rule: CGRect? = nil, ring: CGRect? = nil, subtitle: CGRect? = nil, corner: CGRect? = nil, time: CGRect? = nil, separator: CGRect? = nil) {
            self.box = box
            self.mark = mark
            self.label = label
            self.trailing = trailing
            self.chevron = chevron
            self.chevronGlyph = chevronGlyph
            self.add = add
            self.rule = rule
            self.ring = ring
            self.subtitle = subtitle
            self.corner = corner
            self.time = time
            self.separator = separator
        }
    }

    public struct Result: Equatable, Sendable {
        public var frames: [Frame]
        /// The tree's lines: vertical stems and the elbows into nested rows, `line` wide.
        public var connectors: [CGRect]
        public var contentHeight: CGFloat
    }

    public static func height(_ row: Row) -> CGFloat {
        row.kind == .row && row.story != nil ? (row.depth > 0 ? StemCellsStoryRowMetrics.nestedRowHeight : StemCellsStoryRowMetrics.rowHeight) : height(row.kind)
    }

    public static func height(_ kind: Kind) -> CGFloat {
        switch kind {
        case .row: StemCellsMetrics.rowHeight
        case .section: StemCellsMetrics.sectionHeight
        case .separator: StemCellsMetrics.separatorHeight
        case .widget: StemCellsMetrics.widgetMinHeight
        }
    }

    public static func layout(_ rows: [Row], width: CGFloat, top: CGFloat = StemCellsMetrics.contentTop, bottom: CGFloat = StemCellsMetrics.contentBottom, scale: CGFloat = 3) -> Result {
        typealias M = StemCellsMetrics
        var frames: [Frame] = []
        frames.reserveCapacity(rows.count)
        var y = top
        let boxX = M.inset
        let boxWidth = max(0, width - 2 * M.inset)
        for (index, row) in rows.enumerated() {
            if index > 0, row.story == nil || rows[index - 1].story == nil { y += M.rowGap }
            let height = height(row)
            let box = CGRect(x: boxX, y: y, width: boxWidth, height: height)
            let midY = y + height / 2
            func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
            // Centred `trailingCenter` in, on the row's middle, on whole pixels.
            let trailingRect = CGRect(x: pixel(width - M.trailingCenter - M.trailing / 2), y: pixel(midY - M.trailing / 2), width: M.trailing, height: M.trailing)
            let inkRight = trailingRect.maxX
            var frame = Frame(box: box)
            func fold(_ midY: CGFloat = midY) -> CGRect {
                let ink = row.foldClosed ? M.chevronRightInk : M.chevronDownInk
                let size = M.chevronGlyph
                return CGRect(x: pixel(width - M.trailingCenter - size / 2 - ink.dx), y: pixel(midY - size / 2 - ink.dy), width: size, height: size)
            }
            switch row.kind {
            case .separator:
                frame.rule = CGRect(x: boxX, y: (midY - M.line / 2).rounded(.down), width: boxWidth, height: M.line)
            case .section:
                // The title starts where a top-level glyph's ink does, and keeps
                // clear of the fold's lane (`padding-right: row padding + 22`),
                // so showing the fold moves nothing.
                let x = boxX + M.sectionTitleInset
                var end = trailingRect.minX
                if row.hasAdd {
                    let add = trailingRect.offsetBy(dx: -(M.trailing + M.trailingGap), dy: 0)
                    frame.add = add
                    end = add.minX
                }
                frame.label = CGRect(x: x, y: y, width: max(0, end - sectionFoldGap - x), height: height)
                frame.chevron = trailingRect
                frame.chevronGlyph = fold()
            case .row where row.story != nil:
                // The fold rides on the title's line, as the time does.
                let factor = row.depth > 0 ? StemCellsStoryRowMetrics.nestedScale : 1
                let line = y + (StemCellsStoryRowMetrics.titleTop + StemCellsStoryRowMetrics.titleLine / 2) * factor
                frame = storyRow(row, box: box, trailingRect: trailingRect.offsetBy(dx: 0, dy: pixel(line - midY)), fold: row.hasFold ? fold(line) : nil, pixel: pixel)
            case .widget, .row:
                var x = leadingX(depth: row.depth)
                if row.hasMark {
                    frame.mark = CGRect(x: x, y: midY - M.mark / 2, width: M.mark, height: M.mark)
                    x += M.mark + M.markGap
                }
                var right = inkRight
                var slot = trailingRect
                if row.hasFold, row.kind == .row {
                    frame.chevron = slot
                    frame.chevronGlyph = fold()
                    right = slot.minX - M.trailingGap
                    slot = slot.offsetBy(dx: -(M.trailing + M.trailingGap), dy: 0)
                }
                if row.hasTrailing {
                    frame.trailing = slot
                    right = slot.minX - M.trailingGap
                }
                // A row's title rides up to its marks' middle.
                frame.label = CGRect(x: x, y: row.kind == .row ? y - M.titleLift : y, width: max(0, right - x), height: height)
                if row.hasTrailing == false, row.story == nil, row.kind == .row, row.hasWorkingSignal {
                    let signal = StemCellsStoryRowMetrics.braille
                    frame.corner = CGRect(x: slot.midX - signal.width / 2, y: slot.midY - signal.height / 2, width: signal.width, height: signal.height)
                    frame.label.size.width = max(0, slot.minX - M.trailingGap - x)
                }
            }
            frames.append(frame)
            y += height
        }
        // Telegram's hairline between one story row and the next, none
        // after a section's last.
        let hairline = 1 / max(1, scale)
        for index in rows.indices.dropLast() where rows[index].story != nil && rows[index].kind == .row && rows[index + 1].story != nil && rows[index + 1].kind == .row {
            let box = frames[index].box
            let x = frames[index].label.minX
            frames[index].separator = CGRect(x: x, y: box.maxY - hairline, width: max(0, box.maxX - x), height: hairline)
        }
        return Result(frames: frames, connectors: connectors(rows, frames), contentHeight: y + bottom)
    }

    /// Sidebar v2's story row, on Telegram's chat list: the ring 12 into
    /// the box and centred on its height, the mark's plate inside it; the
    /// title on a fixed first line, the time and the fold at its end; the
    /// status under it on one line; the corner signal centred on that line
    /// at the text's end. Nested rows use a smaller fixed size.
    static func storyRow(_ row: Row, box: CGRect, trailingRect: CGRect, fold: CGRect?, pixel: (CGFloat) -> CGFloat) -> Frame {
        typealias S = StemCellsStoryRowMetrics
        typealias M = StemCellsMetrics
        let story = row.story ?? StoryRow()
        let factor = row.depth > 0 ? S.nestedScale : 1
        var frame = Frame(box: box)
        let ringX = storyLeadingX(depth: row.depth)
        let side = S.ring * factor
        let ring = CGRect(x: ringX, y: pixel(box.midY - side / 2), width: side, height: side)
        let inset = (S.ring - S.plate) * factor / 2
        if row.hasMark {
            frame.ring = ring
            frame.mark = ring.insetBy(dx: inset, dy: inset)
        }
        let x = row.hasMark ? ring.maxX + S.textGap * factor : ringX
        let end = box.maxX - S.textTrailing
        let titleY = box.minY + S.titleTop * factor
        var titleEnd = end
        if let fold {
            frame.chevron = trailingRect
            frame.chevronGlyph = fold
            titleEnd = min(titleEnd, trailingRect.minX - M.trailingGap)
        }
        if story.timeWidth > 0 {
            let width = min(story.timeWidth, max(0, titleEnd - x))
            let time = CGRect(x: titleEnd - width, y: titleY, width: width, height: S.titleLine * factor)
            frame.time = time
            titleEnd = time.minX - S.timeGap
        }
        frame.label = CGRect(x: x, y: titleY, width: max(0, titleEnd - x), height: S.titleLine * factor)
        let subtitleY = titleY + (S.titleLine + S.lineGap) * factor
        if story.hasSubtitle {
            frame.subtitle = CGRect(x: x, y: subtitleY, width: max(0, end - S.cornerSlot - x), height: S.subtitleLine * factor)
        }
        let cornerMid = subtitleY + S.subtitleLine * factor / 2
        switch story.corner {
        case .none: break
        case .dot:
            frame.corner = CGRect(x: end - S.dot, y: pixel(cornerMid - S.dot / 2), width: S.dot, height: S.dot)
        case .braille:
            frame.corner = CGRect(x: end - S.braille.width, y: pixel(cornerMid - S.braille.height / 2), width: S.braille.width, height: S.braille.height)
        }
        return frame
    }

    /// Where a story row's ring starts: 12 into the box, `indent` more per level.
    static func storyLeadingX(depth: Int) -> CGFloat {
        typealias S = StemCellsStoryRowMetrics
        return StemCellsMetrics.inset + S.ringInset + (depth > 0 ? S.indent + CGFloat(depth - 1) * S.indent * S.nestedScale : 0)
    }

    /// Between a section's title and its fold: `22 − 18`.
    static let sectionFoldGap: CGFloat = 4 * StemCellsMetrics.phone

    /// Where a row's mark (or, without one, its label) starts: a top-level
    /// mark centred `endInset` in from the row box, `indent` more per level.
    static func leadingX(depth: Int) -> CGFloat {
        typealias M = StemCellsMetrics
        return M.markCenter - M.mark / 2 + CGFloat(depth) * M.indent
    }

    /// `SidebarTreeConnectors`: one stem per parent down its mark's centre,
    /// from under the mark to a point past its last child's middle, and an
    /// elbow into each child at its middle, stopping short of its mark.
    static func connectors(_ rows: [Row], _ frames: [Frame]) -> [CGRect] {
        typealias M = StemCellsMetrics
        var lines: [CGRect] = []
        var parents: [Int: Int] = [:]
        var children: [Int: [Int]] = [:]
        var order: [Int] = []
        for (index, row) in rows.enumerated() where row.depth > 0 && row.kind == .row && row.story == nil {
            var parent = index - 1
            while parent >= 0, rows[parent].depth >= row.depth { parent -= 1 }
            guard parent >= 0, rows[parent].depth == row.depth - 1 else { continue }
            parents[index] = parent
            if children[parent] == nil { order.append(parent) }
            children[parent, default: []].append(index)
        }
        for parent in order {
            let kids = children[parent] ?? []
            let parentMark = frames[parent].ring ?? frames[parent].mark
            let stemX = ((parentMark.map(\.midX) ?? leadingX(depth: rows[parent].depth) + M.mark / 2) - M.line / 2).rounded(.down)
            let top = frames[parent].box.midY + (parentMark.map { $0.height / 2 } ?? M.stemInset)
            let bottom = (kids.map { frames[$0].box.midY }.max() ?? top) + M.line
            lines.append(CGRect(x: stemX, y: top, width: M.line, height: max(0, bottom - top)))
            for kid in kids {
                let end = (frames[kid].ring?.minX ?? leadingX(depth: rows[kid].depth)) - M.elbowGap
                lines.append(CGRect(x: stemX + M.line, y: (frames[kid].box.midY - M.line / 2).rounded(.down), width: max(0, end - stemX - M.line), height: M.line))
            }
        }
        return lines
    }
}
