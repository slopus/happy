#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A `ChoiceList` measured off the main thread, drawn as the row's boxes, texts and
/// hits: outline buttons, the emphasized or chosen one in the accent, or checkboxes
/// and an accent submit. A chosen block is locked, the rest dimmed.
struct ChoiceListPlan {
    let block: ChoiceBlock
    let prompt: MeasuredText?
    let options: [MeasuredText]
    let submit: MeasuredText?

    init(_ block: ChoiceBlock, environment: TextEnvironment?) {
        self.block = block
        // A button's lines are centred, as its label is in it.
        func text(_ string: String, _ color: ColorToken) -> NSAttributedString { ChatTextStyles.text.string(string, color: color, alignment: block.multi ? .natural : .center, in: environment) }
        prompt = block.prompt.map { prompt in
            let all = NSMutableAttributedString(attributedString: ChatTextStyles.imageCaption.string(block.context.map { $0 + "\n" } ?? "", color: Palette.textSecondary, in: environment))
            all.append(ChatTextStyles.text.string(prompt, color: Palette.text, in: environment))
            return MeasuredText(all)
        }
        options = block.options.indices.map { index in
            let filled = !block.multi && Self.filled(block, index)
            let label = NSMutableAttributedString(attributedString: text(block.options[index].label, filled ? Palette.onAccent : Palette.text))
            if let detail = block.options[index].detail, !detail.isEmpty { label.append(text("\n" + detail, filled ? Palette.onAccent : Palette.textSecondary)) }
            return MeasuredText(label)
        }
        submit = block.multi && block.chosen == nil && block.source != .answered ? MeasuredText(text(Strings.choicesSubmit, Palette.onAccent), maxLines: 1) : nil
    }

    /// Filled: chosen, else picked, else emphasized while nothing is.
    static func filled(_ block: ChoiceBlock, _ index: Int) -> Bool {
        block.chosen?.contains(index) ?? (block.picked.contains(index) || block.picked.isEmpty && index == block.emphasized)
    }

    var input: ChoiceListLayout.Input {
        .init(prompt: prompt?.measurable, options: options.map(\.measurable), checks: block.multi, submit: submit?.measurable)
    }

    var spoken: String { ([block.prompt] + block.options.map(\.label)).compactMap { $0 }.joined(separator: ", ") }

    func draw(_ layout: ChoiceListLayout, at origin: CGPoint) -> (items: [ChatDrawItem], hits: [ChatHit]) {
        typealias M = ChoiceListLayout.Metrics
        var (items, hits): ([ChatDrawItem], [ChatHit]) = ([], [])
        func place(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: origin.x, dy: origin.y) }
        if let prompt, let frame = layout.prompt.map(place) { items.append(.text(prompt.layout(for: frame), frame)) }
        for (index, (control, text)) in zip(layout.options, options).enumerated() {
            let pressable = block.chosen == nil && block.options[index].pressable
            let alpha: CGFloat = pressable || block.chosen?.contains(index) == true ? 1 : 0.5
            let filled = Self.filled(block, index)
            if let box = control.box.map(place) {
                items.append(.box(ChatBox(frame: box, fill: filled ? Palette.taskAccent : nil, border: filled ? nil : Palette.textSecondary, borderWidth: filled ? 0 : 1.5, radius: 5, alpha: alpha)))
                if filled { items.append(.icon(.ionicons("checkmark"), size: 14, frame: box, tint: Palette.onAccent)) }
            } else {
                items.append(.box(ChatBox(frame: place(control.frame), fill: filled ? Palette.taskAccent : nil, border: filled ? nil : Palette.legacyDivider, borderWidth: filled ? 0 : 1, radius: M.radius, alpha: alpha)))
            }
            let frame = place(control.label)
            items.append(.text(alpha < 1 ? text.layout(for: frame).dimmed(alpha) : text.layout(for: frame), frame))
            if pressable { hits.append(ChatHit(frame: place(control.frame), action: .choose(block.source, option: index))) }
        }
        if let submit, let control = layout.submit {
            let ready = !block.picked.isEmpty
            items.append(.box(ChatBox(frame: place(control.frame), fill: Palette.taskAccent, radius: M.radius, alpha: ready ? 1 : 0.5)))
            items.append(.text(submit.layout(for: place(control.label)), place(control.label)))
            if ready { hits.append(ChatHit(frame: place(control.frame), action: .choose(block.source, option: nil))) }
        }
        return (items, hits)
    }
}
#endif
