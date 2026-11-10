#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Foundation

/// One chat UI component in an agent's message (happy-agent "Chat UI"),
/// or its quick replies, at the reading column's left:
///
///     tree       a file tree's rows, 24 tall, 16 in per level, a 14 glyph
///     line       one plain text line, a fallback or captions, full width
///     card       a live component: a box at most 420 wide, 12 in, its
///                title, its lines 4 apart, then its buttons one under
///                another, 8 apart, each at least 44 tall with its label
///                centred 16 in
///     row        a live component as one row (desktop's `UiRow`), in the
///                card's box: a 20 mark 12 in, then its name over one line
///                (a 14 glyph 6 before it while it works, is done, or
///                failed), then its controls against the right, each 36
///                tall, 8 apart; the controls that leave the words less
///                than 100 are left out, the least needed first, so the row
///                is one height whatever it shows
///     replies    quick replies one under another, 6 apart, at the column's
///                left as the agent's words are: every pill as wide as the
///                widest option's own width, at most a person's widest
///                bubble; its label one line, 12 in, after a provider's 16
///                mark, then the room a note may need, then a 16 tick
public struct ChatUiLayout: Equatable, Sendable {
    public enum Metrics {
        public static let maxWidth: CGFloat = 420
        public static let buttonHeight: CGFloat = 44
        public static let buttonPaddingH: CGFloat = 16
        public static let buttonPaddingV: CGFloat = 10
        public static let radius: CGFloat = 12
        public static let border: CGFloat = 1
        public static let gap: CGFloat = 8
        public static let treeRow: CGFloat = 24
        public static let treeIndent: CGFloat = 16
        public static let treeGlyph: CGFloat = 14
        public static let treeGlyphGap: CGFloat = 6
        public static let cardPadding: CGFloat = 12
        public static let lineGap: CGFloat = 4
        public static let replyGap: CGFloat = 6
        public static let tick: CGFloat = 16
        public static let tickGap: CGFloat = 8
        public static let replyMark: CGFloat = 16
        public static let replyMarkGap: CGFloat = 8
        public static let noteGap: CGFloat = 12
        public static let rowMark: CGFloat = 20
        public static let rowMarkGap: CGFloat = 12
        public static let lineMark: CGFloat = 14
        public static let lineMarkGap: CGFloat = 6
        public static let rowControl: CGFloat = 36
        public static let rowControlPaddingH: CGFloat = 12
        public static let rowControlGap: CGFloat = 8
        public static let rowWordsMin: CGFloat = 100
        /// Controls that can't be used, or no longer.
        public static let disabledAlpha: CGFloat = 0.48
    }

    public enum Input {
        case tree([(depth: Int, name: Measurable)])
        case line(Measurable)
        case card(title: Measurable, lines: [Measurable], buttons: [Measurable])
        /// A name, its one line and whether a glyph goes before it, and
        /// the controls in the order they stand.
        case row(name: Measurable, line: Measurable, lineMark: Bool, controls: [RowControl])
        /// Each option, and the room any note takes: the widest a note
        /// may ever say, so a note changing moves nothing.
        case replies([Reply], noteWidth: CGFloat = 0)
    }

    /// A quick reply: its label measured on one line, whether a provider's
    /// mark goes before it, and whether it carries a note.
    public struct Reply {
        public var label: Measurable
        public var mark: Bool
        public var note: Bool

        public init(_ label: Measurable, mark: Bool = false, note: Bool = false) {
            self.label = label
            self.mark = mark
            self.note = note
        }
    }

    /// A row's control: its label measured on one line, or none for a
    /// glyph's square; `rank` 0 is needed most, and kept longest.
    public struct RowControl {
        public var label: Measurable?
        public var rank: Int

        public init(_ label: Measurable?, rank: Int) {
            self.label = label
            self.rank = rank
        }
    }

    /// A button or a reply, its label, and a reply's tick, mark and note.
    public struct Button: Equatable, Sendable {
        public var frame: CGRect
        public var label: CGRect
        public var tick: CGRect?
        public var mark: CGRect?
        public var note: CGRect?

        public init(frame: CGRect, label: CGRect, tick: CGRect? = nil, mark: CGRect? = nil, note: CGRect? = nil) {
            self.frame = frame
            self.label = label
            self.tick = tick
            self.mark = mark
            self.note = note
        }
    }

    /// A file tree's entry: `mark` is its glyph.
    public struct Row: Equatable, Sendable {
        public var frame: CGRect
        public var mark: CGRect
        public var label: CGRect
    }

    public var size: CGSize
    /// A card's buttons, or the replies.
    public var buttons: [Button] = []
    public var rows: [Row] = []
    /// The line, or a card's title.
    public var label: CGRect?
    /// A card's box and its lines.
    public var card: CGRect?
    public var lines: [CGRect] = []
    /// A row's mark, the glyph before its line, and which of its
    /// controls `buttons` are, by their index in the input.
    public var mark: CGRect?
    public var lineMark: CGRect?
    public var shown: [Int] = []

    /// `width` is the column it stands in, from x 0.
    public init(width: CGFloat, input: Input) {
        typealias M = Metrics
        let width = max(0, width)
        let control = min(width, M.maxWidth)
        size = .zero
        var y: CGFloat = 0
        switch input {
        case .tree(let entries):
            for entry in entries {
                let indent = CGFloat(entry.depth) * M.treeIndent
                let x = min(indent, max(0, width - M.treeGlyph))
                let mark = CGRect(x: x, y: y + (M.treeRow - M.treeGlyph) / 2, width: M.treeGlyph, height: M.treeGlyph)
                let labelX = x + M.treeGlyph + M.treeGlyphGap
                let name = entry.name.size(fitting: max(0, width - labelX))
                let label = CGRect(x: labelX, y: y + ((M.treeRow - name.height.rounded(.up)) / 2).rounded(), width: max(0, width - labelX), height: name.height.rounded(.up))
                rows.append(Row(frame: CGRect(x: 0, y: y, width: width, height: M.treeRow), mark: mark, label: label))
                y += M.treeRow
            }
            size = CGSize(width: width, height: y)
        case .line(let text):
            let height = text.height(fitting: width).rounded(.up)
            label = CGRect(x: 0, y: 0, width: width, height: height)
            size = CGSize(width: width, height: height)
        case .card(let title, let texts, let inputs):
            let inner = max(0, control - 2 * M.cardPadding)
            y = M.cardPadding
            let titleFrame = CGRect(x: M.cardPadding, y: y, width: inner, height: title.height(fitting: inner).rounded(.up))
            label = titleFrame
            y = titleFrame.maxY
            for text in texts {
                y += M.lineGap
                let frame = CGRect(x: M.cardPadding, y: y, width: inner, height: text.height(fitting: inner).rounded(.up))
                lines.append(frame)
                y = frame.maxY
            }
            for (index, one) in inputs.enumerated() {
                y += index == 0 ? M.cardPadding : M.gap
                let measured = one.size(fitting: max(0, inner - 2 * M.buttonPaddingH))
                let labelSize = CGSize(width: measured.width.rounded(.up), height: measured.height.rounded(.up))
                let height = max(M.buttonHeight, labelSize.height + 2 * M.buttonPaddingV)
                let frame = CGRect(x: M.cardPadding, y: y, width: inner, height: height)
                let labelFrame = CGRect(x: M.cardPadding + ((inner - labelSize.width) / 2).rounded(), y: y + ((height - labelSize.height) / 2).rounded(),
                                        width: labelSize.width, height: labelSize.height)
                buttons.append(Button(frame: frame, label: labelFrame))
                y += height
            }
            y += M.cardPadding
            card = CGRect(x: 0, y: 0, width: control, height: y)
            size = CGSize(width: control, height: y)
        case .row(let name, let line, let hasLineMark, let controls):
            let inner = max(0, control - 2 * M.cardPadding)
            let words = M.rowMark + M.rowMarkGap
            func controlWidth(_ one: RowControl) -> CGFloat {
                one.label.map { $0.size(fitting: .greatestFiniteMagnitude).width.rounded(.up) + 2 * M.rowControlPaddingH } ?? M.rowControl
            }
            // Leave out the least needed until the words keep their room.
            var kept = Array(controls.indices)
            func used() -> CGFloat { kept.reduce(0) { $0 + controlWidth(controls[$1]) + M.rowControlGap } }
            while !kept.isEmpty, inner - words - used() < M.rowWordsMin {
                let least = kept.max { controls[$0].rank < controls[$1].rank }!
                kept.removeAll { $0 == least }
            }
            let wordsWidth = max(0, inner - words - used())
            let lineX = hasLineMark ? M.lineMark + M.lineMarkGap : 0
            let nameHeight = name.height(fitting: wordsWidth).rounded(.up)
            let lineHeight = line.height(fitting: max(0, wordsWidth - lineX)).rounded(.up)
            let block = nameHeight + M.lineGap / 2 + lineHeight
            let height = 2 * M.cardPadding + max(M.rowControl, block)
            let top = ((height - block) / 2).rounded()
            let x = M.cardPadding + words
            label = CGRect(x: x, y: top, width: wordsWidth, height: nameHeight)
            let lineY = top + nameHeight + M.lineGap / 2
            lines = [CGRect(x: x + lineX, y: lineY, width: max(0, wordsWidth - lineX), height: lineHeight)]
            lineMark = hasLineMark ? CGRect(x: x, y: lineY + ((lineHeight - M.lineMark) / 2).rounded(), width: M.lineMark, height: M.lineMark) : nil
            mark = CGRect(x: M.cardPadding, y: ((height - M.rowMark) / 2).rounded(), width: M.rowMark, height: M.rowMark)
            var right = control - M.cardPadding
            let controlY = ((height - M.rowControl) / 2).rounded()
            for index in kept.reversed() {
                let one = controls[index]
                let width = controlWidth(one)
                let frame = CGRect(x: right - width, y: controlY, width: width, height: M.rowControl)
                let measured = one.label?.size(fitting: .greatestFiniteMagnitude) ?? .zero
                let labelSize = CGSize(width: measured.width.rounded(.up), height: measured.height.rounded(.up))
                let labelFrame = one.label == nil
                    ? frame.insetBy(dx: (M.rowControl - M.tick) / 2, dy: (M.rowControl - M.tick) / 2)
                    : CGRect(x: frame.minX + M.rowControlPaddingH, y: controlY + ((M.rowControl - labelSize.height) / 2).rounded(), width: labelSize.width, height: labelSize.height)
                buttons.insert(Button(frame: frame, label: labelFrame), at: 0)
                shown.insert(index, at: 0)
                right = frame.minX - M.rowControlGap
            }
            card = CGRect(x: 0, y: 0, width: control, height: height)
            size = CGSize(width: control, height: height)
        case .replies(let replies, let noteWidth):
            // At most a person's widest bubble (`MessageLayout.user`).
            typealias B = MessageLayout.Metrics
            let cap = max(0, width - (B.bubbleLeading - B.marginH))
            let pad = B.bubblePaddingH
            let tickRoom = M.tickGap + M.tick
            func markRoom(_ reply: Reply) -> CGFloat { reply.mark ? M.replyMark + M.replyMarkGap : 0 }
            func noteRoom(_ reply: Reply) -> CGFloat { reply.note ? M.noteGap + noteWidth : 0 }
            // Every pill the widest option's own width, so they stand as one stack.
            let natural = replies.map { reply in
                2 * pad + markRoom(reply) + reply.label.size(fitting: .greatestFiniteMagnitude).width.rounded(.up) + noteRoom(reply) + tickRoom
            }
            let pill = min(cap, natural.max() ?? 0)
            for (index, reply) in replies.enumerated() {
                if index > 0 { y += M.replyGap }
                let labelX = pad + markRoom(reply)
                let labelWidth = max(0, pill - labelX - noteRoom(reply) - tickRoom - pad)
                let height = reply.label.height(fitting: labelWidth).rounded(.up)
                let frame = CGRect(x: 0, y: y, width: pill, height: height + 2 * B.bubblePaddingV)
                func centred(_ size: CGFloat, at x: CGFloat) -> CGRect {
                    CGRect(x: x, y: y + ((frame.height - size) / 2).rounded(), width: size, height: size)
                }
                let label = CGRect(x: labelX, y: y + B.bubblePaddingV, width: labelWidth, height: height)
                let tick = centred(M.tick, at: pill - pad - M.tick)
                let mark = reply.mark ? centred(M.replyMark, at: pad) : nil
                let note = reply.note ? CGRect(x: pill - pad - tickRoom - noteWidth, y: label.minY, width: noteWidth, height: height) : nil
                buttons.append(Button(frame: frame, label: label, tick: tick, mark: mark, note: note))
                y = frame.maxY
            }
            size = CGSize(width: width, height: y)
        }
    }
}
