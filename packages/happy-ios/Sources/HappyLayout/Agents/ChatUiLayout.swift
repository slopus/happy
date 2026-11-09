#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Foundation

/// One chat UI component in an agent's message (happy-agent "Chat UI"),
/// at the reading column's left:
///
///     buttons    a choice's options, one under another, 8 apart; each at
///                least 44 tall, its label (and a tick, once chosen)
///                centred with 16 either side; at most 420 wide
///     checklist  a row per option, a 20 box then its label and detail
///                under it, then its submit as a button
///     field      a text field's label, its 44 tall box, then its submit
///     tree       a file tree's rows, 24 tall, 16 in per level, a 14 glyph
///     line       one plain text line, a fallback or captions, full width
///     card       a live component: a box at most 420 wide, 12 in, its
///                title, its lines 4 apart, then its buttons as above
public struct ChatUiLayout: Equatable, Sendable {
    public enum Metrics {
        public static let maxWidth: CGFloat = 420
        public static let buttonHeight: CGFloat = 44
        public static let buttonPaddingH: CGFloat = 16
        public static let buttonPaddingV: CGFloat = 10
        public static let radius: CGFloat = 12
        public static let border: CGFloat = 1
        public static let gap: CGFloat = 8
        /// A chosen option's tick, before its label.
        public static let glyph: CGFloat = 16
        public static let glyphGap: CGFloat = 6
        public static let box: CGFloat = 20
        public static let boxRadius: CGFloat = 5
        public static let boxGap: CGFloat = 10
        public static let rowPaddingV: CGFloat = 8
        public static let detailGap: CGFloat = 2
        public static let labelGap: CGFloat = 6
        public static let fieldHeight: CGFloat = 44
        public static let fieldPaddingH: CGFloat = 12
        public static let treeRow: CGFloat = 24
        public static let treeIndent: CGFloat = 16
        public static let treeGlyph: CGFloat = 14
        public static let treeGlyphGap: CGFloat = 6
        public static let cardPadding: CGFloat = 12
        public static let lineGap: CGFloat = 4
        /// Controls that can't be used, or no longer.
        public static let disabledAlpha: CGFloat = 0.48
    }

    public struct ButtonInput {
        public var label: Measurable
        public var glyph: Bool

        public init(label: Measurable, glyph: Bool = false) {
            self.label = label
            self.glyph = glyph
        }
    }

    public struct RowInput {
        public var label: Measurable
        public var detail: Measurable?

        public init(label: Measurable, detail: Measurable? = nil) {
            self.label = label
            self.detail = detail
        }
    }

    public enum Input {
        case buttons([ButtonInput])
        case checklist([RowInput], submit: ButtonInput)
        /// `value` is the placeholder or what was answered, in the box.
        case field(label: Measurable, value: Measurable, submit: ButtonInput)
        case tree([(depth: Int, name: Measurable)])
        case line(Measurable)
        case card(title: Measurable, lines: [Measurable], buttons: [ButtonInput])
    }

    public struct Button: Equatable, Sendable {
        public var frame: CGRect
        public var label: CGRect
        public var glyph: CGRect?
    }

    /// A checklist option, or a file tree's entry: `mark` is its box or glyph.
    public struct Row: Equatable, Sendable {
        public var frame: CGRect
        public var mark: CGRect
        public var label: CGRect
        public var detail: CGRect?
    }

    public var size: CGSize
    /// A choice's options; a checklist's or a field's submit, last.
    public var buttons: [Button] = []
    public var rows: [Row] = []
    /// A field's label, the line, or a card's title.
    public var label: CGRect?
    /// A card's box and its lines.
    public var card: CGRect?
    public var lines: [CGRect] = []
    public var field: CGRect?
    public var value: CGRect?

    /// `width` is the column it stands in, from x 0.
    public init(width: CGFloat, input: Input) {
        typealias M = Metrics
        let width = max(0, width)
        let control = min(width, M.maxWidth)
        size = .zero
        var y: CGFloat = 0
        func button(_ input: ButtonInput, x: CGFloat = 0, width control: CGFloat = control) -> Button {
            let inner = max(0, control - 2 * M.buttonPaddingH - (input.glyph ? M.glyph + M.glyphGap : 0))
            let measured = input.label.size(fitting: inner)
            let labelWidth = measured.width.rounded(.up)
            let height = max(M.buttonHeight, measured.height.rounded(.up) + 2 * M.buttonPaddingV)
            let frame = CGRect(x: x, y: y, width: control, height: height)
            let group = labelWidth + (input.glyph ? M.glyph + M.glyphGap : 0)
            let left = x + ((control - group) / 2).rounded()
            let labelX = left + (input.glyph ? M.glyph + M.glyphGap : 0)
            let labelFrame = CGRect(x: labelX, y: y + ((height - measured.height.rounded(.up)) / 2).rounded(), width: labelWidth, height: measured.height.rounded(.up))
            let glyph = input.glyph ? CGRect(x: left, y: y + ((height - M.glyph) / 2).rounded(), width: M.glyph, height: M.glyph) : nil
            y += height
            return Button(frame: frame, label: labelFrame, glyph: glyph)
        }
        switch input {
        case .buttons(let inputs):
            for (index, one) in inputs.enumerated() {
                if index > 0 { y += M.gap }
                buttons.append(button(one))
            }
            size = CGSize(width: inputs.isEmpty ? 0 : control, height: y)
        case .checklist(let inputs, let submit):
            let textX = M.box + M.boxGap
            let textWidth = max(0, control - textX)
            for one in inputs {
                let top = y
                let labelHeight = one.label.height(fitting: textWidth).rounded(.up)
                let label = CGRect(x: textX, y: top + M.rowPaddingV, width: textWidth, height: labelHeight)
                var bottom = label.maxY
                var detail: CGRect?
                if let measured = one.detail {
                    let frame = CGRect(x: textX, y: bottom + M.detailGap, width: textWidth, height: measured.height(fitting: textWidth).rounded(.up))
                    detail = frame
                    bottom = frame.maxY
                }
                y = bottom + M.rowPaddingV
                // The box sits on the label's first line.
                let firstLine = min(labelHeight, 24)
                let mark = CGRect(x: 0, y: top + M.rowPaddingV + ((firstLine - M.box) / 2).rounded(), width: M.box, height: M.box)
                rows.append(Row(frame: CGRect(x: 0, y: top, width: control, height: y - top), mark: mark, label: label, detail: detail))
            }
            y += M.gap
            buttons.append(button(submit))
            size = CGSize(width: control, height: y)
        case .field(let labelText, let value, let submit):
            let labelHeight = labelText.height(fitting: control).rounded(.up)
            label = CGRect(x: 0, y: 0, width: control, height: labelHeight)
            y = labelHeight + M.labelGap
            let box = CGRect(x: 0, y: y, width: control, height: M.fieldHeight)
            field = box
            let valueWidth = max(0, control - 2 * M.fieldPaddingH)
            let valueHeight = min(value.height(fitting: valueWidth).rounded(.up), M.fieldHeight)
            self.value = CGRect(x: M.fieldPaddingH, y: y + ((M.fieldHeight - valueHeight) / 2).rounded(), width: valueWidth, height: valueHeight)
            y = box.maxY + M.gap
            buttons.append(button(submit))
            size = CGSize(width: control, height: y)
        case .tree(let entries):
            for entry in entries {
                let indent = CGFloat(entry.depth) * M.treeIndent
                let x = min(indent, max(0, width - M.treeGlyph))
                let mark = CGRect(x: x, y: y + (M.treeRow - M.treeGlyph) / 2, width: M.treeGlyph, height: M.treeGlyph)
                let labelX = x + M.treeGlyph + M.treeGlyphGap
                let name = entry.name.size(fitting: max(0, width - labelX))
                let label = CGRect(x: labelX, y: y + ((M.treeRow - name.height.rounded(.up)) / 2).rounded(), width: max(0, width - labelX), height: name.height.rounded(.up))
                rows.append(Row(frame: CGRect(x: 0, y: y, width: width, height: M.treeRow), mark: mark, label: label, detail: nil))
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
                buttons.append(button(one, x: M.cardPadding, width: inner))
            }
            y += M.cardPadding
            card = CGRect(x: 0, y: 0, width: control, height: y)
            size = CGSize(width: control, height: y)
        }
    }
}
