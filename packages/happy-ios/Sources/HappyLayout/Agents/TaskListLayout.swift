import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Rich task cards' frames in a grouped card, top to bottom: cards, their
/// sub-rows and "+N more" (`design/ios-sizing.md`). One inset `e` rules a
/// card's highlight: the title's cap top `e` under its top, the last baseline
/// `e` over its bottom, the disc `e` in, and the time, the corner and every
/// sub-row's trail ending `e` inside its right edge, 16 from the grouped card's.
public enum TaskListLayout {
    public typealias M = TaskListMetrics

    /// One face as drawn: a label's baseline `ascender` under its top.
    public struct Face: Equatable, Sendable {
        public var ascender, capHeight, xHeight, lineHeight: CGFloat

        public init(ascender: CGFloat, capHeight: CGFloat, xHeight: CGFloat, lineHeight: CGFloat) {
            self.ascender = ascender; self.capHeight = capHeight; self.xHeight = xHeight; self.lineHeight = lineHeight
        }
    }

    public struct Text: Equatable, Sendable {
        public var title, time, status, row, more: Face
        /// Subheadline's Dynamic Type scale (1 at Large, `s`), and the disc at this size.
        public var scale, disc: CGFloat
        /// A status line's baseline under its top, as TextKit sets it.
        public var statusBaseline: CGFloat

        public init(title: Face, time: Face, status: Face, row: Face, more: Face, scale: CGFloat, disc: CGFloat, statusBaseline: CGFloat) {
            self.title = title; self.time = time; self.status = status; self.row = row; self.more = more
            self.scale = scale; self.disc = disc; self.statusBaseline = statusBaseline
        }
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
        /// The title, or a sub-row's or "more"'s text.
        public var label: CGRect = .zero
        public var baseline: CGFloat = 0
        public var disc, ring, icon, time, status: CGRect?
        /// Where the status's second line ends, short of the corner; its baseline.
        public var statusEnd, lastBaseline: CGFloat?
        public var faces: [CGRect] = []
        /// A card's "+N more" and signal (a sub-row's braille), and the hairline over a card after the first.
        public var more, signal, mark, meta, separator: CGRect?
    }

    public struct Result: Equatable, Sendable {
        public var frames: [Frame]
        public var height: CGFloat
    }

    /// The room above the first row and below the last: the highlights stand `16 − e` in from every side of the grouped card.
    public static let room = M.inset - M.highlightInset

    public static func layout(_ items: [Item], width: CGFloat, text: Text, hairline: CGFloat = 1) -> Result {
        var frames: [Frame] = []
        var y = room
        for item in items {
            var frame: Frame
            switch item {
            case .card(let card):
                frame = self.card(card, y: y, width: width, text: text)
                if frames.contains(where: { $0.disc != nil }) { frame.separator = CGRect(x: frame.label.minX, y: y, width: max(0, width - frame.label.minX), height: hairline) }
            case .subRow(let metaWidth, let working):
                frame = subRow(metaWidth: metaWidth, working: working, y: y, width: width, text: text)
            case .more:
                let box = row(y, max(M.moreHeight, M.statusLine * text.scale + M.moreRoom), width)
                let baseline = box.midY + text.more.xHeight / 2
                frame = Frame(box: box, label: label(x: textX(box, text), to: box.maxX - M.edge, baseline: baseline, text.more), baseline: baseline)
            }
            frames.append(frame)
            y = frame.box.maxY
        }
        return Result(frames: frames, height: y + room)
    }

    static func row(_ y: CGFloat, _ height: CGFloat, _ width: CGFloat) -> CGRect {
        CGRect(x: M.inset, y: y, width: max(0, width - 2 * M.inset), height: height)
    }

    /// Where a card's text starts: past the disc, as a sub-row's does past its mark.
    static func textX(_ box: CGRect, _ text: Text) -> CGFloat { box.minX + M.edge + text.disc + M.textGap }

    static func label(x: CGFloat, to end: CGFloat, baseline: CGFloat, _ face: Face) -> CGRect {
        CGRect(x: x, y: baseline - face.ascender, width: max(0, end - x), height: face.lineHeight)
    }

    static func card(_ card: Card, y: CGFloat, width: CGFloat, text: Text) -> Frame {
        let s = text.scale, e = M.edge
        let lit = max(text.disc + M.discRoom, text.title.capHeight + (M.titleToStatus + M.statusLine) * s + 2 * e)
        let box = row(y, lit + 2 * M.highlightInset, width), hl = box.insetBy(dx: 0, dy: M.highlightInset)
        var frame = Frame(box: box, highlight: hl, radius: M.cardRadius)
        let disc = CGRect(x: hl.minX + e, y: hl.midY - text.disc / 2, width: text.disc, height: text.disc)
        let icon = text.disc * (card.story ? M.storyIconShare : M.iconShare)
        // A story's ring is the disc's edge; its fill stands clear inside it.
        frame.disc = card.story ? disc.insetBy(dx: M.storyFill, dy: M.storyFill) : disc
        frame.ring = card.story ? disc : nil
        frame.icon = disc.insetBy(dx: (text.disc - icon) / 2, dy: (text.disc - icon) / 2)
        let x = textX(box, text), right = hl.maxX - e
        let baseline = hl.minY + e + text.title.capHeight, last = baseline + (M.titleToStatus + M.statusLine) * s
        (frame.baseline, frame.lastBaseline) = (baseline, last)
        // The time ends `e` in, its cap top on the title's.
        let timeTop = baseline - text.title.capHeight + text.time.capHeight - text.time.ascender
        let time = CGRect(x: right - card.timeWidth, y: timeTop, width: card.timeWidth, height: text.time.lineHeight)
        frame.time = time
        frame.label = label(x: x, to: card.timeWidth > 0 ? time.minX - M.timeGap : right, baseline: baseline, text.title)
        // Corner B, right to left: the signal, the faces, "+N more", centred on the last line's x-height.
        let middle = last - text.status.xHeight / 2, chip = M.chip * s, gap = M.cornerGap * s
        var end = right
        func lane(_ width: CGFloat) -> CGRect {
            defer { end -= width + gap }
            return CGRect(x: end - width, y: middle - chip / 2, width: width, height: chip)
        }
        switch card.signal {
        case .none: break
        case .dot: frame.signal = lane(chip)
        case .braille: frame.signal = lane(M.brailleWidth * s)
        }
        let faces = min(card.faces, M.faces), step = chip * M.faceStep
        if faces > 0 {
            let all = lane(chip + CGFloat(faces - 1) * step)
            frame.faces = (0..<faces).map { CGRect(x: all.minX + CGFloat($0) * step, y: all.minY, width: chip, height: chip) }
        }
        // A text button, so it stands on the line's baseline as its words would.
        if let width = card.moreWidth {
            frame.more = label(x: end - width, to: end, baseline: last, text.more)
            end -= width + gap
        }
        frame.status = CGRect(x: x, y: baseline + M.titleToStatus * s - text.statusBaseline, width: max(0, right - x), height: 2 * M.statusLine * s)
        if end < right { frame.statusEnd = end }
        return frame
    }

    static func subRow(metaWidth: CGFloat, working: Bool, y: CGFloat, width: CGFloat, text: Text) -> Frame {
        let s = text.scale, box = row(y, max(M.hit, M.statusLine * s + M.subRowRoom), width)
        let side = M.mark * s, mark = CGRect(x: textX(box, text) - M.textGap - side, y: box.midY - side / 2, width: side, height: side)
        let hl = CGRect(x: mark.minX - M.markLead, y: box.minY + M.highlightInset, width: max(0, box.maxX - mark.minX + M.markLead), height: box.height - 2 * M.highlightInset)
        var frame = Frame(box: box, highlight: hl, radius: M.subRowRadius)
        frame.mark = mark
        // Its x-height on the row's middle.
        let baseline = box.midY + text.row.xHeight / 2
        frame.baseline = baseline
        // The trail, right to left: the braille, then the meta on the text's baseline.
        var right = box.maxX - M.edge, end = right
        if working {
            let signal = CGRect(x: right - M.brailleWidth * s, y: box.midY - M.chip * s / 2, width: M.brailleWidth * s, height: M.chip * s)
            (frame.signal, right, end) = (signal, signal.minX - M.cornerGap * s, signal.minX - M.trailGap)
        }
        if metaWidth > 0 {
            frame.meta = label(x: right - metaWidth, to: right, baseline: baseline, text.time)
            end = right - metaWidth - M.trailGap
        }
        frame.label = label(x: textX(box, text), to: end, baseline: baseline, text.row)
        return frame
    }
}
