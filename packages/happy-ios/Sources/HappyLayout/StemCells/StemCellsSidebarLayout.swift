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
        /// Drawn as a story row (Stories on): the card, the disc in its
        /// ring, the title and up to two status lines, the time and one signal.
        public var story: StoryRow?
        /// A section heading or separator among story rows: at desktop's
        /// own size, as the rows are.
        public var amongStories: Bool

        public init(kind: Kind, depth: Int = 0, hasMark: Bool = true, hasTrailing: Bool = false, hasWorkingSignal: Bool = false, hasFold: Bool = false, hasAdd: Bool = false, foldClosed: Bool = false, story: StoryRow? = nil, amongStories: Bool = false) {
            self.kind = kind
            self.depth = depth
            self.hasMark = hasMark
            self.hasTrailing = hasTrailing
            self.hasWorkingSignal = hasWorkingSignal
            self.hasFold = hasFold
            self.hasAdd = hasAdd
            self.foldClosed = foldClosed
            self.story = story
            self.amongStories = amongStories
        }
    }

    /// The one signal a story row shows in its bottom-right lane: the chat's
    /// braille spinner while it works, a dot while something is unread,
    /// nothing otherwise.
    public enum Corner: Equatable, Sendable {
        case none, dot, braille
    }

    /// What a story row's last line holds: the status's second line, the
    /// person's draft, or, with nothing at all to say, the empty mark.
    public enum LastLine: Equatable, Sendable {
        case status, draft, empty
    }

    /// One face as drawn: from a line box's top to its baseline, the cap
    /// height above the baseline, the descender below it, and the line.
    public struct FontMetrics: Equatable, Sendable {
        public var ascender: CGFloat
        public var capHeight: CGFloat
        public var descender: CGFloat
        public var lineHeight: CGFloat

        public init(ascender: CGFloat, capHeight: CGFloat, descender: CGFloat, lineHeight: CGFloat) {
            self.ascender = ascender
            self.capHeight = capHeight
            self.descender = descender
            self.lineHeight = lineHeight
        }

        /// Figtree's own (ascender 0.95, cap 0.7, descender 0.25 of the
        /// size, no line gap), for a size the views have not measured.
        public static func figtree(_ size: CGFloat) -> FontMetrics {
            FontMetrics(ascender: 0.95 * size, capHeight: 0.7 * size, descender: 0.25 * size, lineHeight: 1.2 * size)
        }
    }

    /// A story row's type as the views measure it, at the person's text
    /// size: the fonts grow, the card's structure stays.
    public struct StoryText: Equatable, Sendable {
        /// The text size's multiplier, 1 as designed.
        public var scale: CGFloat
        public var title: FontMetrics
        public var time: FontMetrics
        public var status: FontMetrics
        /// Where a status line's baseline falls in its line box, as drawn.
        public var statusBaseline: CGFloat

        public init(scale: CGFloat, title: FontMetrics, time: FontMetrics, status: FontMetrics, statusBaseline: CGFloat) {
            self.scale = scale
            self.title = title
            self.time = time
            self.status = status
            self.statusBaseline = statusBaseline
        }

        /// The design's sizes in Figtree's metrics, the baseline as CSS
        /// centres a line's content in it.
        public static func standard(scale: CGFloat = 1) -> StoryText {
            typealias S = StemCellsStoryRowMetrics
            let status = FontMetrics.figtree(S.statusSize * scale)
            return StoryText(scale: scale, title: .figtree(S.titleSize * scale), time: .figtree(S.timeSize * scale), status: status, statusBaseline: (S.statusLine * scale - status.lineHeight) / 2 + status.ascender)
        }

        public var statusLine: CGFloat { StemCellsStoryRowMetrics.statusLine * scale }
    }

    /// What a story row draws beside its title.
    public struct StoryRow: Equatable, Sendable {
        public var corner: Corner
        /// The time at the end of the first line, as measured; 0 for none.
        public var timeWidth: CGFloat
        public var last: LastLine
        public var text: StoryText

        public init(corner: Corner = .none, timeWidth: CGFloat = 0, last: LastLine = .status, text: StoryText = .standard()) {
            self.corner = corner
            self.timeWidth = timeWidth
            self.last = last
            self.text = text
        }
    }

    public struct Frame: Equatable, Sendable {
        /// The row box: the tap target and its fill, in content coordinates.
        public var box: CGRect
        /// The leading mark, absent for a row without one; then the label
        /// starts there. A story row's disc.
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
        /// A story row's ring box, around its disc, kept with no ring too.
        public var ring: CGRect?
        /// A story row's status, one or two lines tall.
        public var subtitle: CGRect?
        /// The signal: the dot or the braille loader, in `signalLane`.
        public var corner: CGRect?
        /// A story row's signal lane, one width whatever it holds.
        public var signalLane: CGRect?
        /// A story row's time, at the end of its first line.
        public var time: CGRect?
        /// A story row's last line, holding the person's draft.
        public var draft: CGRect?
        /// A story row's empty mark, on its last line, on whole pixels.
        public var empty: CGRect?

        public init(box: CGRect, mark: CGRect? = nil, label: CGRect = .zero, trailing: CGRect? = nil, chevron: CGRect? = nil, chevronGlyph: CGRect? = nil, add: CGRect? = nil, rule: CGRect? = nil, ring: CGRect? = nil, subtitle: CGRect? = nil, corner: CGRect? = nil, signalLane: CGRect? = nil, time: CGRect? = nil, draft: CGRect? = nil, empty: CGRect? = nil) {
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
            self.signalLane = signalLane
            self.time = time
            self.draft = draft
            self.empty = empty
        }
    }

    public struct Result: Equatable, Sendable {
        public var frames: [Frame]
        /// The tree's lines: vertical stems and the elbows into nested rows, `line` wide.
        public var connectors: [CGRect]
        public var contentHeight: CGFloat
    }

    public static func height(_ row: Row) -> CGFloat {
        if row.kind == .row, let story = row.story { return storyHeight(story.text.scale) }
        if row.kind == .section, row.amongStories { return StemCellsStoryRowMetrics.headingHeight }
        if row.kind == .separator, row.amongStories { return StemCellsStoryRowMetrics.separatorHeight }
        return height(row.kind)
    }

    /// A story card: 64 as designed and smaller, and taller by what its
    /// three lines grow at a larger text size.
    public static func storyHeight(_ scale: CGFloat) -> CGFloat {
        typealias S = StemCellsStoryRowMetrics
        let lines = (S.titleToStatus + S.statusLine * CGFloat(S.statusLines)) * (scale - 1)
        return S.rowHeight + max(0, lines)
    }

    public static func height(_ kind: Kind) -> CGFloat {
        switch kind {
        case .row: StemCellsMetrics.rowHeight
        case .section: StemCellsMetrics.sectionHeight
        case .separator: StemCellsMetrics.separatorHeight
        case .widget: StemCellsMetrics.widgetMinHeight
        }
    }

    /// Between a row and the one before it: 6.5 into a card from a card or
    /// a heading, 12.5 from a card down to a heading, desktop's 2 between
    /// anything else among story rows, the column's gap otherwise.
    static func gap(_ row: Row, after previous: Row) -> CGFloat {
        typealias S = StemCellsStoryRowMetrics
        if row.story != nil, previous.story != nil || previous.kind == .section { return S.rowGap }
        if previous.story != nil, row.kind == .section { return S.headingGap }
        if row.amongStories || row.story != nil, previous.amongStories || previous.story != nil { return S.headingsGap }
        return StemCellsMetrics.rowGap
    }

    public static func layout(_ rows: [Row], width: CGFloat, top: CGFloat = StemCellsMetrics.contentTop, bottom: CGFloat = StemCellsMetrics.contentBottom, scale: CGFloat = 3) -> Result {
        typealias M = StemCellsMetrics
        var frames: [Frame] = []
        frames.reserveCapacity(rows.count)
        var y = top
        let boxX = M.inset
        let boxWidth = max(0, width - 2 * M.inset)
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        for (index, row) in rows.enumerated() {
            if index > 0 { y += gap(row, after: rows[index - 1]) }
            let height = height(row)
            if row.kind == .row, let story = row.story {
                frames.append(storyRow(story, hasMark: row.hasMark, y: y, width: width, scale: scale))
                y += height
                continue
            }
            if row.kind == .section, row.amongStories {
                frames.append(storyHeading(row, y: y, width: width, scale: scale))
                y += height
                continue
            }
            let box = CGRect(x: boxX, y: y, width: boxWidth, height: height)
            let midY = y + height / 2
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
            case .separator where row.amongStories:
                // Desktop's own: the box 6 in, the hairline 6 in from its ends.
                let story = StemCellsStoryRowMetrics.self
                frame.box = CGRect(x: story.rowInset, y: y, width: max(0, width - 2 * story.rowInset), height: height)
                let inset = story.rowInset + story.ruleInset
                frame.rule = CGRect(x: inset, y: (midY - M.line / 2).rounded(.down), width: max(0, width - 2 * inset), height: M.line)
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
                if row.hasTrailing == false, row.kind == .row, row.hasWorkingSignal {
                    let signal = StemCellsStoryRowMetrics.braille
                    frame.corner = CGRect(x: slot.midX - signal.width / 2, y: slot.midY - signal.height / 2, width: signal.width, height: signal.height)
                    frame.label.size.width = max(0, slot.minX - M.trailingGap - x)
                }
            }
            frames.append(frame)
            y += height
        }
        return Result(frames: frames, connectors: connectors(rows, frames), contentHeight: y + bottom)
    }

    /// Desktop's story row, on Telegram's chat list: the card 3 in from
    /// the list; the disc 7 into it and centred on its height, the ring's
    /// box around it; the text 10 past the disc. The last status baseline
    /// stands `corner` above the card's bottom, the first one line above
    /// it, the title's baseline `titleToStatus` above that. The time ends
    /// the title's line with its cap top on the title's; the signal's lane
    /// stands on the last baseline. Both end `corner` inside the card, and
    /// the status ends the lane's room before it, whatever the lane holds.
    static func storyRow(_ story: StoryRow, hasMark: Bool, y: CGFloat, width: CGFloat, scale: CGFloat) -> Frame {
        typealias S = StemCellsStoryRowMetrics
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        let text = story.text
        let box = CGRect(x: S.cardInset, y: y, width: max(0, width - 2 * S.cardInset), height: storyHeight(text.scale))
        var frame = Frame(box: box)
        let disc = CGRect(x: box.minX + S.pad, y: pixel(box.midY - S.disc / 2), width: S.disc, height: S.disc)
        if hasMark {
            frame.mark = disc
            frame.ring = disc.insetBy(dx: -S.ringRoom, dy: -S.ringRoom)
        }
        // Every row keeps the disc's room, so the text starts on one line.
        let x = disc.maxX + S.textGap
        let last = box.maxY - S.corner
        let first = last - text.statusLine
        let titleBaseline = first - S.titleToStatus * text.scale

        let lane = CGRect(x: box.maxX - S.corner - S.signal, y: last - S.signal, width: S.signal, height: S.signal)
        frame.signalLane = lane
        switch story.corner {
        case .none: break
        case .dot:
            frame.corner = CGRect(x: pixel(lane.maxX - S.dot), y: pixel(last - S.dot), width: S.dot, height: S.dot)
        case .braille:
            frame.corner = CGRect(x: pixel(lane.maxX - S.braille.width), y: pixel(last - S.braille.height), width: S.braille.width, height: S.braille.height)
        }

        var titleEnd = box.maxX - S.pad
        if story.timeWidth > 0 {
            let right = box.maxX - S.corner + S.timeBearing
            let width = min(story.timeWidth, max(0, right - x))
            let baseline = titleBaseline - text.title.capHeight + text.time.capHeight
            let time = CGRect(x: right - width, y: baseline - text.time.ascender, width: width, height: text.time.lineHeight)
            frame.time = time
            titleEnd = time.minX - S.timeGap
        }
        frame.label = CGRect(x: x, y: titleBaseline - text.title.ascender, width: max(0, titleEnd - x), height: text.title.lineHeight)

        let statusEnd = lane.minX - (S.signalRoom - S.signal)
        let statusWidth = max(0, statusEnd - x)
        let lines = story.last == .status ? CGFloat(S.statusLines) : 1
        frame.subtitle = CGRect(x: x, y: first - text.statusBaseline, width: statusWidth, height: text.statusLine * lines)
        switch story.last {
        case .status: break
        case .draft:
            frame.draft = CGRect(x: x, y: last - text.statusBaseline, width: statusWidth, height: text.statusLine)
        case .empty:
            // The dinosaur as tall as "Ag", its ground one cell under it,
            // on whole pixels so every cell stays crisp.
            let pixels = max(1, scale)
            let tall = (text.status.capHeight + text.status.descender) * S.emptyRows / (S.emptyRows - 1)
            let height = (tall * pixels).rounded() / pixels
            let wide = ((tall * S.emptyColumns / S.emptyRows) * pixels).rounded() / pixels
            frame.empty = CGRect(x: pixel(x), y: pixel(last - text.status.capHeight), width: wide, height: height)
        }
        return frame
    }

    /// A heading among story rows, as desktop's: the row box 6 in from the
    /// list, the title from the discs' left edge; the fold's 18 box 7 in
    /// from the row box's right, its 12 glyph in its middle with its ink's
    /// optical centre on the box's; the "+" one 22 step before it. The title
    /// keeps 4 clear of the fold (`padding-right: inset + 22`), and of the
    /// "+" the same way.
    static func storyHeading(_ row: Row, y: CGFloat, width: CGFloat, scale: CGFloat) -> Frame {
        typealias S = StemCellsStoryRowMetrics
        typealias M = StemCellsMetrics
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        let box = CGRect(x: S.rowInset, y: y, width: max(0, width - 2 * S.rowInset), height: S.headingHeight)
        var frame = Frame(box: box)
        let fold = CGRect(x: box.maxX - S.headingFoldInset - S.headingBox, y: box.midY - S.headingBox / 2, width: S.headingBox, height: S.headingBox)
        // The ink offsets are measured at a row's glyph; this one is smaller.
        let ink = row.foldClosed ? M.chevronRightInk : M.chevronDownInk
        let shrink = S.headingGlyph / M.chevronGlyph
        frame.chevron = fold
        frame.chevronGlyph = CGRect(x: pixel(fold.midX - S.headingGlyph / 2 - ink.dx * shrink), y: pixel(fold.midY - S.headingGlyph / 2 - ink.dy * shrink), width: S.headingGlyph, height: S.headingGlyph)
        var end = fold.minX
        if row.hasAdd {
            let add = fold.offsetBy(dx: -S.headingStep, dy: 0)
            frame.add = add
            end = add.minX
        }
        let clear = S.headingStep - S.headingBox
        frame.label = CGRect(x: S.headingInset, y: y, width: max(0, end - clear - S.headingInset), height: box.height)
        return frame
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
    /// Story rows don't nest.
    static func connectors(_ rows: [Row], _ frames: [Frame]) -> [CGRect] {
        typealias M = StemCellsMetrics
        var lines: [CGRect] = []
        var parents: [Int: Int] = [:]
        var children: [Int: [Int]] = [:]
        var order: [Int] = []
        for (index, row) in rows.enumerated() where row.depth > 0 && row.kind == .row && row.story == nil {
            var parent = index - 1
            while parent >= 0, rows[parent].depth >= row.depth { parent -= 1 }
            guard parent >= 0, rows[parent].depth == row.depth - 1, rows[parent].story == nil else { continue }
            parents[index] = parent
            if children[parent] == nil { order.append(parent) }
            children[parent, default: []].append(index)
        }
        for parent in order {
            let kids = children[parent] ?? []
            let parentMark = frames[parent].mark
            let stemX = ((parentMark.map(\.midX) ?? leadingX(depth: rows[parent].depth) + M.mark / 2) - M.line / 2).rounded(.down)
            let top = frames[parent].box.midY + (parentMark.map { $0.height / 2 } ?? M.stemInset)
            let bottom = (kids.map { frames[$0].box.midY }.max() ?? top) + M.line
            lines.append(CGRect(x: stemX, y: top, width: M.line, height: max(0, bottom - top)))
            for kid in kids {
                let end = leadingX(depth: rows[kid].depth) - M.elbowGap
                lines.append(CGRect(x: stemX + M.line, y: (frames[kid].box.midY - M.line / 2).rounded(.down), width: max(0, end - stemX - M.line), height: M.line))
            }
        }
        return lines
    }
}
