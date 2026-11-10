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
///     replies    quick replies one under another, 6 apart, their boxes on
///                the column's left edge as a card's is: every pill as wide
///                as the widest option's own width, then a 16 tick's room,
///                at most a person's widest bubble; its label 12 in, at
///                most two lines, each pill as tall as its own label
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
        /// Controls that can't be used, or no longer.
        public static let disabledAlpha: CGFloat = 0.48
    }

    public enum Input {
        case tree([(depth: Int, name: Measurable)])
        case line(Measurable)
        case card(title: Measurable, lines: [Measurable], buttons: [Measurable])
        /// Each option's label, two lines at most.
        case replies([Measurable])
    }

    /// A button or a reply, its label, and a reply's tick.
    public struct Button: Equatable, Sendable {
        public var frame: CGRect
        public var label: CGRect
        public var tick: CGRect?

        public init(frame: CGRect, label: CGRect, tick: CGRect? = nil) {
            self.frame = frame
            self.label = label
            self.tick = tick
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
        case .replies(let labels):
            // At most a person's widest bubble (`MessageLayout.user`).
            typealias B = MessageLayout.Metrics
            let cap = max(0, width - (B.bubbleLeading - B.marginH))
            let pad = B.bubblePaddingH
            let tickRoom = M.tickGap + M.tick
            // Every pill the widest option's own width, so they stand as one stack.
            let natural = labels.map { 2 * pad + $0.size(fitting: .greatestFiniteMagnitude).width.rounded(.up) + tickRoom }
            let pill = min(cap, natural.max() ?? 0)
            let labelWidth = max(0, pill - 2 * pad - tickRoom)
            for (index, one) in labels.enumerated() {
                if index > 0 { y += M.replyGap }
                let height = one.height(fitting: labelWidth).rounded(.up)
                let frame = CGRect(x: 0, y: y, width: pill, height: height + 2 * B.bubblePaddingV)
                let label = CGRect(x: pad, y: y + B.bubblePaddingV, width: labelWidth, height: height)
                let tick = CGRect(x: pill - pad - M.tick, y: y + ((frame.height - M.tick) / 2).rounded(), width: M.tick, height: M.tick)
                buttons.append(Button(frame: frame, label: label, tick: tick))
                y = frame.maxY
            }
            size = CGSize(width: width, height: y)
        }
    }
}
