import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Rich tasks' frames, top to bottom: section headers, 3-line cards, the
/// sub-rows under them and "+N more", as the desktop's proposal lays them
/// out (corner B). Lines sit where its browser puts them: each baseline half
/// the leading over the face's rounded ascent and descent, floored.
///
/// One inset `e` rules a card's corners: the title's cap top and the time's
/// stand `e` under the highlight's top, the last status baseline `e` over its
/// bottom, and the time, the corner items and every sub-row's trail end `e`
/// inside its right edge.
public enum TaskListLayout {
    public typealias M = TaskListMetrics

    /// One face as drawn: a label's baseline `ascender` under its top.
    public struct Face: Equatable, Sendable {
        public var ascender: CGFloat
        public var descender: CGFloat
        public var capHeight: CGFloat
        public var xHeight: CGFloat
        public var lineHeight: CGFloat

        public init(ascender: CGFloat, descender: CGFloat, capHeight: CGFloat, xHeight: CGFloat, lineHeight: CGFloat) {
            self.ascender = ascender; self.descender = descender; self.capHeight = capHeight; self.xHeight = xHeight; self.lineHeight = lineHeight
        }

        /// Figtree's own metrics at `size`.
        public static func figtree(_ size: CGFloat) -> Face {
            Face(ascender: 0.95 * size, descender: 0.25 * size, capHeight: 0.7 * size, xHeight: 0.5 * size, lineHeight: 1.2 * size)
        }

        /// The baseline in a CSS line box `line` tall, from its top.
        public func baseline(in line: CGFloat) -> CGFloat {
            ((line - ascender.rounded() - descender.rounded()) / 2).rounded(.down) + ascender.rounded()
        }
    }

    public struct Text: Equatable, Sendable {
        public var title, time, status, row, more, header: Face
        /// A status line's baseline under its top, as TextKit sets a 16 line.
        public var statusBaseline: CGFloat

        public init(title: Face, time: Face, status: Face, row: Face, more: Face, header: Face, statusBaseline: CGFloat) {
            self.title = title; self.time = time; self.status = status; self.row = row; self.more = more; self.header = header
            self.statusBaseline = statusBaseline
        }

        public static let figtree = Text(title: .figtree(M.titleSize), time: .figtree(M.timeSize), status: .figtree(M.statusSize), row: .figtree(M.subRowSize),
                                         more: .figtree(M.moreSize), header: .figtree(M.headerSize), statusBaseline: Face.figtree(M.statusSize).baseline(in: M.statusLine))

        /// From the title line's top: its baseline, on the time's when that stands lower (`align-items: baseline`).
        var titleBaseline: CGFloat { max(title.baseline(in: M.titleLine), time.baseline(in: M.rowLine)) }
        /// The card's last status baseline from the title line's top.
        var lastBaseline: CGFloat { M.titleLine - M.statusOverlap + M.statusLine + status.baseline(in: M.statusLine) }
        /// The title block's top in the highlight, so the cap top stands as far under its top as the last baseline over its bottom.
        var blockTop: CGFloat { (M.cardHeight - 2 * M.highlightInset - lastBaseline - titleBaseline + title.capHeight) / 2 }
        /// `e`: the corners' one inset.
        public var edge: CGFloat { blockTop + titleBaseline - title.capHeight }
    }

    public struct Card: Equatable, Sendable {
        public var timeWidth: CGFloat
        /// "+N more" in the corner, as measured; nil for none.
        public var moreWidth: CGFloat?
        public var faces: Int
        public var signal: SidebarLayout.Corner
        public var story: Bool
        public init(timeWidth: CGFloat = 0, moreWidth: CGFloat? = nil, faces: Int = 0, signal: SidebarLayout.Corner = .none, story: Bool = false) {
            self.timeWidth = timeWidth; self.moreWidth = moreWidth; self.faces = faces; self.signal = signal; self.story = story
        }
    }

    public enum Item: Equatable, Sendable {
        case header(collapsed: Bool)
        case card(Card)
        /// `metaWidth` the measured text before the braille, 0 for none.
        case subRow(metaWidth: CGFloat, working: Bool)
        case more
    }

    public struct Frame: Equatable, Sendable {
        /// The row: its tap target, in the list's coordinates like everything here.
        public var box: CGRect
        public var highlight: CGRect = .zero
        public var radius: CGFloat = 0
        /// The title, a sub-row's or "more"'s text, or a header's.
        public var label: CGRect = .zero
        public var baseline: CGFloat = 0
        public var disc: CGRect?
        public var ring: CGRect?
        public var icon: CGRect?
        public var time: CGRect?
        public var status: CGRect?
        /// The status's second line ends here, short of the corner.
        public var statusEnd: CGFloat?
        public var lastBaseline: CGFloat?
        /// A card's "+N more", its faces and its signal; a sub-row's braille.
        public var more: CGRect?
        public var faces: [CGRect] = []
        public var signal: CGRect?
        public var mark: CGRect?
        public var meta: CGRect?
        public var chevron: CGRect?
    }

    public struct Result: Equatable, Sendable {
        public var frames: [Frame]
        public var height: CGFloat
        public init(frames: [Frame], height: CGFloat) { self.frames = frames; self.height = height }
    }

    public static func layout(_ items: [Item], width: CGFloat, text: Text = .figtree) -> Result {
        var frames: [Frame] = []
        var y = M.top
        for item in items {
            let frame: Frame
            switch item {
            case .header(let collapsed):
                y += collapsed ? M.foldedHeaderGap : M.headerGap
                frame = header(y: y, width: width, text: text)
            case .card(let card):
                frame = self.card(card, box: row(y, M.cardHeight, width), text: text)
            case .subRow(let metaWidth, let working):
                frame = subRow(metaWidth: metaWidth, working: working, box: row(y, M.subRowHeight, width), text: text)
            case .more:
                let box = row(y, M.moreHeight, width)
                let baseline = box.minY + text.more.baseline(in: M.moreHeight)
                frame = Frame(box: box, label: label(x: box.minX + textX, to: box.maxX - text.edge, baseline: baseline, text.more), baseline: baseline)
            }
            frames.append(frame)
            y = frame.box.maxY
        }
        return Result(frames: frames, height: y + M.bottom)
    }

    /// Where a card's text starts, from its row's left: past the disc, as a sub-row's does past its mark.
    static let textX = M.pad + M.disc + M.textGap

    static func row(_ y: CGFloat, _ height: CGFloat, _ width: CGFloat) -> CGRect {
        CGRect(x: M.inset, y: y, width: max(0, width - 2 * M.inset), height: height)
    }

    static func label(x: CGFloat, to end: CGFloat, baseline: CGFloat, _ face: Face) -> CGRect {
        CGRect(x: x, y: baseline - face.ascender, width: max(0, end - x), height: face.lineHeight)
    }

    static func card(_ card: Card, box: CGRect, text: Text) -> Frame {
        let hl = box.insetBy(dx: 0, dy: M.highlightInset)
        let e = text.edge
        var frame = Frame(box: box, highlight: hl, radius: M.cardRadius)
        let disc = CGRect(x: hl.minX + M.pad, y: hl.minY + M.pad, width: M.disc, height: M.disc)
        let icon = card.story ? M.storyIcon : M.icon
        // A story's ring is the disc's edge; its fill stands clear inside it.
        frame.disc = card.story ? disc.insetBy(dx: M.storyFill, dy: M.storyFill) : disc
        frame.ring = card.story ? disc : nil
        frame.icon = disc.insetBy(dx: (M.disc - icon) / 2, dy: (M.disc - icon) / 2)
        let x = box.minX + textX
        let titleBaseline = hl.minY + text.blockTop + text.titleBaseline
        let last = hl.maxY - e
        frame.baseline = titleBaseline
        frame.lastBaseline = last
        // The time ends `e` in, its cap top on the title's.
        let timeBaseline = titleBaseline - text.title.capHeight + text.time.capHeight
        let time = CGRect(x: hl.maxX - e - card.timeWidth, y: timeBaseline - text.time.ascender, width: card.timeWidth, height: text.time.lineHeight)
        frame.time = time
        frame.label = label(x: x, to: card.timeWidth > 0 ? time.minX - M.timeGap : hl.maxX - e, baseline: titleBaseline, text.title)
        // Corner B, right to left: the signal, the faces, "+N more", centred on the last line's x-height.
        let middle = last - text.status.xHeight / 2
        var right = hl.maxX - e
        func chip(_ width: CGFloat) -> CGRect {
            defer { right -= width + M.cornerGap }
            return CGRect(x: right - width, y: middle - M.chip / 2, width: width, height: M.chip)
        }
        switch card.signal {
        case .none: break
        case .dot: frame.signal = chip(M.chip)
        case .braille: frame.signal = chip(M.brailleWidth)
        }
        let faces = min(card.faces, M.faces)
        if faces > 0 {
            let all = chip(M.chip + CGFloat(faces - 1) * M.faceStep)
            frame.faces = (0..<faces).map { CGRect(x: all.minX + CGFloat($0) * M.faceStep, y: all.minY, width: M.chip, height: M.chip) }
        }
        // A text button, so it stands on the line's baseline as its words would.
        if let width = card.moreWidth {
            frame.more = label(x: right - width, to: right, baseline: last, text.more)
            right -= width + M.cornerGap
        }
        let statusRight = hl.maxX - M.statusEnd
        frame.status = CGRect(x: x, y: last - M.statusLine - text.statusBaseline, width: max(0, statusRight - x), height: 2 * M.statusLine)
        if right < hl.maxX - e { frame.statusEnd = right }
        return frame
    }

    static func subRow(metaWidth: CGFloat, working: Bool, box: CGRect, text: Text) -> Frame {
        let hl = CGRect(x: box.minX + M.subRowHighlight, y: box.minY + M.highlightInset, width: max(0, box.width - M.subRowHighlight), height: box.height - 2 * M.highlightInset)
        var frame = Frame(box: box, highlight: hl, radius: M.subRowRadius)
        let markX = box.minX + textX - M.textGap - M.mark
        frame.mark = CGRect(x: markX, y: box.midY - M.mark / 2, width: M.mark, height: M.mark)
        let baseline = box.minY + (box.height - M.rowLine) / 2 + text.row.baseline(in: M.rowLine)
        frame.baseline = baseline
        // The trail, right to left: the braille, then the meta.
        let right = hl.maxX - text.edge
        var trail: CGFloat?
        if working {
            frame.signal = CGRect(x: right - M.brailleWidth, y: box.midY - M.chip / 2, width: M.brailleWidth, height: M.chip)
            trail = right - M.brailleWidth
        }
        if metaWidth > 0 {
            let end = trail.map { $0 - M.cornerGap } ?? right
            frame.meta = label(x: end - metaWidth, to: end, baseline: baseline, text.time)
            trail = end - metaWidth
        }
        frame.label = label(x: box.minX + textX, to: trail.map { $0 - M.trailGap } ?? right, baseline: baseline, text.row)
        return frame
    }

    static func header(y: CGFloat, width: CGFloat, text: Text) -> Frame {
        let box = CGRect(x: 0, y: y, width: width, height: M.headerHeight)
        let baseline = box.minY + (box.height - M.rowLine) / 2 + text.header.baseline(in: M.rowLine)
        // The fold is a character after the title ("⌄", "›"), on its baseline, ending 14 in.
        let chevron = label(x: width - M.headerInset - M.chevron, to: width - M.headerInset, baseline: baseline, text.header)
        return Frame(box: box, label: label(x: M.headerInset, to: chevron.minX - M.cornerGap, baseline: baseline, text.header), baseline: baseline, chevron: chevron)
    }
}
