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
///     pills      quick replies: each as wide as its label and 14 either
///                side, at least 36 tall, 8 apart, wrapping to new lines
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
        public static let pillHeight: CGFloat = 36
        public static let pillPaddingH: CGFloat = 14
        public static let pillPaddingV: CGFloat = 8
        /// Controls that can't be used, or no longer.
        public static let disabledAlpha: CGFloat = 0.48
    }

    public enum Input {
        case tree([(depth: Int, name: Measurable)])
        case line(Measurable)
        case card(title: Measurable, lines: [Measurable], buttons: [Measurable])
        case pills([Measurable])
    }

    /// A button or a pill, and its label.
    public struct Button: Equatable, Sendable {
        public var frame: CGRect
        public var label: CGRect
    }

    /// A file tree's entry: `mark` is its glyph.
    public struct Row: Equatable, Sendable {
        public var frame: CGRect
        public var mark: CGRect
        public var label: CGRect
    }

    public var size: CGSize
    /// A card's buttons, or the pills.
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
        case .pills(let labels):
            var x: CGFloat = 0
            var lineHeight: CGFloat = 0
            var widest: CGFloat = 0
            for one in labels {
                let measured = one.size(fitting: max(0, width - 2 * M.pillPaddingH))
                let labelSize = CGSize(width: measured.width.rounded(.up), height: measured.height.rounded(.up))
                let pill = CGSize(width: min(width, labelSize.width + 2 * M.pillPaddingH), height: max(M.pillHeight, labelSize.height + 2 * M.pillPaddingV))
                if x > 0, x + pill.width > width {
                    y += lineHeight + M.gap
                    x = 0
                    lineHeight = 0
                }
                let frame = CGRect(origin: CGPoint(x: x, y: y), size: pill)
                let labelFrame = CGRect(x: x + ((pill.width - labelSize.width) / 2).rounded(), y: y + ((pill.height - labelSize.height) / 2).rounded(),
                                        width: min(labelSize.width, pill.width - 2 * M.pillPaddingH), height: labelSize.height)
                buttons.append(Button(frame: frame, label: labelFrame))
                x += pill.width + M.gap
                lineHeight = max(lineHeight, pill.height)
                widest = max(widest, frame.maxX)
            }
            size = CGSize(width: widest, height: labels.isEmpty ? 0 : y + lineHeight)
        }
    }
}
